import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { PrismaClient, Role } from '@prisma/client';
import { z } from 'zod';
import { encryptSecret, signSession, verifySession } from './security.js';
import { startRun } from './orchestration.js';
import { claimLocalRun, completeLocalRun, failLocalRun, runnerCompany } from './local-runner-service.js';

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
const audit = (req: AuthRequest, action: string, entityType: string, entityId: string, detail?: object) => db.auditLog.create({ data: { companyId: req.companyId!, actorId: req.userId!, action, entityType, entityId, detail } });

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
  const [company, projects, tasks, runs, approvals, memories, providers, auditLogs] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId } }),
    db.project.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    db.task.findMany({ where: { companyId }, include: { project: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
    db.agentRun.findMany({ where: { companyId }, include: { task: { select: { title: true } } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    db.approval.findMany({ where: { companyId }, include: { run: { include: { task: { select: { title: true } } } } }, orderBy: { createdAt: 'desc' } }),
    db.memoryEntry.findMany({ where: { companyId }, include: { project: { select: { name: true } } }, orderBy: { updatedAt: 'desc' } }),
    db.providerConnection.findMany({ where: { companyId }, select: { id: true, kind: true, label: true, status: true, createdAt: true } }),
    db.auditLog.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 20 })
  ]);
  res.json({ company, projects, tasks, runs, approvals, memories, providers, auditLogs });
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
  const input = z.object({ title: z.string().min(3), spec: z.string().min(10), projectId: z.string().nullable().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), providerKind: z.enum(['mock', 'claude', 'openai', 'codex-cli', 'codex-local']).default('mock'), budgetUsd: z.number().min(0).max(10000).default(5) }).parse(req.body);
  if (input.projectId && !(await db.project.findFirst({ where: { id: input.projectId, companyId: req.companyId } }))) return res.status(400).json({ error: 'Project not in company' });
  const task = await db.task.create({ data: { ...input, companyId: req.companyId! } });
  await audit(req, 'task.created', 'Task', task.id);
  res.status(201).json(task);
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
app.post('/api/approvals/:id/decision', canAdmin, asyncRoute(async (req, res) => {
  const { decision } = z.object({ decision: z.enum(['APPROVED', 'REJECTED']) }).parse(req.body);
  const old = await db.approval.findFirst({ where: { id: req.params.id, companyId: req.companyId } });
  if (!old) return res.status(404).json({ error: 'Approval not found' });
  if (old.status !== 'PENDING') return res.status(409).json({ error: 'Already decided' });
  const approval = await db.approval.update({ where: { id: old.id }, data: { status: decision, decidedById: req.userId!, decidedAt: new Date() } });
  // Approval records a decision only; no external write or PR action is triggered in this MVP.
  await db.agentRun.update({ where: { id: old.runId }, data: { status: decision === 'APPROVED' ? 'SUCCEEDED' : 'CANCELLED' } });
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: old.runId } });
  await db.task.update({ where: { id: run.taskId }, data: { status: decision === 'APPROVED' ? 'DONE' : 'BLOCKED' } });
  await audit(req, 'approval.decided', 'Approval', approval.id, { decision });
  res.json(approval);
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: error.flatten() });
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (message.includes('not found') || message.includes('not implemented') || message.includes('already active') || message.startsWith('Add a Codex API key') || message.startsWith('Add a local Codex runner')) return res.status(400).json({ error: message });
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});
const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Orbito AI API listening on :${port}`));
