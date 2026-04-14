# CLAUDE.md

## What is this?

OAuth 2.1 proxy for `obsidian-sync-mcp`. Adds Claude.ai connector compatibility (OAuth 2.1 + Streamable HTTP) to the obsidian-sync-mcp backend (which uses FastMCP with password auth, incompatible with Claude.ai connectors).

Single container runs two processes: our OAuth proxy (:3000) and obsidian-sync-mcp backend (:8787).

## Architecture

```
Claude.ai (OAuth 2.1 + Streamable HTTP)
  → server.js :3000 (OAuth provider + MCP SDK, tool proxy)
    → obsidian-sync-mcp :8787 (FastMCP + livesync-commonlib)
      → CouchDB (LiveSync replication)
        → Obsidian Desktop/Mobile
```

## How it works

1. server.js spawns obsidian-sync-mcp as child process on port 8787
2. On startup, discovers available tools via MCP tools/list call to backend
3. Registers each tool as a proxy in our MCP server
4. Claude.ai authenticates via OAuth 2.1 → calls our /mcp → we proxy to backend

## Stack

- `obsidian-sync-mcp` — LiveSync vault backend (livesync-commonlib, PouchDB, chunks, encryption, soft-deletes)
- `@modelcontextprotocol/sdk` — MCP protocol, OAuth 2.1, Streamable HTTP transport
- `express` + `zod` — HTTP server + schema validation

## Project structure

```
server.js          — OAuth 2.1 provider + tool proxy to backend
postinstall.js     — Patches obsidian-sync-mcp PouchDB adapter bug
package.json       — Dependencies
Dockerfile         — Single container (both processes)
k8s/               — Kubernetes deployment template
.github/workflows/ — CI/CD to ghcr.io
```

## Running locally

```bash
npm install
COUCHDB_URL=http://localhost:5984 COUCHDB_DATABASE=obsidian \
COUCHDB_USER=user COUCHDB_PASSWORD=pass MCP_SECRET=secret \
SERVER_URL=http://localhost:3000 node server.js
```

## Key design decisions

- **Proxy, not import** — obsidian-sync-mcp is designed as a CLI, not a library. Running it as a child process avoids PouchDB adapter conflicts and livesync-commonlib browser polyfill issues.
- **Dynamic tool discovery** — Tools are discovered from backend at startup via tools/list, not hardcoded. New tools from obsidian-sync-mcp updates appear automatically.
- **postinstall patch** — obsidian-sync-mcp has a bug where PouchDB is created without `adapter: "http"`. The patch adds it.

## CI/CD

Push to `main` triggers GitHub Actions → `ghcr.io/afonsofigs/obsidian-couchdb-mcp:latest`
