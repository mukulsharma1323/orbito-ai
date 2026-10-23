import { PrismaClient } from '@prisma/client';

type SourceType = 'document' | 'task' | 'run' | 'chat' | 'feedback';
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

export async function proposeLearnings(db: PrismaClient, source: Source) {
  let statements: string[];
  const fallback = () => candidateStatements(source.content, source.sourceType === 'feedback' ? 15 : 25);
  try { statements = await modelStatements(source.content) ?? fallback(); }
  catch { statements = fallback(); }
  for (const statement of statements) {
    await db.learningPoint.upsert({ where: { companyId_sourceType_sourceId_statement: { companyId: source.companyId, sourceType: source.sourceType, sourceId: source.sourceId, statement } },
      update: {}, create: { companyId: source.companyId, projectId: source.projectId, sourceType: source.sourceType, sourceId: source.sourceId,
        sourceLabel: source.sourceLabel, statement, sourceExcerpt: source.content.slice(0, 1500), revisions: { create: { version: 1, statement, status: 'PENDING' } } } });
  }
  return statements.length;
}

export async function reviewedLearnings(db: PrismaClient, companyId: string, projectId: string | null, query: string) {
  const words = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).slice(0, 80));
  const points = await db.learningPoint.findMany({ where: { companyId, status: 'APPROVED', OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] }, orderBy: { updatedAt: 'desc' } });
  return points.map(point => ({ point, score: [...words].reduce((score, word) => score + (point.statement.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || b.point.updatedAt.getTime() - a.point.updatedAt.getTime()).slice(0, 8)
    .map(({ point }) => ({ kind: 'approved-learning', title: `${point.sourceLabel} · reviewed v${point.version}`, content: point.statement, version: point.version }));
}
