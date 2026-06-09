# MCP server — read-only agent access

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
bbstat's dashboard read surface to LLM agents as **tools**. It lets an agent
answer questions like _"who shipped the most this month?"_ or _"summarize repo
X's activity and flag anything that stopped syncing"_ by calling typed tools
instead of you hand-coding a bbstat client into every workflow.

It is **read-only** and **separate from the dashboard API** — a fourth role of
the backend image (`command: dist/mcp/index.js`), like `sync`. No new image; the
`docker save`/`load` deploy flow is unchanged.

## Where it sits

```
agent (Claude Code / Desktop / Agent SDK)  ──MCP/streamable-HTTP──▶  mcp service
                                                                      │ in-process
                                                                      ▼
                                                          StatsStore ─▶ PostgreSQL
```

It reads through the same `StatsStore` (`apps/backend/src/dashboard/stats-store.ts`)
the Vue dashboard uses — **Postgres only, never a live BitBucket call** on the
request path. It holds no business logic of its own: each tool is a thin wrapper
over a store method (`apps/backend/src/mcp/tools/`). Redis is not involved.

## Tools

All read-only. The descriptions baked into each tool tell the agent how to
**resolve ids** — it never guesses internal numeric ids.

| Tool                         | Arguments                                                                                                             | Returns / use                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `get_overview`               | —                                                                                                                     | Org totals (repos, commits, contributors, recent activity).                                           |
| `top_contributors`           | `window_days` (default 30), `limit` (default 10)                                                                      | Leaderboard rows, each with `entity_kind` + `entity_id`.                                              |
| `list_members`               | —                                                                                                                     | Member directory — the lookup from a name/email to `entity_kind` + `entity_id`.                       |
| `get_contributor_summary`    | `entity_kind` (`user`\|`person`), `entity_id`                                                                         | Full per-contributor detail. Resolve ids via the two tools above.                                     |
| `list_repositories`          | —                                                                                                                     | All tracked repos with stats + sync status; carries `workspace`/`slug` + `project`.                   |
| `get_repository_activity`    | `workspace`, `slug`                                                                                                   | Per-repo activity detail. Resolve via `list_repositories`.                                            |
| `repo_contributor_breakdown` | `window_days` (30), `top_repos` (15), `top_per_repo` (5), optional `project`                                          | Top repos by commits, each with its top contributors (the Projects sunburst); optional project scope. |
| `get_project_stats`          | `project_key`                                                                                                         | Project rollup. Keys appear on `list_repositories` rows.                                              |
| `search_activity`            | optional `actor` / `repo` / `project` / `after` / `before` / `message` / `hash_prefix`, `limit` (default 50, max 200) | Unified commit + PR feed, newest first. The flexible query surface.                                   |
| `count_activity`             | same filters as `search_activity`, minus `limit`                                                                      | Exact total entries (commits + PRs) for a filter set — not capped. For "how many …".                  |
| `activity_daily`             | optional `actor` / `repo` / `project`                                                                                 | Daily commit counts over the trailing ~365 days (trend/consistency).                                  |

**Resolution chain:** `list_members` / `top_contributors` → `entity_kind` +
`entity_id` → `get_contributor_summary`; `list_repositories` → `workspace` +
`slug` → `get_repository_activity`. The server's instructions state this, so a
well-behaved agent chains the calls rather than guessing.

