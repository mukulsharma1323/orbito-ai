import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { planWithCodex, PlanningInput } from './codex.js';

const configFile = await readFile('.env.runner.local', 'utf8').catch(() => '');
const fromFile = (name: string) => configFile.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
const token = process.env.ORBITO_RUNNER_TOKEN?.trim() || fromFile('ORBITO_RUNNER_TOKEN');
if (!/^[a-z0-9]+\.[a-f0-9]{64}$/i.test(token)) throw new Error('Add the one-time runner token to .env.runner.local first');
const baseUrl = process.env.ORBITO_API_URL || fromFile('ORBITO_API_URL') || 'http://127.0.0.1:4000';
const url = new URL(baseUrl);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local runner API URL must be on this computer');

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  value !== undefined && ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'].includes(key)
)) as NodeJS.ProcessEnv;
const login = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', env: cleanEnv });
if (login.status !== 0 || !/Logged in using ChatGPT/i.test(`${login.stdout}\n${login.stderr}`)) {
  throw new Error('Codex CLI must be signed in using ChatGPT. Run codex login on this Mac first.');
}

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function call(path: string, body: object) {
  const response = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Orbito API returned ${response.status}`);
  return response.json();
}

console.log('Orbito local Codex runner connected with ChatGPT sign-in. Waiting for tasks.');
while (running) {
  try {
    const job = await call('/runner/claim', {}) as { runId: string; input: PlanningInput } | null;
    if (!job) { await pause(2500); continue; }
    console.log(`Planning run ${job.runId}...`);
    try {
      const output = await planWithCodex(job.input);
      await call(`/runner/runs/${encodeURIComponent(job.runId)}/complete`, {
        plan: output.plan.slice(0, 12).map(step => step.slice(0, 2000)),
        logs: output.logs.slice(0, 10).map(line => line.slice(0, 4000))
      });
      console.log(`Run ${job.runId} is ready for approval.`);
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError' ? 'Codex planning timed out' : 'Local Codex execution failed';
      await call(`/runner/runs/${encodeURIComponent(job.runId)}/fail`, { reason }).catch(() => {});
      console.error(`Run ${job.runId} failed: ${reason}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Runner connection failed');
    await pause(5000);
  }
}
