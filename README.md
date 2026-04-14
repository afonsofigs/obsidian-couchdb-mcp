# obsidian-couchdb-mcp

OAuth 2.1 proxy for [obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp), making it compatible with [Claude.ai](https://claude.ai) remote connectors and scheduled tasks.

`obsidian-sync-mcp` provides excellent Obsidian vault access via CouchDB/LiveSync, but uses FastMCP with password auth — incompatible with Claude.ai connectors (which require OAuth 2.1). This project wraps it with OAuth 2.1 + Streamable HTTP in a single Docker image.

## Features

- **All obsidian-sync-mcp tools**: `read_note`, `write_note`, `edit_note`, `delete_note`, `move_note`, `list_notes`, `list_folders`, `list_tags`, `get_note_metadata`
- **OAuth 2.1**: Fixed client credentials — works with Claude.ai connectors and scheduled tasks
- **Dynamic tool discovery**: New tools from obsidian-sync-mcp updates appear automatically
- **LiveSync compatible**: Powered by [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) (chunks, encryption, soft-deletes)
- **Single Docker image**: Both OAuth proxy and backend in one container

## Quick Start

### Docker

```bash
docker run -d \
  -e COUCHDB_URL=https://your-couchdb.example.com \
  -e COUCHDB_DATABASE=obsidian \
  -e COUCHDB_USER=your_user \
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
COUCHDB_URL=http://localhost:5984 COUCHDB_DATABASE=obsidian \
COUCHDB_USER=admin COUCHDB_PASSWORD=password \
MCP_SECRET=your_secret SERVER_URL=http://localhost:3000 node server.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COUCHDB_URL` | Yes | CouchDB base URL |
| `MCP_SECRET` | Yes | Secret to derive OAuth credentials (printed on startup) |
| `COUCHDB_DATABASE` | No | Database name (default: `obsidian`) |
| `COUCHDB_USER` | No | CouchDB username |
| `COUCHDB_PASSWORD` | No | CouchDB password |
| `COUCHDB_PASSPHRASE` | No | LiveSync E2E encryption passphrase |
| `SERVER_URL` | Yes | Public HTTPS URL (OAuth issuer) |
| `PORT` | No | OAuth proxy port (default: 3000) |
| `BACKEND_PORT` | No | Backend port (default: 8787) |

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
  OAuth proxy :3000 (this project)
        |
        v (HTTP + MCP, localhost)
  obsidian-sync-mcp :8787 (livesync-commonlib)
        |
        v (CouchDB HTTP API)
  CouchDB (LiveSync replication)
        |
        v
  Obsidian Desktop/Mobile
```

## Credits

- [obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp) — Vault backend and LiveSync integration
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — Official LiveSync library
- [telegram-bot-mcp](https://github.com/afonsofigs/telegram-bot-mcp) — OAuth 2.1 pattern

## License

MIT
