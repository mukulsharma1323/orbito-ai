import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LibSQLVector } from '@mastra/libsql';
import { PrismaClient } from '@prisma/client';

const indexName = 'orbito_knowledge';
const model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const databaseUrl = process.env.MASTRA_VECTOR_URL || `file:${resolve(dirname(fileURLToPath(import.meta.url)), '../prisma/knowledge-vectors.db')}`;
let store: LibSQLVector | undefined;

function vectorStore() {
  return store ??= new LibSQLVector({ id: 'orbito-knowledge', url: databaseUrl });
}

async function embed(input: string): Promise<number[]> {
  const response = await fetch(new URL('/api/embed', baseUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Embedding model unavailable (${response.status})`);
  const result = await response.json() as { embeddings?: number[][] };
  const vector = result.embeddings?.[0];
  if (!vector?.length || !vector.every(Number.isFinite)) throw new Error('Embedding model returned no vector');
  return vector;
}

async function ensureIndex(dimension: number) {
  const vectors = vectorStore();
  if (!(await vectors.listIndexes()).includes(indexName)) await vectors.createIndex({ indexName, dimension });
  const current = await vectors.describeIndex({ indexName });
  if (current.dimension !== dimension) throw new Error(`Embedding dimension changed (${current.dimension} → ${dimension}); rebuild vector index`);
  return vectors;
}

export async function indexDocument(db: PrismaClient, companyId: string, documentId: string) {
  const chunks = await db.knowledgeChunk.findMany({ where: { companyId, documentId }, orderBy: { ordinal: 'asc' } });
  if (!chunks.length) return 0;
  const first = await embed(chunks[0].content);
  const vectors = await ensureIndex(first.length);
  const batchSize = 16;
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    const embeddings = await Promise.all(batch.map((chunk, index) => offset === 0 && index === 0 ? first : embed(chunk.content)));
    await vectors.upsert({ indexName, ids: batch.map(chunk => chunk.id), vectors: embeddings,
      metadata: batch.map(chunk => ({ companyId, projectId: chunk.projectId || '', documentId, chunkId: chunk.id, text: chunk.content })) });
  }
  return chunks.length;
}

export async function searchDocumentChunks(db: PrismaClient, companyId: string, projectId: string | null, query: string) {
  const embedding = await embed(query.slice(0, 4000));
  const vectors = await ensureIndex(embedding.length);
  const scope = projectId ? { $or: [{ projectId: '' }, { projectId }] } : { projectId: '' };
  const results = await vectors.query({ indexName, queryVector: embedding, topK: 18, filter: { $and: [{ companyId }, scope] } });
  const ids = results.map(result => result.id);
  if (!ids.length) return [];
  // Prisma authorization is repeated after vector search, so vector metadata never grants access.
  const chunks = await db.knowledgeChunk.findMany({ where: { id: { in: ids }, companyId, OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] },
    include: { document: { select: { name: true, createdAt: true } } } });
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  return ids.flatMap(id => { const chunk = byId.get(id); return chunk ? [chunk] : []; });
}

export async function removeDocumentVectors(documentId: string) {
  if (!(await vectorStore().listIndexes()).includes(indexName)) return;
  await vectorStore().deleteVectors({ indexName, filter: { documentId } });
}
