import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

type SourceType = 'document' | 'memory' | 'task' | 'run' | 'chat' | 'feedback';
type Source = { companyId: string; projectId: string | null; sourceType: SourceType; sourceId: string; sourceLabel: string; content: string };

function candidateStatements(content: string, minLength = 25): string[] {
  return [...new Set(content.split(/\n+|(?<=[.!?।])\s+/u)
    .map(value => value.replace(/^[-*#\d.\s]+/, '').replace(/\s+/g, ' ').trim())
    .filter(value => value.length >= minLength && value.length <= 500 && !/^https?:\/\//i.test(value)))]
    .slice(0, 12);
}

async function modelStatements(content: string): Promise<string[] | null> {
  const model = process.env.OLLAMA_LEARNING_MODEL;
  if (!model) return null;
  const response = await fetch(new URL('/api/generate', process.env.OLLAMA_URL || 'http://127.0.0.1:11434'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model, stream: false, format: 'json', prompt:
      'Extract at most 8 durable, verifiable company or project facts, decisions, constraints or preferences from the source. Do not infer facts not present. Return JSON only: {"points":["..."]}. Source:\n' + content.slice(0, 12000) })
  });
  if (!response.ok) throw new Error('Learning model unavailable');
  const result = await response.json() as { response?: string };
  const parsed = JSON.parse(result.response || '{}') as { points?: unknown };
  return Array.isArray(parsed.points) ? parsed.points.filter((x): x is string => typeof x === 'string' && x.length >= 15 && x.length <= 500).slice(0, 8) : [];
}

export async function proposeLearnings(db: PrismaClient, source: Source, alreadyProposed = new Set<string>()) {
  let statements: string[];
  let extractor = 'sentence-candidates-v1';
  const fallback = () => candidateStatements(source.content, source.sourceType === 'feedback' ? 15 : 25);
  try {
    const extracted = await modelStatements(source.content);
    if (extracted === null) statements = fallback();
    else { statements = extracted; extractor = `ollama:${process.env.OLLAMA_LEARNING_MODEL}`; }
  }
  catch { statements = fallback(); }
  for (const statement of statements) {
    if (alreadyProposed.has(statement)) continue;
    await db.learningPoint.upsert({ where: { companyId_sourceType_sourceId_statement: { companyId: source.companyId, sourceType: source.sourceType, sourceId: source.sourceId, statement } },
      update: {}, create: { companyId: source.companyId, projectId: source.projectId, sourceType: source.sourceType, sourceId: source.sourceId,
        sourceLabel: source.sourceLabel, statement, sourceExcerpt: source.content.slice(0, 1500), revisions: { create: { version: 1, statement, status: 'PENDING' } } } });
  }
  return { count: statements.length, extractor };
}

function sourceFingerprint(source: Source) {
  return createHash('sha256').update(`${source.projectId || ''}\0${source.content}`).digest('hex');
}

export async function recordKnowledgeSourceSync(db: PrismaClient, source: Source, result: { count: number; extractor: string }) {
  const key = { companyId: source.companyId, sourceType: source.sourceType, sourceId: source.sourceId };
  const data = { fingerprint: sourceFingerprint(source), extractor: result.extractor, pointCount: result.count, syncedAt: new Date() };
  await db.learningSourceSync.upsert({ where: { companyId_sourceType_sourceId: key }, update: data, create: { ...key, ...data } });
}

export async function syncKnowledgeBase(db: PrismaClient, companyId: string) {
  const [documents, notes] = await Promise.all([
    db.knowledgeDocument.findMany({ where: { companyId }, select: { id: true, projectId: true, name: true, extractedText: true } }),
    db.memoryEntry.findMany({ where: { companyId }, select: { id: true, projectId: true, title: true, content: true } })
  ]);
  const sources: Source[] = [
    ...documents.map(item => ({ companyId, projectId: item.projectId, sourceType: 'document' as const, sourceId: item.id, sourceLabel: `Document: ${item.name}`, content: item.extractedText })),
    ...notes.map(item => ({ companyId, projectId: item.projectId, sourceType: 'memory' as const, sourceId: item.id, sourceLabel: `Knowledge: ${item.title}`, content: item.content }))
  ];
  const desiredExtractor = process.env.OLLAMA_LEARNING_MODEL ? `ollama:${process.env.OLLAMA_LEARNING_MODEL}` : 'sentence-candidates-v1';
  let synced = 0;
  let skipped = 0;
  let created = 0;
  let needsReview = 0;
  for (const source of sources) {
    const fingerprint = sourceFingerprint(source);
    const key = { companyId, sourceType: source.sourceType, sourceId: source.sourceId };
    const previous = await db.learningSourceSync.findUnique({ where: { companyId_sourceType_sourceId: key } });
    if (previous?.fingerprint === fingerprint && previous.extractor === desiredExtractor) { skipped++; continue; }
    const oldPoints = await db.learningPoint.findMany({ where: key, include: { revisions: { where: { version: 1 }, select: { statement: true } } } });
    const originalStatements = new Set(oldPoints.map(point => point.revisions[0]?.statement || point.statement));
    if (previous && previous.fingerprint !== fingerprint) {
      for (const point of oldPoints.filter(item => item.status === 'APPROVED' || item.status === 'PENDING')) {
        const note = 'Knowledge source changed; review this point again.';
        await db.$transaction(async tx => {
          await tx.learningPoint.update({ where: { id: point.id }, data: { status: 'NEEDS_EDIT', reviewNote: note, reviewedAt: null, reviewedById: null, version: { increment: 1 } } });
          await tx.learningRevision.create({ data: { learningId: point.id, version: point.version + 1, statement: point.statement, status: 'NEEDS_EDIT', reviewNote: note } });
        });
        needsReview++;
      }
    }
    const before = oldPoints.length;
    const result = await proposeLearnings(db, source, originalStatements);
    const after = await db.learningPoint.count({ where: key });
    created += after - before;
    await recordKnowledgeSourceSync(db, source, result);
    synced++;
  }
  return { totalSources: sources.length, synced, skipped, created, needsReview };
}

export async function reviewedLearnings(db: PrismaClient, companyId: string, projectId: string | null, query: string) {
  const words = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).slice(0, 80));
  const points = await db.learningPoint.findMany({ where: { companyId, status: 'APPROVED', OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] }, orderBy: { updatedAt: 'desc' } });
  return points.map(point => ({ point, score: [...words].reduce((score, word) => score + (point.statement.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || b.point.updatedAt.getTime() - a.point.updatedAt.getTime()).slice(0, 8)
    .map(({ point }) => ({ kind: 'approved-learning', title: `${point.sourceLabel} · reviewed v${point.version}`, content: point.statement, version: point.version }));
}
