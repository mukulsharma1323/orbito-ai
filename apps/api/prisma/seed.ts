import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const db = new PrismaClient();
async function main() {
  if (process.env.DEMO_MODE !== 'true') return;
  const user = await db.user.upsert({ where: { email: 'demo@orbito.local' }, update: {}, create: { email: 'demo@orbito.local', name: 'Demo Owner', passwordHash: await bcrypt.hash('demo-password', 12) } });
  const company = await db.company.upsert({ where: { slug: 'prikind-demo' }, update: {}, create: { name: 'Prikind', slug: 'prikind-demo', description: 'Sample workspace for Meri Davai and Prikind products' } });
  await db.membership.upsert({ where: { userId_companyId: { userId: user.id, companyId: company.id } }, update: {}, create: { userId: user.id, companyId: company.id, role: 'OWNER' } });
  const samples = [
    ['Meri Davai', 'meri-davai', 'Customer-facing medicine commerce website'],
    ['MD Tracker', 'md-tracker', 'Operations web app and backend'],
    ['MD Desk', 'md-desk', 'Store desktop application'],
    ['MD Partners', 'md-partners', 'Partner operations application'],
    ['MD Care', 'md-care', 'Care coordination application'],
    ['Prikind', 'prikind', 'Company website and brand']
  ];
  for (const [name, slug, description] of samples) await db.project.upsert({ where: { companyId_slug: { companyId: company.id, slug } }, update: {}, create: { companyId: company.id, name, slug, description } });
  if (await db.task.count({ where: { companyId: company.id } })) return;
  const tracker = await db.project.findUniqueOrThrow({ where: { companyId_slug: { companyId: company.id, slug: 'md-tracker' } } });
  const care = await db.project.findUniqueOrThrow({ where: { companyId_slug: { companyId: company.id, slug: 'md-care' } } });
  await db.task.createMany({ data: [
    { companyId: company.id, projectId: tracker.id, title: 'Map inventory reconciliation flow', spec: 'Document the current stock adjustment states and propose a safe reconciliation plan.', status: 'READY', priority: 'high' },
    { companyId: company.id, projectId: care.id, title: 'Define support escalation rules', spec: 'Draft a support escalation decision tree with approval gates.', status: 'BACKLOG', priority: 'medium' },
    { companyId: company.id, title: 'Review shared agent operating rules', spec: 'Review company-wide agent policies and identify missing constraints.', status: 'BACKLOG', priority: 'low' }
  ] });
  const memory = await db.memoryEntry.create({ data: { companyId: company.id, projectId: tracker.id, kind: 'decision', title: 'Inventory changes need review', content: 'Any change to stock adjustment logic requires a human approval and a traceable audit event.', authorId: user.id } });
  await db.memoryRevision.create({ data: { memoryId: memory.id, version: 1, content: memory.content, authorId: user.id } });
  await db.providerConnection.create({ data: { companyId: company.id, kind: 'mock', label: 'Demo simulator', status: 'ready' } });
}
main().finally(() => db.$disconnect());
