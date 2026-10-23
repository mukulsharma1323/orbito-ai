import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import multer from 'multer';
import { PrismaClient, Role } from '@prisma/client';
import { z } from 'zod';
import { encryptSecret, signSession, verifySession } from './security.js';
import { startRun } from './orchestration.js';
import { claimLocalRun, completeLocalRun, failLocalRun, runnerCompany } from './local-runner-service.js';
import { chunkDocument, extractDocument, supportedExtension } from './knowledge.js';
import { proposeLearnings } from './learning.js';
import { indexDocument, removeDocumentVectors } from './vector-memory.js';

const db = new PrismaClient();
if (process.env.DEMO_MODE !== 'true') {
  const weakJwt = !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.includes('replace') || process.env.JWT_SECRET.includes('change-me');
  const weakKey = !process.env.ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY) || /^0+$/.test(process.env.ENCRYPTION_KEY);
  if (weakJwt || weakKey || !process.env.BOOTSTRAP_TOKEN || process.env.BOOTSTRAP_TOKEN.includes('replace')) throw new Error('Production requires strong JWT_SECRET, ENCRYPTION_KEY and BOOTSTRAP_TOKEN');
}
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN?.split(',') ?? 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '256kb' }));

type AuthRequest = Request & { userId?: string; companyId?: string; role?: Role };
const asyncRoute = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) => (req: AuthRequest, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
function auth(req: AuthRequest, res: Response, next: NextFunction) {
  try { req.userId = verifySession((req.headers.authorization ?? '').replace(/^Bearer /, '')); next(); }
  catch { res.status(401).json({ error: 'Authentication required' }); }
}
function scoped(req: AuthRequest, res: Response, next: NextFunction) {
  const companyId = String(req.headers['x-company-id'] ?? '');
  db.membership.findUnique({ where: { userId_companyId: { userId: req.userId!, companyId } } })
    .then(membership => {
      if (!membership) return res.status(403).json({ error: 'Company access denied' });
      req.companyId = companyId; req.role = membership.role; next();
    }).catch(next);
}
function canWrite(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.role === 'VIEWER') return res.status(403).json({ error: 'Read-only membership' });
  next();
}
function canAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!['OWNER', 'ADMIN'].includes(req.role ?? '')) return res.status(403).json({ error: 'Admin role required' });
  next();
}
const slug = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const departmentKeys = ['hr', 'marketing', 'sales', 'engineering', 'product', 'design', 'finance', 'operations', 'customer-support', 'legal-compliance', 'it-security', 'business-development'] as const;
const audit = (req: AuthRequest, action: string, entityType: string, entityId: string, detail?: object) => db.auditLog.create({ data: { companyId: req.companyId!, actorId: req.userId!, action, entityType, entityId, detail } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 2 } });

app.get('/health', (_req, res) => res.json({ status: 'ok', mode: process.env.DEMO_MODE === 'true' ? 'demo' : 'production' }));
app.post('/auth/bootstrap', asyncRoute(async (req, res) => {
  if (await db.user.count()) return res.status(409).json({ error: 'Already initialized' });
  if (!process.env.BOOTSTRAP_TOKEN || req.headers['x-bootstrap-token'] !== process.env.BOOTSTRAP_TOKEN) return res.status(403).json({ error: 'Bootstrap token required' });
  const input = z.object({ email: z.string().email(), name: z.string().min(1), password: z.string().min(12), companyName: z.string().min(2) }).parse(req.body);
  const user = await db.user.create({ data: { email: input.email.toLowerCase(), name: input.name, passwordHash: await bcrypt.hash(input.password, 12) } });
  const company = await db.company.create({ data: { name: input.companyName, slug: `${slug(input.companyName)}-${user.id.slice(-6)}`, memberships: { create: { userId: user.id, role: 'OWNER' } } } });
  res.status(201).json({ token: signSession(user.id), user: { id: user.id, email: user.email, name: user.name }, company });
}));
app.post('/auth/login', asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
  const user = await db.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signSession(user.id), user: { id: user.id, email: user.email, name: user.name } });
}));
app.post('/auth/demo', asyncRoute(async (_req, res) => {
  if (process.env.DEMO_MODE !== 'true') return res.status(404).json({ error: 'Not found' });
  const user = await db.user.findUniqueOrThrow({ where: { email: 'demo@orbito.local' } });
  res.json({ token: signSession(user.id), user: { id: user.id, email: user.email, name: user.name } });
}));
app.get('/me', auth, asyncRoute(async (req, res) => {
  const user = await db.user.findUniqueOrThrow({ where: { id: req.userId }, select: { id: true, email: true, name: true, memberships: { include: { company: true } } } });
  res.json(user);
}));
app.post('/companies', auth, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().min(2), description: z.string().max(500).optional() }).parse(req.body);
  const company = await db.company.create({ data: { ...input, slug: `${slug(input.name)}-${crypto.randomUUID().slice(0, 6)}`, memberships: { create: { userId: req.userId!, role: 'OWNER' } } } });
  res.status(201).json(company);
}));

