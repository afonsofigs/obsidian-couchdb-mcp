# obsidian-couchdb-mcp

Self-hosted [MCP](https://modelcontextprotocol.io/) server for reading and writing [Obsidian](https://obsidian.md/) notes via [CouchDB](https://couchdb.apache.org/) ([Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)). Designed as a remote connector for [Claude.ai](https://claude.ai) scheduled tasks.

OAuth 2.1 wrapper around [obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp)'s vault backend, which uses [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) for correct LiveSync format handling (chunks, encryption, soft-deletes).

## Why?

`obsidian-sync-mcp` exists but uses FastMCP with password auth — incompatible with Claude.ai connectors (which require OAuth 2.1). This project wraps their vault backend with OAuth 2.1 + Streamable HTTP, making it work as a Claude.ai remote connector.

## Features

- **8 tools**: `read_note`, `write_note`, `delete_note`, `move_note`, `list_notes`, `search_notes`, `get_note_metadata`, `recent_notes`
- **OAuth 2.1**: Fixed client credentials — works with Claude.ai connectors and scheduled tasks
- **livesync-commonlib**: Official library for LiveSync document format (no manual chunk/format handling)
- **E2E encryption**: Supported via `COUCHDB_PASSPHRASE`
- **Docker**: Ready to deploy on K8s, Fly.io, Railway, etc.

## Quick Start

### Docker

```bash
docker run -d \
  -e COUCHDB_URL=https://your-couchdb.example.com \
  -e COUCHDB_DATABASE=obsidian \
  -e COUCHDB_USERNAME=your_user \
  -e COUCHDB_PASSWORD=your_password \
  -e MCP_SECRET=your_secret_here \
  -e SERVER_URL=https://your-domain.com \
  -p 3000:3000 \
  ghcr.io/afonsofigs/obsidian-couchdb-mcp:latest
```

### Node.js

```bash
git clone https://github.com/afonsofigs/obsidian-couchdb-mcp.git
cd obsidian-couchdb-mcp
npm install

COUCHDB_URL=http://localhost:5984 \
COUCHDB_DATABASE=obsidian \
COUCHDB_USERNAME=admin \
COUCHDB_PASSWORD=password \
MCP_SECRET=your_secret \
SERVER_URL=http://localhost:3000 \
node server.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COUCHDB_URL` | Yes | CouchDB base URL |
| `MCP_SECRET` | Yes | Secret to derive OAuth credentials (printed on startup) |
| `COUCHDB_DATABASE` | No | Database name (default: `obsidian`) |
| `COUCHDB_USERNAME` | No | CouchDB username |
| `COUCHDB_PASSWORD` | No | CouchDB password |
| `COUCHDB_PASSPHRASE` | No | LiveSync E2E encryption passphrase |
| `SERVER_URL` | Yes | Public HTTPS URL (OAuth issuer) |
| `PORT` | No | Server port (default: 3000) |

## MCP Tools

### `read_note`
Read a note by path. Handles chunked and encrypted documents via livesync-commonlib.

### `write_note`
Create or update a note. LiveSync propagates to all devices.

### `delete_note`
Delete a note (LiveSync soft-delete, propagates to all devices).

### `move_note`
Move or rename a note.

### `list_notes`
List notes, optionally filtered by folder prefix.

### `search_notes`
Full-text search across notes with excerpts.

### `get_note_metadata`
Get timestamps and size without fetching content.

### `recent_notes`
List recently modified notes, sorted by mtime.

## Authentication

Same pattern as [telegram-bot-mcp](https://github.com/afonsofigs/telegram-bot-mcp):

- **Fixed client credentials** derived from `MCP_SECRET` via SHA-256
- **Auto-approve** — no login page; security by fixed credentials
- **PKCE** (S256) mandatory
- **Redirect URIs** limited to `claude.ai` and `claude.com`

## Claude.ai Connector Setup

1. Deploy with HTTPS (e.g., behind Cloudflare Tunnel)
2. Check logs for `client_id` and `client_secret`
3. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
4. Add custom connector: URL `https://your-domain.com/mcp`
5. Enter `client_id` and `client_secret` from logs

## Architecture

```
Claude.ai / Scheduled Tasks
        |
        v (HTTPS + OAuth 2.1 + Streamable HTTP)
  obsidian-couchdb-mcp (OAuth wrapper)
        |
        v (obsidian-sync-mcp Vault + livesync-commonlib)
  CouchDB (LiveSync)
        |
        v (replication)
  Obsidian Desktop/Mobile
```

## Kubernetes

See `k8s/deployment.yaml` for a K8s manifest template. Real secrets should be managed separately.

## Credits

- [obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp) — Vault backend and LiveSync integration
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — Official LiveSync library
- [telegram-bot-mcp](https://github.com/afonsofigs/telegram-bot-mcp) — OAuth 2.1 pattern

## License

MIT
