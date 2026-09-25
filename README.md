# Azure DevOps AI PR Reviewer

Local PR review service for Azure Repos. It polls every five minutes, reviews new
PR commit iterations with an OpenAI-compatible model, posts actionable inline
comments, and records review history in SQLite.

## Setup

1. Copy `.env.example` to `.env` and fill in every credential.
2. Give the Azure DevOps PAT only **Code (Read)** and **Pull Request Threads
   (Read & Write)** permissions.
3. Start both services:

   ```sh
   docker compose up --build
   ```

4. Open <http://localhost:5173> and enter `DASHBOARD_AUTH_TOKEN`.

The API health endpoint is available at <http://localhost:8000/health>. All
`/api/*` endpoints require the bearer token.

`VITE_API_BASE_URL` is baked into the frontend bundle. If its value in
`docker-compose.yml` changes, rebuild the frontend image.

## LLM provider and code handling

AI models are managed in the dashboard **Models** page (OpenAI-compatible
base URL, API key, model id, and cost rates). Confirm that your organization
approves the chosen provider before use. Provider retention and training
terms vary, and providers in other jurisdictions can create data-sovereignty
concerns. DeepSeek-hosted models, for example, may process data in China.

Generated files, dependency locks, `dist/`, `vendor/`, and `node_modules/` are
excluded. Diffs over `MAX_CHANGED_LINES` are skipped. The daily spend guard uses
each model's configured per-million-token rates, so keep those rates current.

## Local deployment

Keep both services on the local machine or a private network such as Tailscale.
Do not expose the backend through public port forwarding: it holds the Azure
DevOps PAT and LLM key. SQLite data is stored under `backend/data/`.
