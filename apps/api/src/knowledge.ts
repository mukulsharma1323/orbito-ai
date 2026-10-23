import { PrismaClient } from '@prisma/client';
import { searchDocumentChunks } from './vector-memory.js';
import { reviewedLearnings } from './learning.js';

const MAX_EXTRACTED_CHARS = 1_000_000;
const textExtensions = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'log']);
const doclingExtensions = new Set(['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'rtf', 'odt', 'ods', 'odp', 'epub', 'eml']);

export function supportedExtension(name: string) {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return textExtensions.has(extension) || doclingExtensions.has(extension) ? extension : null;
}

export async function extractDocument(name: string, bytes: Buffer, mimeType: string): Promise<string> {
  const extension = supportedExtension(name);
  if (!extension) throw new Error('Unsupported file type. Upload text, Markdown, PDF, Office documents, HTML or an image.');
  if (textExtensions.has(extension)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return normalizeExtracted(text);
  }
  const base = process.env.DOCLING_URL || 'http://127.0.0.1:5001';
  const body = new FormData();
  body.append('files', new Blob([new Uint8Array(bytes)], { type: mimeType || 'application/octet-stream' }), name);
  body.append('to_formats', 'md');
  body.append('do_ocr', 'true');
  body.append('image_export_mode', 'placeholder');
  let response: globalThis.Response;
  try {
    const endpoint = new URL('/v1/convert/file', base);
    if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    response = await fetch(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(300_000) });
  } catch {
    throw new Error('Document parser is not ready. Start npm run dev, wait for the parser on port 5001, and retry.');
  }
  if (!response.ok) throw new Error(`Document parsing failed (${response.status}). Check that the file is valid and supported by Docling.`);
  const result = await response.json() as { document?: { md_content?: string }; status?: string };
  if (result.status && result.status !== 'success' && result.status !== 'partial_success') throw new Error('Document parser could not read this file.');
  return normalizeExtracted(result.document?.md_content ?? '');
}

function normalizeExtracted(value: string) {
  const text = value.replace(/\u0000/g, '').trim();
  if (!text) throw new Error('No readable text was found in this file.');
  if (text.length > MAX_EXTRACTED_CHARS) throw new Error('Extracted text is too large (maximum 1 million characters).');
  return text;
}

export function chunkDocument(text: string, limit = 1800): string[] {
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current) chunks.push(current); current = ''; };
  for (const paragraph of paragraphs) {
    for (let offset = 0; offset < paragraph.length; offset += limit) {
      const part = paragraph.slice(offset, offset + limit);
      if (current && current.length + part.length + 2 > limit) flush();
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  flush();
  return chunks;
}

function terms(value: string) {
  return [...new Set((value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'will', 'have', 'into', 'your', 'project'].includes(term)))];
}

export async function relevantKnowledge(db: PrismaClient, companyId: string, projectId: string | null, title: string, spec: string) {
  const scope = { companyId, OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] };
  const [memories, chunks, approved] = await Promise.all([
    db.memoryEntry.findMany({ where: scope, select: { kind: true, title: true, content: true, version: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 150 }),
    db.knowledgeChunk.findMany({ where: scope, select: { content: true, ordinal: true, document: { select: { name: true, createdAt: true } } }, orderBy: { document: { createdAt: 'desc' } }, take: 3000 }),
    reviewedLearnings(db, companyId, projectId, `${title} ${spec}`)
  ]);
  let semantic: Awaited<ReturnType<typeof searchDocumentChunks>> = [];
  try { semantic = await searchDocumentChunks(db, companyId, projectId, `${title}\n${spec}`); }
  catch { /* Keyword search keeps no-key demos and installations without Ollama usable. */ }
  const queryTerms = terms(`${title} ${spec}`).slice(0, 80);
  const items = [
    ...memories.map(item => ({ kind: item.kind, title: item.title, content: item.content, version: item.version, date: item.updatedAt })),
    ...semantic.map(item => ({ kind: 'document', title: `${item.document.name} · part ${item.ordinal + 1}`, content: item.content, version: 1, date: item.document.createdAt })),
    ...chunks.map(item => ({ kind: 'document', title: `${item.document.name} · part ${item.ordinal + 1}`, content: item.content, version: 1, date: item.document.createdAt }))
  ];
  const scored = items.map((item, index) => {
    const heading = item.title.toLowerCase();
    const body = item.content.toLowerCase();
    const score = queryTerms.reduce((sum, term) => sum + (heading.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
    return { item, score: score + (index >= memories.length && index < memories.length + semantic.length ? 8 : 0), index };
  }).sort((a, b) => b.score - a.score || b.item.date.getTime() - a.item.date.getTime());
  const selected: { kind: string; title: string; content: string; version: number }[] = [];
  const seen = new Set<string>();
  let remaining = 15_000;
  for (const { item } of scored) {
    if (selected.length >= 12 || remaining < 100) break;
    const key = `${item.kind}:${item.title}:${item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const content = item.content.slice(0, Math.min(remaining, 3000));
    selected.push({ kind: item.kind, title: item.title, content, version: item.version });
    remaining -= content.length;
  }
  return [...approved, ...selected].slice(0, 16);
}
