# CLAUDE.md

## What is this?

A self-hosted MCP server for reading and writing Obsidian notes via CouchDB (LiveSync). OAuth 2.1 wrapper around `obsidian-sync-mcp`'s vault backend, which uses `livesync-commonlib` for correct LiveSync format handling.

Eight tools: `read_note`, `write_note`, `delete_note`, `move_note`, `list_notes`, `search_notes`, `get_note_metadata`, `recent_notes`.

## Stack

- `obsidian-sync-mcp` — LiveSync vault backend (livesync-commonlib, PouchDB, chunk handling, E2E encryption)
- `@modelcontextprotocol/sdk` — MCP protocol, OAuth 2.1, Streamable HTTP transport
- `express` — HTTP server
- `zod` — schema validation

## Project structure

```
server.js          — OAuth 2.1 provider + MCP tools (wrapping obsidian-sync-mcp Vault)
package.json       — Dependencies
Dockerfile         — Container build (Node 24 Alpine)
k8s/               — Kubernetes manifests (template only, real secrets in K8sConfigs)
.github/workflows/ — CI/CD to ghcr.io
```

## Architecture

```
Claude.ai (OAuth 2.1 + Streamable HTTP)
  → server.js (OAuth provider + MCP SDK)
    → obsidian-sync-mcp Vault class
      → livesync-commonlib (chunks, encryption, format)
        → CouchDB (LiveSync replication)
          → Obsidian Desktop/Mobile
```

## Running locally

```bash
npm install
COUCHDB_URL=http://localhost:5984 COUCHDB_DATABASE=obsidian \
COUCHDB_USERNAME=user COUCHDB_PASSWORD=pass MCP_SECRET=secret \
SERVER_URL=http://localhost:3000 node server.js
```

## Key design decisions

- **OAuth 2.1 wrapper** — obsidian-sync-mcp uses FastMCP with password auth, incompatible with Claude.ai connectors. We wrap their Vault backend with our OAuth 2.1 (same pattern as telegram-bot-mcp).
- **livesync-commonlib** — All CouchDB document handling (chunks, soft-deletes, encryption, path normalization) delegated to the official library. No manual format implementation.
- **Node 24** — Required by obsidian-sync-mcp/livesync-commonlib.
- **Internal import** — `obsidian-sync-mcp/dist/vault-*.js` is imported directly since the package doesn't export the Vault class publicly.

## Common tasks

### Add a new tool
Add another `server.tool()` call in `createMcpServer()`, using `vault.*` methods.

### Change OAuth token expiry
In `OAuthProvider.exchangeAuthorizationCode()`, change `expiresIn` (default: 86400 = 24h).

### Test locally
```bash
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/oauth-authorization-server
```

## CI/CD

Push to `main` triggers GitHub Actions → `ghcr.io/afonsofigs/obsidian-couchdb-mcp:latest`
