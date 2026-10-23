# Orbito AI

Orbito AI is an open-source starter for a self-hosted AI company command center. It gives teams one place to register companies and products, write persistent context, prepare tasks, inspect runs, and make approval decisions. The optional Prikind workspace demonstrates the flow without external API keys.

![License](https://img.shields.io/badge/license-MIT-blue)

## Run the demo

Requirements: Docker Compose. Clone or open this repository, then:

```bash
cp .env.example .env
docker compose up --build --remove-orphans
```

Open `http://localhost:3000`. In demo mode, the web app signs in to a seeded `Prikind` workspace automatically. The API is at `http://localhost:4000`; `GET /health` reports status. **Do not expose demo mode to the internet.**

On first sign-in to a company, its owner or admin chooses at least one of 12 departments. That selection is saved for the company and appears on the dashboard; it can be changed with **Edit departments**. Click a department card to see its task summary and create tasks assigned to that department. Existing companies will see setup once after updating. Docker stores SQLite data in the `sqlite_data` volume.

The **Board** sidebar item shows all tasks as tickets, including company-wide tasks. Its department dropdown supports multiple selections and **Select all**. Tickets can be moved between columns by dragging or using their status menu. Moving a ticket updates its task status and audit log; it does not start an agent run or approve a plan. Tickets with an active run or pending approval cannot be moved manually.

For local development without Docker or a separate database server:

```bash
cp .env.example .env
nvm use 24
npm install
npm run dev
```

To enable semantic knowledge search, install and start [Ollama](https://ollama.com/download), then download the embedding model **once on the machine running Ollama** (for local or Docker setup):

```bash
ollama pull nomic-embed-text
```

Every Orbito user on that installation shares this model; they do not need to run the command individually. Without Ollama or this model, Orbito still runs and uses keyword search.

`npm run dev` creates/updates the SQLite database at `apps/api/prisma/dev.db`, seeds the demo workspace, then starts the API, web app and local Docling parser. On the first run it creates `.venv-docling` and installs Docling Serve using Python 3.10+; this requires internet, several minutes and multiple gigabytes of disk space for dependencies and models. Subsequent runs reuse the environment. Wait for Docling's `Application startup complete` log before uploading PDFs, Office files or images. If the web and API are already running, `npm run dev:parser` starts just the parser. If another Docling instance is already running at `DOCLING_URL`, the script reuses it. Set `PYTHON_BIN` if `python3` is not the Python installation you want to use. After switching from an older PostgreSQL setup, update `DATABASE_URL` in your existing `.env` to `file:./dev.db`. `--remove-orphans` stops the old PostgreSQL container. PostgreSQL records are not copied into SQLite automatically; the old Docker volume is left intact.

### Knowledge files and agent memory

Open **Knowledge → Upload files**, choose company-wide or a project, and upload one or more files. Plain text, Markdown, CSV, JSON, YAML, XML and logs parse directly in the API. PDFs, Office files, HTML and images use [Docling Serve](https://docling-project.github.io/docling/usage/api_server/rest_api/) for text extraction and OCR. Both Docker Compose and `npm run dev` start Docling automatically. The API uses `DOCLING_URL=http://127.0.0.1:5001` by default for local development; you can point it to another Docling Serve instance. Its first start may download models and take longer than later starts.

Uploaded originals and extracted text are stored in Prisma SQLite. The API chunks extracted text and retrieves company/project scoped knowledge for each run. [Mastra LibSQLVector](https://mastra.ai/reference/rag/vector-databases) stores a separate local semantic index when an Ollama embedding model is available; the API uses `OLLAMA_URL` and `OLLAMA_EMBED_MODEL`. Existing documents can be indexed with `POST /api/knowledge/reindex` (owner/admin). When Ollama is unavailable, keyword retrieval continues. Docker users can reach an Ollama instance on the host through `host.docker.internal`; set `OLLAMA_URL` if it runs elsewhere. The vector file is `apps/api/prisma/knowledge-vectors.db` locally or `/app/data/knowledge-vectors.db` in Docker. Originals remain the source of truth. Company-wide knowledge is available to every project; project knowledge is available only to that project's tasks. Files are limited to 15 MB and extracted text to 1 million characters. Images currently contribute OCR text; photos or diagrams without readable text need a vision captioning model.

### Learning review and agent feedback

**Learning** in the sidebar shows proposed points from uploaded documents, task specifications, approved run plans and imported chat transcripts. Each point records its source, company/project scope, status and revisions. Owners/admins can mark it **Correct / approve**, **Incorrect**, or **Needs modification**, and can edit the statement before approval. Only approved points are added to future agent context as reviewed memory. Raw documents remain retrievable as source material. Deleting a document removes its derived proposals. Approval feedback on a run creates new review candidates, so human corrections can affect later plans after review.

Chat history is not connected automatically to external chat apps. Use **Learning → Import chat** to paste a transcript. By default the API derives candidate sentences from source text; set `OLLAMA_LEARNING_MODEL` to an installed local Ollama generation model for model-based extraction. Candidate status is always pending until an owner/admin reviews it. This is context retrieval and review-driven learning, not model training. The mock provider still simulates planning.

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

Node 22.13+ is required for Mastra; Node 24 is recommended (`nvm use 24`). Generate real values for `JWT_SECRET` and `ENCRYPTION_KEY` before any nonlocal deployment; for example, `openssl rand -hex 32` creates the encryption key. The `.env.example` encryption key is deliberately demo-only. The root `npm run dev` script loads `.env` automatically (`docker compose` loads `.env` automatically).

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
| Company department onboarding, detail views and assigned tasks | Working; other department workflows are not implemented |
| Global Kanban board with department multiselect and ticket status moves | Working; uses existing tasks as tickets |
| Company scoped access and owner/admin/member/viewer roles | API working; member invitation UI pending |
| Project registry, GitHub URL metadata and project AGENTS.md text | Working; no GitHub sync yet |
| Task specs, priorities, provider choice and budget cap metadata | Working; budget enforcement pending |
| Versioned company/project decisions, policies, notes | Working |
| Company/project file knowledge and task-time retrieval | Working for text; PDF, Office and image parsing requires Docling Serve |
| Mastra LibSQL semantic retrieval | Working with a configured Ollama embedding model; keyword fallback without it |
| Learning review, source-backed proposals and feedback | Working for docs, tasks, approved plans, pasted chats and review feedback; external chat sync pending |
| Mock agent runs with plans, logs and approval requests | Working; simulation only |
| Codex SDK read-only planning from scoped saved context | Working with a configured OpenAI API key; live call requires your key |
| Mac local Codex runner using ChatGPT sign-in | Implemented; requires the runner process on the signed-in Mac |
| Approve/reject gate and audit events | Working; decisions never execute external writes |
| AES-256-GCM encrypted provider credential storage | Working; Codex key is used at run time, not validated on save |
| Claude, OpenAI, GitHub, n8n and durable isolated workers | Interfaces/architecture only, not connected |

## Architecture

```text
Browser (Next.js) ──HTTP/JWT──> Express API ──Prisma──> SQLite
                                   │
                                   └── Docling Serve (PDF/Office/image parsing)
                                   └── Mastra LibSQLVector + Ollama (optional semantic index)
                                   └── Learning proposals → admin review → approved run context
                              │
                              └── ProviderAdapter registry
                                   ├── mock adapter
                                   ├── Codex SDK API-key planning adapter
                                   └── company-scoped Mac runner using ChatGPT sign-in
```

All company records carry `companyId`. The API resolves a membership for each `/api` request and scopes every read/write by that company. Provider secrets and runner tokens are encrypted before database storage and are never returned by list APIs. The run service resolves the task within the company, records the plan/logs, and creates a review gate. Unsupported adapters fail explicitly. Audit entries record mutations and approval decisions. API-key Codex runs execute in the API process; subscription runs wait in SQLite until the company-scoped Mac runner claims them. Both use a fresh temporary planning directory. The task and knowledge are sent to the model. This SQLite setup targets a single API instance.

The next execution milestone should add a durable queue and a separate ephemeral worker container per run, with a cloned repository, scoped short-lived credentials, resource/time limits, and a write gate that can only create a reviewable branch/PR. Budget counters, retries, cancellation, webhook signatures, and n8n event delivery should be built around the same run records.

## Repository layout

```text
apps/web/      Next.js responsive UI
apps/api/      Express API and adapter contract
apps/api/prisma/schema.prisma   SQLite data model
apps/api/prisma/seed.ts         Optional Prikind demo data
docker-compose.yml              Local services
```

## API map

- `POST /auth/bootstrap`, `POST /auth/login`, `POST /auth/demo`, `GET /me`
- `GET /api/overview`
- `PATCH /api/company/departments` (owner/admin)
- `POST /api/projects`, `PATCH /api/projects/:id`
- `POST /api/tasks`, `PATCH /api/tasks/:id/status`, `POST /api/tasks/:id/runs`, `GET /api/runs/:id`
- `POST /api/memories`, `PATCH /api/memories/:id`, `GET /api/memories/:id/revisions`
- `POST /api/documents` (multipart `file`, optional `projectId`), `GET /api/documents/:id`, `GET /api/documents/:id/download`, `DELETE /api/documents/:id`
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
