import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { proposeLearnings, reviewedLearnings, syncKnowledgeBase } from '../src/learning.js';

test('learning candidates keep source and tenant scope, while only approved points reach the agent', async () => {
  const writes: unknown[] = [];
  const db = {
    learningPoint: {
      upsert: async (data: unknown) => { writes.push(data); },
      findMany: async ({ where }: { where: { companyId: string; status: string; OR: unknown[] } }) => {
        assert.equal(where.companyId, 'company-a');
        assert.equal(where.status, 'APPROVED');
        assert.deepEqual(where.OR, [{ projectId: null }, { projectId: 'project-a' }]);
        return [{ statement: 'Checkout payments require verification before release.', sourceLabel: 'Document: checkout.md', version: 2, updatedAt: new Date() }];
      }
    }
  } as unknown as PrismaClient;
  const count = await proposeLearnings(db, { companyId: 'company-a', projectId: 'project-a', sourceType: 'document', sourceId: 'doc-a', sourceLabel: 'Document: checkout.md', content: 'Checkout payments require verification before release.' });
  assert.deepEqual(count, { count: 1, extractor: 'sentence-candidates-v1' });
  assert.deepEqual((writes[0] as { create: { companyId: string; projectId: string; sourceId: string; revisions: { create: { status: string } } } }).create,
    { companyId: 'company-a', projectId: 'project-a', sourceType: 'document', sourceId: 'doc-a', sourceLabel: 'Document: checkout.md', statement: 'Checkout payments require verification before release.', sourceExcerpt: 'Checkout payments require verification before release.', revisions: { create: { version: 1, statement: 'Checkout payments require verification before release.', status: 'PENDING' } } });
  const selected = await reviewedLearnings(db, 'company-a', 'project-a', 'checkout verification');
  assert.equal(selected[0].kind, 'approved-learning');
});

test('knowledge sync skips unchanged notes and reopens approved points after a source edit', async () => {
  const note = { id: 'note-a', projectId: 'project-a', title: 'Checkout policy', content: 'Checkout payments require verification before release.' };
  const points: Array<{ id: string; companyId: string; sourceType: string; sourceId: string; statement: string; status: string; version: number; revisions: Array<{ statement: string }> }> = [];
  const syncs = new Map<string, { fingerprint: string; extractor: string }>();
  const key = (sourceType: string, sourceId: string) => `${sourceType}:${sourceId}`;
  const db = {
    knowledgeDocument: { findMany: async () => [] },
    memoryEntry: { findMany: async () => [note] },
    learningSourceSync: {
      findUnique: async ({ where }: { where: { companyId_sourceType_sourceId: { sourceType: string; sourceId: string } } }) => syncs.get(key(where.companyId_sourceType_sourceId.sourceType, where.companyId_sourceType_sourceId.sourceId)) || null,
      upsert: async ({ create, update }: { create: { sourceType: string; sourceId: string; fingerprint: string; extractor: string }; update: { fingerprint: string; extractor: string } }) => { syncs.set(key(create.sourceType, create.sourceId), { fingerprint: update.fingerprint, extractor: update.extractor }); }
    },
    learningPoint: {
      findMany: async ({ where }: { where: { companyId: string; sourceType: string; sourceId: string } }) => points.filter(point => point.companyId === where.companyId && point.sourceType === where.sourceType && point.sourceId === where.sourceId),
      count: async ({ where }: { where: { sourceType: string; sourceId: string } }) => points.filter(point => point.sourceType === where.sourceType && point.sourceId === where.sourceId).length,
      upsert: async ({ create }: { create: { companyId: string; sourceType: string; sourceId: string; statement: string } }) => {
        if (!points.some(point => point.sourceId === create.sourceId && point.statement === create.statement)) points.push({ id: `point-${points.length}`, ...create, status: 'PENDING', version: 1, revisions: [{ statement: create.statement }] });
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string; version: { increment: number } } }) => {
        const point = points.find(item => item.id === where.id)!; point.status = data.status; point.version += data.version.increment;
      }
    },
    learningRevision: { create: async ({ data }: { data: { learningId: string; statement: string } }) => { points.find(point => point.id === data.learningId)!.revisions.push({ statement: data.statement }); } },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db)
  } as unknown as PrismaClient;
  const first = await syncKnowledgeBase(db, 'company-a');
  assert.deepEqual({ synced: first.synced, created: first.created }, { synced: 1, created: 1 });
  points[0].status = 'APPROVED';
  const second = await syncKnowledgeBase(db, 'company-a');
  assert.deepEqual({ synced: second.synced, skipped: second.skipped, created: second.created }, { synced: 0, skipped: 1, created: 0 });
  note.content += '\nA reviewer must approve exceptions to this rule.';
  const third = await syncKnowledgeBase(db, 'company-a');
  assert.deepEqual({ synced: third.synced, created: third.created, needsReview: third.needsReview }, { synced: 1, created: 1, needsReview: 1 });
  assert.equal(points[0].status, 'NEEDS_EDIT');
  assert.equal(points[0].version, 2);
  assert.equal(points[1].status, 'PENDING');
});
