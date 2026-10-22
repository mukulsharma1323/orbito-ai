# Orbito AI

Orbito AI is an open-source starter for a self-hosted AI company command center. It gives teams one place to register companies and products, write persistent context, prepare tasks, inspect runs, and make approval decisions. The optional Prikind workspace demonstrates the flow without external API keys.

![License](https://img.shields.io/badge/license-MIT-blue)

## Run the demo

Requirements: Docker Compose. Clone or open this repository, then:

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:3000`. In demo mode, the web app signs in to a seeded `Prikind` workspace automatically. The API is at `http://localhost:4000`; `GET /health` reports status. **Do not expose demo mode to the internet.**

### Connect Codex

**Use your local ChatGPT sign-in (no OpenAI API key):**

If Orbito is already running from an older clone, update it with `git pull origin main` and `docker compose up --build -d` first.

1. Keep Orbito's Docker services running. On the same Mac, check `codex login status`; it must say `Logged in using ChatGPT`. Run `codex login` if needed.
2. In **Integrations**, add **Codex (my ChatGPT plan)**. Copy the one-time runner token.
3. In the repo on your Mac, run `npm install`, copy `.env.runner.local.example` to `.env.runner.local`, and replace the placeholder with that token. This file is gitignored. Keep `ORBITO_API_URL=http://127.0.0.1:4000` when Docker exposes its default API port.
4. Run `npm run runner:local` in a Mac terminal and leave it running. Create a task with **Codex (my ChatGPT plan)** and click **Run**. The runner picks up the task, uses the Mac user's ChatGPT Codex login for a read-only planning turn, and sends the plan back to Orbito for approval.

The runner token is scoped to one Orbito company, can be revoked by disconnecting that provider, and is shown only once. Only company owners/admins can start subscription runs. Keep the API and web UI private: anyone with an owner/admin account in that company can consume the Mac user's plan allowance. Subscription usage follows your ChatGPT plan limits; this local mode does not use an OpenAI API key. The runner keeps the Codex sign-in on the Mac and does not copy login files into Docker. It currently supports a local Orbito API on the same computer.

**Use an OpenAI API key instead:**

In **Integrations**, add a **Codex (OpenAI API key)** connection. Then create a task using **Codex (API key)** and click **Run**. The API decrypts the key only for that run, starts the official Codex SDK in a temporary workspace with read-only sandboxing and no web search, and feeds it the task spec, project AGENTS.md text, and scoped company/project knowledge. The generated plan and token counts appear under **Runs**; a plan review appears under **Approvals**. A real OpenAI API key with Codex access is required. A ChatGPT/Codex desktop login is not shared with the Docker container.

This run does **not** clone a GitHub repository, edit code, create a branch/PR, or execute anything when you approve the plan. The budget field is metadata; cost estimates and hard spending limits are not implemented. The run job currently lives inside the API process, so a process restart can leave an in-progress run unfinished. Use the mock provider for a no-key demo.

For local development with an existing PostgreSQL server:

```bash
cp .env.example .env
set -a; source .env; set +a
npm install
npm run db:push
npm run db:seed
npm run dev
```

Node 20+ is required. Generate real values for `JWT_SECRET` and `ENCRYPTION_KEY` before any nonlocal deployment; for example, `openssl rand -hex 32` creates the encryption key. The `.env.example` encryption key is deliberately demo-only. Environment variables from `.env` must be loaded by your shell for local Node processes (`docker compose` loads `.env` automatically).

## Production bootstrap

Set `DEMO_MODE=false`, `NEXT_PUBLIC_DEMO_MODE=false`, strong `JWT_SECRET` and `ENCRYPTION_KEY`, a unique `BOOTSTRAP_TOKEN`, and an appropriate `WEB_ORIGIN`/`NEXT_PUBLIC_API_URL`. Build the images after changing browser-exposed variables. With an empty database, create the first owner and company:

```bash
curl -X POST http://localhost:4000/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -d '{"email":"owner@example.com","name":"Owner","password":"a-long-unique-password","companyName":"Your Company"}'
```

The bootstrap endpoint closes as soon as a user exists. Sign in from the web UI. Keep the API behind HTTPS and a trusted reverse proxy for real deployments. Session tokens are currently stored in browser local storage; move to secure server-side cookies before exposing the service to untrusted users.

## Included in this iteration

| Area | Status |
| --- | --- |
| Responsive dashboard with activity and attention cards | Working |
| Company scoped access and owner/admin/member/viewer roles | API working; member invitation UI pending |
| Project registry, GitHub URL metadata and project AGENTS.md text | Working; no GitHub sync yet |
| Task specs, priorities, provider choice and budget cap metadata | Working; budget enforcement pending |
| Versioned company/project decisions, policies, notes | Working |
| Mock agent runs with plans, logs and approval requests | Working; simulation only |
| Codex SDK read-only planning from scoped saved context | Working with a configured OpenAI API key; live call requires your key |
| Mac local Codex runner using ChatGPT sign-in | Implemented; requires the runner process on the signed-in Mac |
| Approve/reject gate and audit events | Working; decisions never execute external writes |
| AES-256-GCM encrypted provider credential storage | Working; Codex key is used at run time, not validated on save |
| Claude, OpenAI, GitHub, n8n and durable isolated workers | Interfaces/architecture only, not connected |

## Architecture

```text
Browser (Next.js) ──HTTP/JWT──> Express API ──Prisma──> PostgreSQL
                              │
                              └── ProviderAdapter registry
                                   ├── mock adapter
                                   ├── Codex SDK API-key planning adapter
                                   └── company-scoped Mac runner using ChatGPT sign-in
```

All company records carry `companyId`. The API resolves a membership for each `/api` request and scopes every read/write by that company. Provider secrets and runner tokens are encrypted before database storage and are never returned by list APIs. The run service resolves the task within the company, records the plan/logs, and creates a review gate. Unsupported adapters fail explicitly. Audit entries record mutations and approval decisions. API-key Codex runs execute in the API process; subscription runs wait in PostgreSQL until the company-scoped Mac runner claims them. Both use a fresh temporary planning directory. The task and knowledge are sent to the model.

The next execution milestone should add a durable queue and a separate ephemeral worker container per run, with a cloned repository, scoped short-lived credentials, resource/time limits, and a write gate that can only create a reviewable branch/PR. Budget counters, retries, cancellation, webhook signatures, and n8n event delivery should be built around the same run records.

## Repository layout

```text
apps/web/      Next.js responsive UI
apps/api/      Express API and adapter contract
apps/api/prisma/schema.prisma   PostgreSQL data model
apps/api/prisma/seed.ts         Optional Prikind demo data
docker-compose.yml              Local services
```

## API map

- `POST /auth/bootstrap`, `POST /auth/login`, `POST /auth/demo`, `GET /me`
- `GET /api/overview`
- `POST /api/projects`, `PATCH /api/projects/:id`
- `POST /api/tasks`, `POST /api/tasks/:id/runs`, `GET /api/runs/:id`
- `POST /api/memories`, `PATCH /api/memories/:id`, `GET /api/memories/:id/revisions`
- `POST /api/providers`, `DELETE /api/providers/:id`
- `POST /runner/claim`, `POST /runner/runs/:id/complete`, `POST /runner/runs/:id/fail` (runner token)
- `POST /api/approvals/:id/decision`

Protected API calls require `Authorization: Bearer <token>` and `x-company-id: <companyId>`. Write operations enforce member role; provider and approval decisions require admin or owner role. Company creation is available at `POST /companies` for an authenticated user.

## Security notes

- Demo mode exposes automatic demo login and must remain local/private.
- This MVP is a scaffold, not a production security certification. Add rate limiting, secure cookie sessions, CSRF protection, secret rotation, invitation lifecycle, and operational monitoring before public hosting.
- GitHub URLs and AGENTS.md are stored as data. No repository is cloned or executed by this build. Stored knowledge is sent to Codex when you start a Codex run.
- The mock adapter never calls a model or changes external systems.

## License

MIT. See [LICENSE](LICENSE).
