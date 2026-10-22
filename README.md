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
| Approve/reject gate and audit events | Working; decisions never execute external writes |
| AES-256-GCM encrypted provider credential storage | Working; provider validation/execution pending |
| Claude, OpenAI/Codex, GitHub, n8n and isolated workers | Interfaces/architecture only, not connected |

## Architecture

```text
Browser (Next.js) ──HTTP/JWT──> Express API ──Prisma──> PostgreSQL
                              │
                              └── ProviderAdapter registry
                                   └── mock adapter (implemented)
```

All company records carry `companyId`. The API resolves a membership for each `/api` request and scopes every read/write by that company. Provider secrets are encrypted before database storage and are never returned by list APIs. The run service resolves the task within the company, selects an adapter, records the plan/logs, and creates a review gate. Unsupported adapters fail explicitly. Audit entries record mutations and approval decisions.

The next execution milestone should add a queue and a separate ephemeral worker container per run, with a cloned repository, scoped short-lived credentials, resource/time limits, and a write gate that can only create a reviewable branch/PR. Budget counters, retries, cancellation, webhook signatures, and n8n event delivery should be built around the same run records.

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
- `POST /api/providers`
- `POST /api/approvals/:id/decision`

Protected API calls require `Authorization: Bearer <token>` and `x-company-id: <companyId>`. Write operations enforce member role; provider and approval decisions require admin or owner role. Company creation is available at `POST /companies` for an authenticated user.

## Security notes

- Demo mode exposes automatic demo login and must remain local/private.
- This MVP is a scaffold, not a production security certification. Add rate limiting, secure cookie sessions, CSRF protection, secret rotation, invitation lifecycle, and operational monitoring before public hosting.
- GitHub URLs and AGENTS.md are stored as data. No repository is cloned or executed by this build.
- The mock adapter never calls a model or changes external systems.

## License

MIT. See [LICENSE](LICENSE).
