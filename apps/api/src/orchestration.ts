import { PrismaClient } from '@prisma/client';

export interface ProviderAdapter {
  kind: string;
  execute(input: { title: string; spec: string; project?: string | null }): Promise<{ plan: string[]; logs: string[]; estimatedCostUsd: number }>;
}

export const mockAdapter: ProviderAdapter = {
  kind: 'mock',
  async execute(input) {
    return {
      plan: ['Read scoped project knowledge and task spec', 'Prepare implementation plan', 'Run checks in isolated workspace', 'Request human review before any repository write'],
      logs: [
        `Task received: ${input.title}`,
        `Project context: ${input.project ?? 'company-wide'}`,
        'Mock provider produced a simulated plan. No code, repository, or external system was changed.',
        'Policy gate: human approval required before a write-capable executor can proceed.'
      ],
      estimatedCostUsd: 0
    };
  }
};

// Future adapters implement ProviderAdapter and run in an isolated worker with scoped credentials.
// The API intentionally rejects unimplemented provider execution rather than pretending it ran.
const adapters = new Map<string, ProviderAdapter>([['mock', mockAdapter]]);

export async function startRun(db: PrismaClient, companyId: string, taskId: string, actorId: string) {
  const task = await db.task.findFirst({ where: { id: taskId, companyId }, include: { project: true } });
  if (!task) throw new Error('Task not found');
  const adapter = adapters.get(task.providerKind);
  if (!adapter) throw new Error(`${task.providerKind} execution is not implemented yet. Use mock for demo runs.`);
  const run = await db.agentRun.create({ data: { companyId, taskId, providerKind: adapter.kind, status: 'RUNNING', logs: ['Run queued', 'Mock worker started'] } });
  await db.task.update({ where: { id: taskId }, data: { status: 'RUNNING' } });
  try {
    const output = await adapter.execute({ title: task.title, spec: task.spec, project: task.project?.name });
    const completed = await db.agentRun.update({ where: { id: run.id }, data: { status: 'AWAITING_APPROVAL', plan: output.plan, logs: output.logs, costUsd: output.estimatedCostUsd, finishedAt: new Date() } });
    await db.approval.create({ data: { companyId, runId: run.id, type: 'PLAN_REVIEW', summary: `Review simulated plan for ${task.title}` } });
    await db.task.update({ where: { id: taskId }, data: { status: 'REVIEW' } });
    await db.auditLog.create({ data: { companyId, actorId, action: 'run.started', entityType: 'AgentRun', entityId: run.id, detail: { provider: adapter.kind } } });
    return completed;
  } catch (error) {
    await db.agentRun.update({ where: { id: run.id }, data: { status: 'FAILED', logs: [String(error)], finishedAt: new Date() } });
    await db.task.update({ where: { id: taskId }, data: { status: 'BLOCKED' } });
    throw error;
  }
}