Adding a tool later is one file in `tools/` plus one line in `tools/registry.ts`
— see [Extending](#extending).

## Transport

Streamable-HTTP, **stateless** (`StreamableHTTPServerTransport` with
`sessionIdGenerator: undefined`, `enableJsonResponse: true`). A fresh MCP server
and transport are built per request so concurrent agents never collide on
JSON-RPC ids. The endpoint handles `POST` (tool calls), and `GET`/`DELETE` are
routed through the transport too (clients probe `GET` for the server→client
stream; routing them avoids a misleading 404). `GET /healthz` is an
unauthenticated liveness probe.

## Authentication

Every request to `/mcp` needs a **bearer token**. Tokens are stateless,
HMAC-SHA256-signed by `MCP_TOKEN_SECRET` (`apps/backend/src/mcp/auth.ts`) — no
token store. Mint one per consumer:

```bash
# host (reads MCP_TOKEN_SECRET from .env)
pnpm --filter @bbstat/backend mcp:mint-token <consumer> [--days N | --no-expiry]

# in the container (distroless → pass the script path, no `node` prefix)
docker compose run --rm mcp dist/scripts/mint-mcp-token.js <consumer> --days 90
```

The token (a `v1.…` string) goes to stdout; hand it to the consumer as
`Authorization: Bearer <token>`. Default lifetime is 365 days.

> **Revocation** today is coarse: rotating `MCP_TOKEN_SECRET` invalidates _every_
> issued token at once. Per-token revocation would be a DB-backed follow-up. The
> `consumer` label is for audit only (it appears in the authorized-request log
> line); it does not scope access.

## TLS

Follows the **same toggle as the API** (`BACKEND_TLS`):

- **Host dev** (`BACKEND_TLS=on`, the default) — the mcp process terminates
  HTTPS itself using the shared `bbstat.localhost` cert (`TLS_KEY_PATH` /
  `TLS_CERT_PATH`). URL: `https://bbstat.localhost:8090/mcp`.
- **Container / prod** (`BACKEND_TLS=off`, pinned by the image) — plain HTTP;
  the reverse proxy terminates TLS (Traefik at `https://mcp.localhost:18443/mcp`
  under `make up`; your proxy in prod).

> **Self-signed cert + Node clients.** Claude Code / the Inspector are Node
> processes, and Node doesn't read your OS trust store — so they reject the dev
> cert even though your browser trusts it. Point Node at the CA:
> `NODE_EXTRA_CA_CERTS=$(pwd)/etc/tls/ca.crt`. In prod (real cert) this is moot.

## Running it

**Host hot-reload** (fastest for iterating):

```bash
make up-deps      # pg + redis
make dev-mcp      # tsx watch → https://bbstat.localhost:8090/mcp
```

**Containerized** (full parity, the actual `mcp` service):

```bash
make build-images && make up   # mcp behind Traefik at https://mcp.localhost:18443/mcp
make logs-mcp
```

Both require `MCP_TOKEN_SECRET` (in `.env` for host / `make up`; in the shell env
for a `-f compose.yaml` prod deploy). The entrypoint fail-louds without it.

## Connecting a client

**curl smoke** (auth + handshake):

```bash
TOKEN=$(pnpm --filter @bbstat/backend --silent mcp:mint-token smoke)
BASE=https://bbstat.localhost:8090     # add --cacert etc/tls/ca.crt for the dev cert
curl --cacert etc/tls/ca.crt "$BASE/healthz"                       # {"status":"ok",…}
curl --cacert etc/tls/ca.crt -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

**MCP Inspector** (click through the tools, no client code):

```bash
NODE_EXTRA_CA_CERTS=$(pwd)/etc/tls/ca.crt npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: https://bbstat.localhost:8090/mcp
# Header: Authorization = Bearer <token>
```

**Claude Code** (register once; it's a config write that then exits — start a
fresh `claude` session to use it):

```bash
claude mcp add --transport http bbstat https://bbstat.localhost:8090/mcp \
  --header "Authorization: Bearer <token>"
# then, so Node trusts the dev cert:
NODE_EXTRA_CA_CERTS=$(pwd)/etc/tls/ca.crt claude
#   /mcp   → see bbstat + its tools
```

Re-`add` only when the **URL or token changes** (e.g. switching host↔container,
or rotating the secret) — a server restart alone just needs a fresh session.

## Configuration

| Variable           | Default            | Notes                                                                               |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------- |
| `MCP_TOKEN_SECRET` | — (required)       | HMAC signing key. Shell-provided like other secrets; never in `.env.docker`.        |
| `MCP_HOST`         | `bbstat.localhost` | Bind host (mirrors `BACKEND_HOST`). The compose service overrides to `0.0.0.0`.     |
| `MCP_PORT`         | `8090`             | In-container listen port.                                                           |
| `MCP_HOST_PORT`    | `8090`             | Host port the `mcp` compose service publishes.                                      |
| `BACKEND_TLS`      | `on`               | Shared with the API — `on` = in-process HTTPS, `off` = plain HTTP behind the proxy. |

## Security

The endpoint is meant to be reachable by agents, so unlike the dashboard (which
is intentionally auth-less) it **requires a bearer token** — that's why the
server refuses to start without `MCP_TOKEN_SECRET`. It is strictly read-only:
every tool advertises `readOnlyHint`, there is no admin / sync / write surface,
and nothing it exposes can mutate state or spend the BitBucket API budget. When
exposing it publicly, front it with your reverse proxy (TLS) and treat the
tokens as credentials.

## Extending

Add a tool without touching the server or transport:

1. Create `tools/<group>.ts` (or extend one) with `defineTool({ name, title,
description, inputShape, handler })`. The handler gets the `StatsStore` and
   validated args, and returns plain JSON. Throw `ToolError` for expected
   not-found / bad-input (the server maps it to an `isError` result).
2. Add it to the array in `tools/registry.ts`.

That's it — the server registers every entry in the registry. Keep tools
read-only and over the store; aggregation belongs in `stats-store` / the sync
layer, not here.

## Tests

`apps/backend/src/mcp/*.test.ts` — all run under Vitest with no network/DB:

- `auth.test.ts` — token sign/verify, expiry, tamper, bearer parsing.
- `tools/tools.test.ts` — each tool handler against a fake `StatsStore`.
- `server.test.ts` — an in-memory MCP `Client` ↔ server (list + call tools).
- `transport.test.ts` — Fastify `inject`: the bearer gate and method routing.
