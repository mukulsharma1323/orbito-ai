import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { chunkDocument, extractDocument, relevantKnowledge } from '../src/knowledge.js';

test('plain text ingestion rejects unreadable content and keeps paragraphs in chunks', async () => {
  assert.equal(await extractDocument('guide.md', Buffer.from('First paragraph.\n\nSecond paragraph.'), 'text/markdown'), 'First paragraph.\n\nSecond paragraph.');
  assert.deepEqual(chunkDocument('First paragraph.\n\nSecond paragraph.', 20), ['First paragraph.', 'Second paragraph.']);
  await assert.rejects(extractDocument('empty.txt', Buffer.from('  '), 'text/plain'), /No readable text/);
  await assert.rejects(extractDocument('bad.txt', Buffer.from([0xff]), 'text/plain'));
});

test('Docling conversion extracts Markdown from a PDF response', async () => {
  const original = globalThis.fetch;
  const previousUrl = process.env.DOCLING_URL;
  process.env.DOCLING_URL = 'http://docling.test:5001';
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url), 'http://docling.test:5001/v1/convert/file');
    const body = options?.body as FormData;
    assert.equal(body.get('to_formats'), 'md');
    assert.equal(body.get('do_ocr'), 'true');
    assert.equal((body.get('files') as File).name, 'brief.pdf');
    return new Response(JSON.stringify({ status: 'success', document: { md_content: '# Brief\n\nCheckout rules' } }), { status: 200 });
  }) as typeof fetch;
  try { assert.equal(await extractDocument('brief.pdf', Buffer.from('%PDF'), 'application/pdf'), '# Brief\n\nCheckout rules'); }
  finally { globalThis.fetch = original; if (previousUrl === undefined) delete process.env.DOCLING_URL; else process.env.DOCLING_URL = previousUrl; }
});

test('agent memory query uses company plus project scope and ranks a matching document', async () => {
  const observed: unknown[] = [];
  const db = {
    memoryEntry: { findMany: async (query: unknown) => { observed.push(query); return [{ kind: 'policy', title: 'General', content: 'Use approved workflows', version: 1, updatedAt: new Date('2026-01-01') }]; } },
    knowledgeChunk: { findMany: async (query: unknown) => { observed.push(query); return [{ content: 'Checkout payments require verification before release.', ordinal: 0, document: { name: 'payments.md', createdAt: new Date('2026-01-02') } }]; } },
    learningPoint: { findMany: async () => [] }
  } as unknown as PrismaClient;
  const selected = await relevantKnowledge(db, 'company-1', 'project-1', 'Checkout verification', 'Check payment flow');
  assert.equal(selected[0].kind, 'document');
  assert.match(selected[0].content, /payments require verification/);
  assert.deepEqual((observed[0] as { where: unknown }).where, { companyId: 'company-1', OR: [{ projectId: null }, { projectId: 'project-1' }] });
  assert.deepEqual((observed[1] as { where: unknown }).where, { companyId: 'company-1', OR: [{ projectId: null }, { projectId: 'project-1' }] });
});