// The Mac runner has its own company-scoped token; it never receives a user's web session or Codex login files.
app.use('/runner', (req: AuthRequest, res, next) => {
  runnerCompany(db, req.headers.authorization).then(companyId => {
    if (!companyId) return res.status(401).json({ error: 'Runner authorization required' });
    req.companyId = companyId; next();
  }).catch(next);
});
app.post('/runner/claim', asyncRoute(async (req, res) => {
  const job = await claimLocalRun(db, req.companyId!);
  if (!job) return res.status(204).end();
  res.json(job);
}));
app.post('/runner/runs/:id/complete', asyncRoute(async (req, res) => {
  const output = z.object({ plan: z.array(z.string().min(1).max(2000)).min(1).max(12), logs: z.array(z.string().max(4000)).max(10) }).parse(req.body);
  if (!(await completeLocalRun(db, req.companyId!, req.params.id, output))) return res.status(409).json({ error: 'Run is no longer active' });
  res.json({ ok: true });
}));
app.post('/runner/runs/:id/fail', asyncRoute(async (req, res) => {
  const { reason } = z.object({ reason: z.enum(['Local Codex sign-in unavailable', 'Codex planning timed out', 'Local Codex execution failed']) }).parse(req.body);
  if (!(await failLocalRun(db, req.companyId!, req.params.id, reason))) return res.status(409).json({ error: 'Run is no longer active' });
  res.json({ ok: true });
}));

