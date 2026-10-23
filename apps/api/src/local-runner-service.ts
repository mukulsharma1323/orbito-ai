import { timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PlanningInput } from './codex.js';
import { decryptSecret } from './security.js';
import { relevantKnowledge } from './knowledge.js';

export async function runnerCompany(db: PrismaClient, header: string | undefined): Promise<string | null> {
  const token = header?.match(/^Bearer ([a-z0-9]+)\.([a-f0-9]{64})$/i);
  if (!token) return null;
  const provider = await db.providerConnection.findUnique({ where: { id: token[1] } });
  if (!provider || provider.kind !== 'codex-local' || provider.status !== 'runner-configured' || !provider.encryptedSecret) return null;
  const expected = Buffer.from(decryptSecret(provider.encryptedSecret), 'utf8');
  const supplied = Buffer.from(token[2], 'utf8');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? provider.companyId : null;
}

export async function claimLocalRun(db: PrismaClient, companyId: string): Promise<{ runId: string; input: PlanningInput } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const queued = await db.agentRun.findFirst({ where: { companyId, providerKind: 'codex-local', status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
    if (!queued) return null;
    const claimed = await db.agentRun.updateMany({ where: { id: queued.id, companyId, status: 'QUEUED' }, data: { status: 'RUNNING', logs: ['Local Codex runner claimed this job'] } });
    if (!claimed.count) continue;
    const [task, company] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: queued.taskId }, include: { project: true } }),
      db.company.findUniqueOrThrow({ where: { id: companyId } })
    ]);
    const memories = await relevantKnowledge(db, companyId, task.projectId, task.title, task.spec);
    return {
      runId: queued.id,
      input: { company: company.name, project: task.project, title: task.title, spec: task.spec, memories, budgetUsd: Number(task.budgetUsd) }
    };
  }
  return null;
}

export async function completeLocalRun(db: PrismaClient, companyId: string, runId: string, output: { plan: string[]; logs: string[] }) {
  return db.$transaction(async tx => {
    const claimed = await tx.agentRun.updateMany({ where: { id: runId, companyId, providerKind: 'codex-local', status: 'RUNNING' }, data: { status: 'AWAITING_APPROVAL', plan: output.plan, logs: output.logs, finishedAt: new Date() } });
    if (!claimed.count) return false;
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
    await tx.approval.create({ data: { companyId, runId, type: 'PLAN_REVIEW', summary: `Review local Codex plan for ${run.task.title}` } });
    await tx.task.update({ where: { id: run.taskId }, data: { status: 'REVIEW' } });
    await tx.auditLog.create({ data: { companyId, action: 'run.plan_ready', entityType: 'AgentRun', entityId: runId, detail: { provider: 'codex-local' } } });
    return true;
  });
}

export async function failLocalRun(db: PrismaClient, companyId: string, runId: string, reason: string) {
  return db.$transaction(async tx => {
    const claimed = await tx.agentRun.updateMany({ where: { id: runId, companyId, providerKind: 'codex-local', status: 'RUNNING' }, data: { status: 'FAILED', logs: [reason], finishedAt: new Date() } });
    if (!claimed.count) return false;
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    await tx.task.update({ where: { id: run.taskId }, data: { status: 'BLOCKED' } });
    await tx.auditLog.create({ data: { companyId, action: 'run.failed', entityType: 'AgentRun', entityId: runId, detail: { provider: 'codex-local' } } });
    return true;
  });
}
