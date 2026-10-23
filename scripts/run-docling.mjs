import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const url = new URL(process.env.DOCLING_URL || 'http://127.0.0.1:5001');
if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  console.log(`Using external Docling service at ${url.origin}`);
  process.exit(0);
}

try {
  const response = await fetch(new URL('/docs', url), { signal: AbortSignal.timeout(1500) });
  if (response.ok) {
    console.log(`Docling is already running at ${url.origin}`);
    process.exit(0);
  }
} catch { /* No parser is listening yet. */ }

const venv = resolve('.venv-docling');
const python = process.env.PYTHON_BIN || 'python3';
const executable = resolve(venv, 'bin', 'docling-serve');
if (!existsSync(executable)) {
  console.log('Installing Docling Serve locally (first run can take several minutes)...');
  const create = spawnSync(python, ['-m', 'venv', venv], { stdio: 'inherit' });
  if (create.status !== 0) {
    console.error(`Could not create the parser environment. Install Python 3.10+ or set PYTHON_BIN.`);
    process.exit(1);
  }
  const install = spawnSync(resolve(venv, 'bin', 'pip'), ['install', 'docling-serve>=1.21,<2'], { stdio: 'inherit' });
  if (install.status !== 0) {
    console.error('Docling installation failed. Check your internet connection, then run npm run dev again.');
    process.exit(1);
  }
}

console.log(`Starting local Docling parser at ${url.origin}`);
const child = spawn(executable, ['run'], {
  stdio: 'inherit',
  env: { ...process.env, UVICORN_HOST: '127.0.0.1', UVICORN_PORT: url.port || '5001' }
});
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', error => { console.error(`Unable to start Docling: ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
