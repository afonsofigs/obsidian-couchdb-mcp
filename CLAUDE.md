# CLAUDE.md

## What is this?

A self-hosted MCP server for reading and writing Obsidian notes via CouchDB (LiveSync). Seven tools: `read_note`, `list_notes`, `search_notes`, `write_note`, `delete_note`, `get_note_metadata`, `recent_notes`. Protected by OAuth 2.1 with credentials derived from MCP_SECRET.

## Stack

- Node.js (ESM), single file: `server.js`
- `@modelcontextprotocol/sdk` — MCP protocol, OAuth handlers, Streamable HTTP transport
- Native `fetch` — CouchDB HTTP API (no external CouchDB library)
- `express` — HTTP server
- `zod` — schema validation

## Project structure

```
server.js          — All server code (CouchDB client, OAuth provider, MCP tools, Express app)
package.json       — Dependencies
Dockerfile         — Container build
.github/workflows/ — CI/CD to ghcr.io
```

## Running locally

```bash
npm install
COUCHDB_URL=https://obsidian-db.boathouse.group COUCHDB_DATABASE=obsidian \
COUCHDB_USER=user COUCHDB_PASSWORD=pass MCP_SECRET=secret \
SERVER_URL=http://localhost:3000 node server.js
```

## Key design decisions

- **Same pattern as telegram-bot-mcp** — OAuth 2.1 in-memory, fixed client credentials, auto-approve, Streamable HTTP.
- **MCP_SECRET instead of BOT_TOKEN** — OAuth credentials derived from a dedicated secret (not tied to any external service).
- **Native fetch for CouchDB** — No npm CouchDB library needed. Node 24 has native fetch.
- **LiveSync format support** — Handles both "plain" (data inline) and "newnote" (chunked children) document types.
- **Chunk cleanup on write** — When overwriting a "newnote" doc, deletes orphaned child chunks.
- **Writes as "plain" type** — New/updated notes use simple inline data (not chunked). LiveSync handles replication.

## Common tasks

### Add a new tool
Add another `server.tool()` call in the `createMcpServer()` function.

### Change OAuth token expiry
In `OAuthProvider.exchangeAuthorizationCode()`, change `expiresIn` (default: 86400 = 24h).

### Test locally
```bash
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/oauth-authorization-server
```

## CI/CD

Push to `main` triggers GitHub Actions:
1. Builds Docker image
2. Pushes to `ghcr.io/<owner>/obsidian-couchdb-mcp:latest` + SHA tag
