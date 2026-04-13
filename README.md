# obsidian-couchdb-mcp

Self-hosted [MCP](https://modelcontextprotocol.io/) server for reading and writing [Obsidian](https://obsidian.md/) notes via [CouchDB](https://couchdb.apache.org/) (used by [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)). Designed as a remote connector for [Claude.ai](https://claude.ai) scheduled tasks, but works with any MCP client.

## Why?

Obsidian is a local-first app — but with LiveSync + CouchDB, your vault is already replicated to a database. This MCP server lets Claude scheduled tasks read and write your notes without needing the Obsidian desktop app open.

## Features

- **7 tools**: `read_note`, `list_notes`, `search_notes`, `write_note`, `delete_note`, `get_note_metadata`, `recent_notes`
- **OAuth 2.1**: Fixed client credentials — no separate passwords needed
- **Streamable HTTP**: `/mcp` endpoint for remote MCP connections
- **LiveSync compatible**: Handles both plain and chunked (newnote) document formats
- **Docker**: Ready to deploy on K8s, Fly.io, Railway, etc.
- **Zero CouchDB dependencies**: Uses native Node.js `fetch`

## Quick Start

### 1. Prerequisites

- CouchDB instance with Obsidian LiveSync data (e.g., `obsidian-db.boathouse.group`)
- CouchDB credentials (username + password)

### 2. Run with Docker

```bash
docker run -d \
  -e COUCHDB_URL=https://obsidian-db.boathouse.group \
  -e COUCHDB_DATABASE=obsidian \
  -e COUCHDB_USER=your_user \
  -e COUCHDB_PASSWORD=your_password \
  -e MCP_SECRET=your_secret_here \
  -e SERVER_URL=https://your-domain.com \
  -p 3000:3000 \
  ghcr.io/afonsofigs/obsidian-couchdb-mcp:latest
```

### 3. Run with Node.js

```bash
git clone https://github.com/afonsofigs/obsidian-couchdb-mcp.git
cd obsidian-couchdb-mcp
npm install

COUCHDB_URL=https://obsidian-db.boathouse.group \
COUCHDB_DATABASE=obsidian \
COUCHDB_USER=your_user \
COUCHDB_PASSWORD=your_password \
MCP_SECRET=your_secret_here \
SERVER_URL=https://your-domain.com \
node server.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COUCHDB_URL` | Yes | CouchDB base URL (e.g., `https://obsidian-db.boathouse.group`) |
| `MCP_SECRET` | Yes | Secret used to derive OAuth credentials (printed on startup) |
| `COUCHDB_DATABASE` | No | Database name (default: `obsidian`) |
| `COUCHDB_USER` | No | CouchDB username (for authenticated instances) |
| `COUCHDB_PASSWORD` | No | CouchDB password |
| `SERVER_URL` | Yes | Public HTTPS URL of this server (used as OAuth issuer) |
| `PORT` | No | Server port (default: 3000) |

## MCP Tools

### `read_note`
Read an Obsidian note by its path. Handles both plain and chunked (newnote) formats.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Note path relative to vault root |

### `list_notes`
List notes in the vault. Optionally filter by folder or extension.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | No | Folder prefix to filter |
| `markdown_only` | boolean | No | Only .md files (default: true) |
| `limit` | number | No | Max results (default: 100) |

### `search_notes`
Search notes by content (case-insensitive). Returns paths and excerpts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Text to search for |
| `folder` | string | No | Restrict to folder prefix |
| `limit` | number | No | Max results (default: 20) |

### `write_note`
Create or update a note. Writes directly to CouchDB — LiveSync propagates to devices.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Note path relative to vault root |
| `content` | string | Yes | Full markdown content |

### `delete_note`
Delete a note (and its chunks if chunked).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Note path to delete |

### `get_note_metadata`
Get metadata (timestamps, size, type, revision) without fetching content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Note path |

### `recent_notes`
List recently modified notes, sorted by modification time (newest first).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Max results (default: 20) |
| `folder` | string | No | Restrict to folder prefix |

## Authentication

Same pattern as [telegram-bot-mcp](https://github.com/afonsofigs/telegram-bot-mcp):

- **Fixed client credentials** — `client_id` and `client_secret` derived from `MCP_SECRET` via SHA-256. Printed to stdout on startup.
- **Auto-approve** — No login page. Security enforced by fixed credentials.
- **PKCE** (S256) — Mandatory for all clients.
- **Redirect URI validation** — Only `claude.ai` and `claude.com` callbacks accepted.

## Claude.ai Connector Setup

1. Deploy this server with HTTPS (e.g., behind Cloudflare Tunnel)
2. Check the server logs for `client_id` and `client_secret`
3. Go to [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
4. Click **Add custom connector**
5. Enter the URL: `https://your-domain.com/mcp`
6. Enter the `client_id` and `client_secret` from the logs
7. The connector links automatically — available in conversations and scheduled tasks

## Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /health` | No | Health check (also checks CouchDB connectivity) |
| `GET /.well-known/oauth-authorization-server` | No | OAuth metadata (RFC 8414) |
| `GET /.well-known/oauth-protected-resource` | No | Protected resource metadata (RFC 9728) |
| `POST /register` | No | Client registration (returns fixed client) |
| `GET /authorize` | No | OAuth authorization (auto-approve) |
| `POST /token` | No | Token exchange |
| `POST /revoke` | Bearer | Token revocation |
| `POST /mcp` | Bearer | Streamable HTTP — MCP requests |
| `GET /mcp` | Bearer | Streamable HTTP — server notifications |
| `DELETE /mcp` | Bearer | Session termination |

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: obsidian-mcp
  namespace: obsidian-ns
spec:
  replicas: 1
  selector:
    matchLabels:
      app: obsidian-mcp
  template:
    metadata:
      labels:
        app: obsidian-mcp
    spec:
      containers:
        - name: obsidian-mcp
          image: ghcr.io/afonsofigs/obsidian-couchdb-mcp:latest
          ports:
            - containerPort: 3000
          env:
            - name: COUCHDB_URL
              value: "http://couchdb.obsidian-ns.svc.cluster.local:5984"
            - name: COUCHDB_DATABASE
              value: "obsidian"
            - name: COUCHDB_USER
              valueFrom:
                secretKeyRef:
                  name: obsidian-mcp-secrets
                  key: COUCHDB_USER
            - name: COUCHDB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: obsidian-mcp-secrets
                  key: COUCHDB_PASSWORD
            - name: MCP_SECRET
              valueFrom:
                secretKeyRef:
                  name: obsidian-mcp-secrets
                  key: MCP_SECRET
            - name: SERVER_URL
              value: "https://obsidian-mcp.boathouse.group"
---
apiVersion: v1
kind: Service
metadata:
  name: obsidian-mcp
  namespace: obsidian-ns
spec:
  selector:
    app: obsidian-mcp
  ports:
    - port: 3000
      targetPort: 3000
```

Deploy in the same namespace as CouchDB for direct cluster access. Expose via Cloudflare Tunnel for Claude.ai.

## Architecture

```
Claude.ai / MCP Client
        |
        v (HTTPS + OAuth 2.1 + Streamable HTTP)
  obsidian-couchdb-mcp
        |
        v (HTTP / CouchDB API)
  CouchDB (LiveSync)
        |
        v (replication)
  Obsidian Desktop/Mobile
```

## License

MIT
