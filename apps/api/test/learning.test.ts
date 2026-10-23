import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { proposeLearnings, reviewedLearnings } from '../src/learning.js';

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
  assert.equal(count, 1);
  assert.deepEqual((writes[0] as { create: { companyId: string; projectId: string; sourceId: string; revisions: { create: { status: string } } } }).create,
    { companyId: 'company-a', projectId: 'project-a', sourceType: 'document', sourceId: 'doc-a', sourceLabel: 'Document: checkout.md', statement: 'Checkout payments require verification before release.', sourceExcerpt: 'Checkout payments require verification before release.', revisions: { create: { version: 1, statement: 'Checkout payments require verification before release.', status: 'PENDING' } } });
  const selected = await reviewedLearnings(db, 'company-a', 'project-a', 'checkout verification');
  assert.equal(selected[0].kind, 'approved-learning');
});
