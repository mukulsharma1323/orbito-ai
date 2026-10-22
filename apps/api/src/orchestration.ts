import { PrismaClient } from '@prisma/client';
import { planWithCodex, PlanningInput } from './codex.js';
import { decryptSecret } from './security.js';

export interface ProviderAdapter {
  kind: string;
  execute(input: PlanningInput, credential?: string): Promise<{ plan: string[]; logs: string[]; estimatedCostUsd: number }>;
}

export const mockAdapter: ProviderAdapter = {
  kind: 'mock',
  async execute(input) {
    return {
      plan: ['Read scoped project knowledge and task spec', 'Prepare implementation plan', 'Run checks in isolated workspace', 'Request human review before any repository write'],
      logs: [
        `Task received: ${input.title}`,
        `Project context: ${input.project?.name ?? 'company-wide'}`,
        'Mock provider produced a simulated plan. No code, repository, or external system was changed.',
        'Policy gate: human approval required before a write-capable executor can proceed.'
      ],
      estimatedCostUsd: 0
    };
  }
};

const codexAdapter: ProviderAdapter = {
  kind: 'codex-cli',
  execute(input, credential) {
    if (!credential) throw new Error('Codex API key is missing');
    return planWithCodex(input, credential);
  }
};

const adapters = new Map<string, ProviderAdapter>([['mock', mockAdapter], ['codex-cli', codexAdapter]]);

export async function startRun(db: PrismaClient, companyId: string, taskId: string, actorId: string) {
  const task = await db.task.findFirst({ where: { id: taskId, companyId }, include: { project: true } });
  if (!task) throw new Error('Task not found');
  const adapter = adapters.get(task.providerKind);
  if (!adapter) throw new Error(`${task.providerKind} execution is not implemented yet.`);
  const existing = await db.agentRun.findFirst({ where: { taskId, companyId, status: { in: ['QUEUED', 'RUNNING'] } } });
  if (existing) throw new Error('A run is already active for this task');
  const provider = task.providerKind === 'codex-cli'
    ? await db.providerConnection.findFirst({ where: { companyId, kind: 'codex-cli', encryptedSecret: { not: null } }, orderBy: { createdAt: 'desc' } })
    : null;
  if (task.providerKind === 'codex-cli' && !provider?.encryptedSecret) throw new Error('Add a Codex API key in Integrations before running this task');
  const [company, memories] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId } }),
    db.memoryEntry.findMany({
      where: { companyId, OR: [{ projectId: null }, ...(task.projectId ? [{ projectId: task.projectId }] : [])] },
      select: { kind: true, title: true, content: true, version: true },
      orderBy: { updatedAt: 'desc' }, take: 30
    })
  ]);
  const input: PlanningInput = {
    company: company.name,
    project: task.project,
    title: task.title,
    spec: task.spec,
    memories,
    budgetUsd: Number(task.budgetUsd)
  };
  const run = await db.agentRun.create({ data: { companyId, taskId, providerKind: adapter.kind, status: 'QUEUED', logs: ['Run queued'] } });
  await db.task.update({ where: { id: taskId }, data: { status: 'RUNNING' } });
  await db.auditLog.create({ data: { companyId, actorId, action: 'run.started', entityType: 'AgentRun', entityId: run.id, detail: { provider: adapter.kind } } });
  // A dedicated durable queue is still needed for production. The API process owns this first-iteration job.
  setImmediate(() => { void executeRun(db, run.id, companyId, taskId, adapter, input, provider?.encryptedSecret ?? undefined); });
  return run;
}

async function executeRun(db: PrismaClient, runId: string, companyId: string, taskId: string, adapter: ProviderAdapter, input: PlanningInput, encryptedSecret?: string) {
  try {
    await db.agentRun.update({ where: { id: runId }, data: { status: 'RUNNING', logs: [adapter.kind === 'mock' ? 'Mock worker started' : 'Codex planning started'] } });
    const credential = encryptedSecret ? decryptSecret(encryptedSecret) : undefined;
    const output = await adapter.execute(input, credential);
    await db.agentRun.update({ where: { id: runId }, data: { status: 'AWAITING_APPROVAL', plan: output.plan, logs: output.logs, costUsd: output.estimatedCostUsd, finishedAt: new Date() } });
    await db.approval.create({ data: { companyId, runId, type: 'PLAN_REVIEW', summary: `Review ${adapter.kind === 'mock' ? 'simulated' : 'Codex'} plan for ${input.title}` } });
    await db.task.update({ where: { id: taskId }, data: { status: 'REVIEW' } });
    await db.auditLog.create({ data: { companyId, action: 'run.plan_ready', entityType: 'AgentRun', entityId: runId, detail: { provider: adapter.kind } } });
  } catch (error) {
    // Provider errors can contain request details. Persist only a safe category.
    const reason = error instanceof Error && error.name === 'AbortError' ? 'Codex planning timed out' : 'Provider execution failed. Check the API service and provider credential.';
    await db.agentRun.update({ where: { id: runId }, data: { status: 'FAILED', logs: [reason], finishedAt: new Date() } });
    await db.task.update({ where: { id: taskId }, data: { status: 'BLOCKED' } });
    await db.auditLog.create({ data: { companyId, action: 'run.failed', entityType: 'AgentRun', entityId: runId, detail: { provider: adapter.kind } } });
  }
}
