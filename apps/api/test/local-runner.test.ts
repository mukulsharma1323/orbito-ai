import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { encryptSecret } from '../src/security.js';
import { runnerCompany } from '../src/local-runner-service.js';

test('runner token is bound to one configured company and rejects wrong credentials', async () => {
  process.env.ENCRYPTION_KEY = '1'.repeat(64);
  const secret = 'a'.repeat(64);
  const provider = { id: 'runner123', companyId: 'companyA', kind: 'codex-local', status: 'runner-configured', encryptedSecret: encryptSecret(secret) };
  const db = { providerConnection: { findUnique: async () => provider } } as unknown as PrismaClient;
  assert.equal(await runnerCompany(db, `Bearer ${provider.id}.${secret}`), 'companyA');
  assert.equal(await runnerCompany(db, `Bearer ${provider.id}.${'b'.repeat(64)}`), null);
  assert.equal(await runnerCompany(db, undefined), null);
  provider.status = 'disabled';
  assert.equal(await runnerCompany(db, `Bearer ${provider.id}.${secret}`), null);
});
