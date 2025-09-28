# Home Assistant Cloudflare Worker Bridge

This project provisions a Cloudflare Worker capable of mirroring the full Home Assistant API surface, enriching it with
Durable Objects, D1 databases, KV memories, and Cloudflare AI so a shadcn UI or Home Assistant automations can offload
complex orchestration to Cloudflare's edge.

## Features

- **REST & Websocket Proxies** – `/api/ha/rest/*` forwards any HTTP verb to Home Assistant's REST API, while
  `/api/ha/websocket` upgrades clients into a Durable Object powered fan-out connection that keeps the upstream Home
  Assistant websocket alive.
- **Durable Object Session Manager** – `HAWebsocketDurableObject` owns the Home Assistant websocket and relays traffic to
  any number of clients.
- **Recorder Replica (D1)** – `migrations/recorder/0001_initial.sql` mirrors Home Assistant's recorder tables so
  automations and analytics can run locally at the edge.
- **Configuration Store (D1)** – `migrations/config/0001_initial.sql` tracks entity nicknames, room metadata, agent rules,
  cron jobs, and automation blueprints.
- **Agent Orchestration** – `POST /api/agent/chat` exposes an agent that mixes KV memories, configuration data, and the
  Home Assistant API to execute natural language intents.
- **Security & Analytics Tooling** – Dedicated endpoints handle camera stills/analysis, energy metrics, and error log
  access, plus a scheduled report stored in KV.
- **Static Documentation** – `/` serves `public/index.html` and `/openapi.json` documents the backend endpoints for UI
  integrations.

## Development

Install dependencies and run type checks:

```bash
npm install
npm run check
```

To deploy locally with Wrangler:

```bash
wrangler dev
```

Ensure the following bindings are configured in `wrangler.toml` or your environment:

- `HASSIO_URL`, `HASSIO_LONG_LIVED_TOKEN`, `WORKER_API_KEY`
- Durable Object binding `HA_WEBSOCKET_DO`
- D1 bindings `RECORDER_DB` and `CONFIG_DB`
- KV binding `MEMORY_KV`
- AI binding `AI`
- Assets binding `ASSETS` targeting the `public/` directory

The static landing page links to the OpenAPI definition for quick client scaffolding.