app.use('/api', auth, scoped);
app.get('/api/overview', asyncRoute(async (req, res) => {
  const companyId = req.companyId!;
  const [company, projects, tasks, runs, approvals, memories, documents, providers, auditLogs, learnings] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId } }),
    db.project.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    db.task.findMany({ where: { companyId }, include: { project: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
    db.agentRun.findMany({ where: { companyId }, include: { task: { select: { title: true } } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    db.approval.findMany({ where: { companyId }, include: { run: { include: { task: { select: { title: true } } } } }, orderBy: { createdAt: 'desc' } }),
    db.memoryEntry.findMany({ where: { companyId }, include: { project: { select: { name: true } } }, orderBy: { updatedAt: 'desc' } }),
    db.knowledgeDocument.findMany({ where: { companyId }, select: { id: true, name: true, mimeType: true, size: true, chunkCount: true, projectId: true, project: { select: { name: true } }, createdAt: true, preview: true }, orderBy: { createdAt: 'desc' } }),
    db.providerConnection.findMany({ where: { companyId }, select: { id: true, kind: true, label: true, status: true, createdAt: true } }),
    db.auditLog.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    db.learningPoint.findMany({ where: { companyId }, include: { project: { select: { name: true } } }, orderBy: { createdAt: 'desc' } })
  ]);
  res.json({ company, projects, tasks, runs, approvals, memories, documents, providers, auditLogs, learnings });
}));
app.patch('/api/company/departments', canAdmin, asyncRoute(async (req, res) => {
  const { departments } = z.object({ departments: z.array(z.enum(departmentKeys)).min(1).max(departmentKeys.length).refine(values => new Set(values).size === values.length, 'Duplicate departments are not allowed') }).parse(req.body);
  const company = await db.company.update({ where: { id: req.companyId! }, data: { departments, onboardingCompletedAt: new Date() }, select: { id: true, departments: true, onboardingCompletedAt: true } });
  await audit(req, 'company.departments.updated', 'Company', company.id, { departments });
  res.json(company);
}));
app.post('/api/projects', canWrite, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().min(2), description: z.string().max(1000).optional(), repositoryUrl: z.string().url().regex(/^https:\/\/github\.com\//).optional(), defaultBranch: z.string().min(1).optional(), agentsMd: z.string().max(30000).optional() }).parse(req.body);
  const project = await db.project.create({ data: { ...input, slug: `${slug(input.name)}-${crypto.randomUUID().slice(0, 4)}`, companyId: req.companyId! } });
  await audit(req, 'project.created', 'Project', project.id);
  res.status(201).json(project);
}));
app.patch('/api/projects/:id', canWrite, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().min(2).optional(), description: z.string().max(1000).nullable().optional(), repositoryUrl: z.string().url().regex(/^https:\/\/github\.com\//).nullable().optional(), defaultBranch: z.string().min(1).optional(), agentsMd: z.string().max(30000).optional() }).parse(req.body);
  const match = await db.project.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!match) return res.status(404).json({ error: 'Project not found' });
  const project = await db.project.update({ where: { id: match.id }, data: input });
  await audit(req, 'project.updated', 'Project', project.id);
  res.json(project);
}));
app.post('/api/providers', canAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ kind: z.enum(['mock', 'claude', 'openai', 'codex-cli', 'codex-local']), label: z.string().min(2), secret: z.string().min(8).optional() }).parse(req.body);
  if (!['mock', 'codex-local'].includes(input.kind) && !input.secret) return res.status(400).json({ error: 'Credential required' });
  const runnerSecret = input.kind === 'codex-local' ? crypto.randomBytes(32).toString('hex') : null;
  const provider = await db.providerConnection.create({ data: { companyId: req.companyId!, kind: input.kind, label: input.label, encryptedSecret: runnerSecret ? encryptSecret(runnerSecret) : input.secret ? encryptSecret(input.secret) : null, status: input.kind === 'mock' ? 'ready' : input.kind === 'codex-local' ? 'runner-configured' : 'stored-not-validated' }, select: { id: true, kind: true, label: true, status: true } });
  await audit(req, 'provider.created', 'ProviderConnection', provider.id, { kind: provider.kind });
  res.status(201).json({ ...provider, ...(runnerSecret ? { runnerToken: `${provider.id}.${runnerSecret}` } : {}) });
}));
app.delete('/api/providers/:id', canAdmin, asyncRoute(async (req, res) => {
  const provider = await db.providerConnection.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  await db.providerConnection.delete({ where: { id: provider.id } });
  await audit(req, 'provider.deleted', 'ProviderConnection', provider.id, { kind: provider.kind });
  res.status(204).end();
}));
app.post('/api/tasks', canWrite, asyncRoute(async (req, res) => {
  const input = z.object({ title: z.string().min(3), spec: z.string().min(10), projectId: z.string().nullable().optional(), departmentId: z.enum(departmentKeys).nullable().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), providerKind: z.enum(['mock', 'claude', 'openai', 'codex-cli', 'codex-local']).default('mock'), budgetUsd: z.number().min(0).max(10000).default(5) }).parse(req.body);
  if (input.projectId && !(await db.project.findFirst({ where: { id: input.projectId, companyId: req.companyId } }))) return res.status(400).json({ error: 'Project not in company' });
  if (input.departmentId) {
    const company = await db.company.findUniqueOrThrow({ where: { id: req.companyId! }, select: { departments: true } });
    if (!Array.isArray(company.departments) || !company.departments.includes(input.departmentId)) return res.status(400).json({ error: 'Department not in company' });
  }
  const task = await db.task.create({ data: { ...input, companyId: req.companyId! } });
  await proposeLearnings(db, { companyId: req.companyId!, projectId: task.projectId, sourceType: 'task', sourceId: task.id, sourceLabel: `Task: ${task.title}`, content: task.spec });
  await audit(req, 'task.created', 'Task', task.id);
  res.status(201).json(task);
}));
app.patch('/api/tasks/:id/status', canWrite, asyncRoute(async (req, res) => {
  const { status } = z.object({ status: z.enum(['BACKLOG', 'READY', 'RUNNING', 'REVIEW', 'DONE', 'BLOCKED']) }).parse(req.body);
  const task = await db.task.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === status) return res.json(task);
  const activeRun = await db.agentRun.count({ where: { companyId: req.companyId!, taskId: task.id, status: { in: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] } } });
  if (activeRun) return res.status(409).json({ error: 'Task has an active run or pending approval' });
  const updated = await db.task.update({ where: { id: task.id }, data: { status } });
  await audit(req, 'task.status.updated', 'Task', task.id, { from: task.status, to: status });
  res.json(updated);
}));
app.post('/api/tasks/:id/runs', canWrite, asyncRoute(async (req, res) => {
  const selected = await db.task.findFirst({ where: { id: req.params.id, companyId: req.companyId }, select: { providerKind: true } });
  if (selected?.providerKind === 'codex-local' && !['OWNER', 'ADMIN'].includes(req.role ?? '')) return res.status(403).json({ error: 'Admin role required for local ChatGPT runs' });
  const run = await startRun(db, req.companyId!, req.params.id, req.userId!);
  res.status(202).json(run);
}));
app.get('/api/runs/:id', asyncRoute(async (req, res) => {
  const run = await db.agentRun.findFirst({ where: { id: req.params.id, companyId: req.companyId }, include: { task: true, approval: true } });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
}));
app.post('/api/memories', canWrite, asyncRoute(async (req, res) => {
  const input = z.object({ projectId: z.string().nullable().optional(), kind: z.enum(['decision', 'policy', 'note', 'agents-md']), title: z.string().min(2), content: z.string().min(3).max(50000) }).parse(req.body);
  if (input.projectId && !(await db.project.findFirst({ where: { id: input.projectId, companyId: req.companyId } }))) return res.status(400).json({ error: 'Project not in company' });
  const memory = await db.memoryEntry.create({ data: { ...input, companyId: req.companyId!, authorId: req.userId!, revisions: { create: { version: 1, content: input.content, authorId: req.userId! } } } });
  await audit(req, 'memory.created', 'MemoryEntry', memory.id);
  res.status(201).json(memory);
}));
app.patch('/api/memories/:id', canWrite, asyncRoute(async (req, res) => {
  const input = z.object({ title: z.string().min(2).optional(), content: z.string().min(3).max(50000) }).parse(req.body);
  const old = await db.memoryEntry.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!old) return res.status(404).json({ error: 'Memory not found' });
  const memory = await db.memoryEntry.update({ where: { id: old.id }, data: { title: input.title, content: input.content, version: { increment: 1 }, revisions: { create: { version: old.version + 1, content: input.content, authorId: req.userId! } } } });
  await audit(req, 'memory.updated', 'MemoryEntry', memory.id, { version: memory.version });
  res.json(memory);
}));
app.get('/api/memories/:id/revisions', asyncRoute(async (req, res) => {
  const memory = await db.memoryEntry.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!memory) return res.status(404).json({ error: 'Memory not found' });
  res.json(await db.memoryRevision.findMany({ where: { memoryId: memory.id }, orderBy: { version: 'desc' } }));
}));
app.post('/api/documents', canWrite, upload.single('file'), asyncRoute(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Choose a file to upload' });
  const name = file.originalname.normalize('NFC').replace(/[\\/\u0000-\u001f]/g, '').slice(0, 200);
  if (!name || !supportedExtension(name)) return res.status(400).json({ error: 'Unsupported file type' });
  const projectId = z.string().max(100).parse(req.body.projectId || '') || null;
  if (projectId && !(await db.project.findFirst({ where: { id: projectId, companyId: req.companyId } }))) return res.status(400).json({ error: 'Project not in company' });
  let extractedText: string;
  try { extractedText = await extractDocument(name, file.buffer, file.mimetype); }
  catch (error) { return res.status((error as Error).message.includes('parser is not ready') ? 503 : 422).json({ error: (error as Error).message }); }
  const chunks = chunkDocument(extractedText);
  const document = await db.knowledgeDocument.create({ data: {
    companyId: req.companyId!, projectId, name, mimeType: file.mimetype || 'application/octet-stream', size: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), fileData: new Uint8Array(file.buffer), extractedText, preview: extractedText.slice(0, 300), chunkCount: chunks.length,
    chunks: { create: chunks.map((content, ordinal) => ({ companyId: req.companyId!, projectId, ordinal, content })) }
  }, select: { id: true, name: true, size: true, chunkCount: true, projectId: true, createdAt: true } });
  await proposeLearnings(db, { companyId: req.companyId!, projectId, sourceType: 'document', sourceId: document.id, sourceLabel: `Document: ${name}`, content: extractedText });
  // Indexing is best effort: originals and extracted text remain available when Ollama is offline.
  void indexDocument(db, req.companyId!, document.id).catch(error => console.warn('Knowledge vector indexing deferred:', (error as Error).message));
  await audit(req, 'document.uploaded', 'KnowledgeDocument', document.id, { name, chunkCount: chunks.length, projectId });
  res.status(201).json(document);
}));
app.get('/api/documents/:id', asyncRoute(async (req, res) => {
  const document = await db.knowledgeDocument.findFirst({ where: { id: req.params.id, companyId: req.companyId }, select: { id: true, name: true, mimeType: true, size: true, extractedText: true, projectId: true, createdAt: true } });
  if (!document) return res.status(404).json({ error: 'Document not found' });
  res.json(document);
}));
app.get('/api/documents/:id/download', asyncRoute(async (req, res) => {
  const document = await db.knowledgeDocument.findFirst({ where: { id: req.params.id, companyId: req.companyId }, select: { name: true, mimeType: true, fileData: true } });
  if (!document) return res.status(404).json({ error: 'Document not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`);
  res.send(Buffer.from(document.fileData));
}));
app.delete('/api/documents/:id', canWrite, asyncRoute(async (req, res) => {
  const document = await db.knowledgeDocument.findFirst({ where: { id: req.params.id, companyId: req.companyId }, select: { id: true } });
  if (!document) return res.status(404).json({ error: 'Document not found' });
  await db.knowledgeDocument.delete({ where: { id: document.id } });
  await db.learningPoint.deleteMany({ where: { companyId: req.companyId!, sourceType: 'document', sourceId: document.id } });
  void removeDocumentVectors(document.id).catch(error => console.warn('Vector cleanup deferred:', (error as Error).message));
  await audit(req, 'document.deleted', 'KnowledgeDocument', document.id);
  res.status(204).end();
}));
app.post('/api/chat-transcripts', canWrite, asyncRoute(async (req, res) => {
  const input = z.object({ title: z.string().min(2).max(150), content: z.string().min(25).max(50000), projectId: z.string().nullable().optional() }).parse(req.body);
  if (input.projectId && !(await db.project.findFirst({ where: { id: input.projectId, companyId: req.companyId } }))) return res.status(400).json({ error: 'Project not in company' });
  const transcript = await db.chatTranscript.create({ data: { companyId: req.companyId!, projectId: input.projectId || null, title: input.title, content: input.content } });
  const count = await proposeLearnings(db, { companyId: req.companyId!, projectId: transcript.projectId, sourceType: 'chat', sourceId: transcript.id, sourceLabel: `Chat: ${transcript.title}`, content: transcript.content });
  await audit(req, 'chat.ingested', 'ChatTranscript', transcript.id, { count });
  res.status(201).json({ id: transcript.id, count });
}));
app.patch('/api/learnings/:id/review', canAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_EDIT']), statement: z.string().min(15).max(500).optional(), reviewNote: z.string().max(2000).optional(), version: z.number().int().positive() }).parse(req.body);
  const old = await db.learningPoint.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!old) return res.status(404).json({ error: 'Learning point not found' });
  if (old.version !== input.version) return res.status(409).json({ error: 'Learning point changed; refresh and retry' });
  if (input.status === 'NEEDS_EDIT' && !input.reviewNote?.trim()) return res.status(400).json({ error: 'Add a modification note' });
  const statement = input.statement?.trim() || old.statement;
  const updated = await db.$transaction(async tx => {
    const claimed = await tx.learningPoint.updateMany({ where: { id: old.id, companyId: req.companyId!, version: input.version }, data: { status: input.status, statement, reviewNote: input.reviewNote || null,
      reviewedById: req.userId!, reviewedAt: new Date(), version: { increment: 1 } } });
    if (!claimed.count) return null;
    await tx.learningRevision.create({ data: { learningId: old.id, version: old.version + 1, statement, status: input.status, reviewNote: input.reviewNote || null, actorId: req.userId! } });
    return tx.learningPoint.findUniqueOrThrow({ where: { id: old.id } });
  });
  if (!updated) return res.status(409).json({ error: 'Learning point changed; refresh and retry' });
  await audit(req, 'learning.reviewed', 'LearningPoint', old.id, { status: input.status, version: updated.version });
  res.json(updated);
}));
app.get('/api/learnings/:id/revisions', asyncRoute(async (req, res) => {
  const point = await db.learningPoint.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!point) return res.status(404).json({ error: 'Learning point not found' });
  res.json(await db.learningRevision.findMany({ where: { learningId: point.id }, orderBy: { version: 'desc' } }));
}));
app.post('/api/knowledge/reindex', canAdmin, asyncRoute(async (req, res) => {
  const docs = await db.knowledgeDocument.findMany({ where: { companyId: req.companyId! }, select: { id: true } });
  let indexed = 0;
  for (const document of docs) indexed += await indexDocument(db, req.companyId!, document.id);
  await audit(req, 'knowledge.reindexed', 'Company', req.companyId!, { documents: docs.length, chunks: indexed });
  res.json({ documents: docs.length, chunks: indexed });
}));
app.post('/api/approvals/:id/decision', canAdmin, asyncRoute(async (req, res) => {
  const { decision, feedback } = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), feedback: z.string().max(2000).optional() }).parse(req.body);
  const old = await db.approval.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!old) return res.status(404).json({ error: 'Approval not found' });
  if (old.status !== 'PENDING') return res.status(409).json({ error: 'Already decided' });
  const approval = await db.approval.update({ where: { id: old.id }, data: { status: decision, decidedById: req.userId!, decidedAt: new Date() } });
  // Approval records a decision only; no external write or PR action is triggered in this MVP.
  await db.agentRun.update({ where: { id: old.runId }, data: { status: decision === 'APPROVED' ? 'SUCCEEDED' : 'CANCELLED' } });
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: old.runId } });
  await db.task.update({ where: { id: run.taskId }, data: { status: decision === 'APPROVED' ? 'DONE' : 'BLOCKED' } });
  if (feedback?.trim()) {
    const task = await db.task.findUniqueOrThrow({ where: { id: run.taskId } });
    await proposeLearnings(db, { companyId: req.companyId!, projectId: task.projectId, sourceType: 'feedback', sourceId: approval.id,
      sourceLabel: `Review feedback: ${task.title}`, content: feedback.trim() });
  }
  if (decision === 'APPROVED' && Array.isArray(run.plan) && run.plan.length) {
    const task = await db.task.findUniqueOrThrow({ where: { id: run.taskId } });
    await proposeLearnings(db, { companyId: req.companyId!, projectId: task.projectId, sourceType: 'run', sourceId: run.id,
      sourceLabel: `Approved plan: ${task.title}`, content: `The reviewed plan for ${task.title} proposes:\n\n${run.plan.map(step => String(step)).join('\n\n')}` });
  }
  await audit(req, 'approval.decided', 'Approval', approval.id, { decision, feedback: feedback?.trim() || null });
  res.json(approval);
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File is too large (maximum 15 MB)' : error.message });
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: error.flatten() });
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (message.includes('not found') || message.includes('not implemented') || message.includes('already active') || message.startsWith('Add a Codex API key') || message.startsWith('Add a local Codex runner')) return res.status(400).json({ error: message });
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Orbito AI API listening on :${port}`));
