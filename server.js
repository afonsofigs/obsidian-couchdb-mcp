import { randomUUID, createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import { z } from "zod";

// --- Configuration ---

const COUCHDB_URL = process.env.COUCHDB_URL;
const COUCHDB_DATABASE = process.env.COUCHDB_DATABASE || "obsidian";
const COUCHDB_USER = process.env.COUCHDB_USERNAME || process.env.COUCHDB_USER || "";
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || "";
const MCP_SECRET = process.env.MCP_SECRET;
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

if (!COUCHDB_URL) {
  console.error("Error: COUCHDB_URL environment variable is required");
  process.exit(1);
}
if (!MCP_SECRET) {
  console.error("Error: MCP_SECRET environment variable is required");
  process.exit(1);
}

// --- CouchDB Client (native fetch) ---

const couchBaseUrl = `${COUCHDB_URL}/${encodeURIComponent(COUCHDB_DATABASE)}`;
const couchHeaders = { "Content-Type": "application/json" };

if (COUCHDB_USER) {
  couchHeaders["Authorization"] =
    "Basic " + Buffer.from(`${COUCHDB_USER}:${COUCHDB_PASSWORD}`).toString("base64");
}

async function couchFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `${couchBaseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...couchHeaders, ...options.headers },
  });
  const body = await res.json();
  if (!res.ok && res.status !== 404) {
    throw new Error(`CouchDB ${res.status}: ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

// --- LiveSync Document Helpers ---

// LiveSync document types:
//   "plain"   — metadata doc, content inline in `data` field
//   "newnote" — metadata doc, content split across chunk docs referenced by `children`
//   "leaf"    — chunk doc containing a `data` fragment (type "leaf", id is content hash)
// Special fields:
//   `eden`     — Record<string, EdenChunk> for inline chunks (newer format)
//   `path`     — FilePathWithPrefix (may differ from _id in obfuscation/case-insensitive mode)
//   `children` — array of chunk document IDs
// Fixed IDs to ignore: "obsydian_livesync_version", "syncinfo"

async function readNoteContent(doc) {
  // If doc has children, content is in chunks — regardless of type field
  const hasChildren = Array.isArray(doc.children) && doc.children.length > 0;

  if (!hasChildren) {
    // No chunks: content is inline in data field
    return doc.data || "";
  }

  // Check eden (inline chunks embedded in the doc itself) first
  if (doc.eden && Object.keys(doc.eden).length > 0) {
    const edenChunks = [];
    for (const childId of doc.children) {
      if (doc.eden[childId]) {
        edenChunks.push(doc.eden[childId].data || "");
      } else {
        // Fall back to fetching from CouchDB
        const { status, body } = await couchFetch(`/${encodeURIComponent(childId)}`);
        edenChunks.push(status === 404 ? "[missing chunk]" : body.data || "");
      }
    }
    return edenChunks.join("");
  }

  // Reassemble from children chunk documents in CouchDB
  const chunks = [];
  for (const childId of doc.children) {
    const { status, body } = await couchFetch(`/${encodeURIComponent(childId)}`);
    if (status === 404) {
      chunks.push("[missing chunk]");
    } else {
      chunks.push(body.data || "");
    }
  }
  return chunks.join("");
}

// Create leaf chunk documents in CouchDB for note content.
// LiveSync ALWAYS stores content in chunks — the metadata doc's `data` field must be empty.
// Returns array of chunk document IDs.
async function writeChunks(content) {
  // Split into ~250KB chunks (CouchDB max_document_size is typically 50MB, but smaller is better for sync)
  const CHUNK_SIZE = 250_000;
  const chunkIds = [];

  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    const chunkData = content.slice(i, i + CHUNK_SIZE);
    // Generate chunk ID using content hash (same as LiveSync: h: prefix + hash)
    const hash = createHash("sha1").update(chunkData).digest("hex").slice(0, 12);
    const chunkId = `h:${hash}${i.toString(36)}`;

    // Check if chunk already exists (content-addressable)
    const { status } = await couchFetch(`/${encodeURIComponent(chunkId)}`);
    if (status !== 200) {
      await couchFetch(`/${encodeURIComponent(chunkId)}`, {
        method: "PUT",
        body: JSON.stringify({
          _id: chunkId,
          data: chunkData,
          type: "leaf",
        }),
      });
    }
    chunkIds.push(chunkId);
  }

  return chunkIds;
}

// Sanitize a path for use as CouchDB _id: lowercase, no accents.
// LiveSync case-insensitive mode requires lowercase _id.
// Accented characters in filenames can cause filesystem issues when LiveSync creates files.
function sanitizePath(path) {
  return path
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // strip combining diacritical marks
}

// Resolve a note path to its CouchDB document.
// LiveSync case-insensitive mode stores _id in lowercase but path in original case.
// Try exact _id first, then fall back to lowercase _id.
async function resolveNote(path) {
  // Try exact path first
  const { status, body } = await couchFetch(`/${encodeURIComponent(path)}`);
  if (status === 200) return { status, body };

  // Try sanitized (lowercase + no accents)
  const sanitized = sanitizePath(path);
  if (sanitized !== path) {
    const { status: s2, body: b2 } = await couchFetch(`/${encodeURIComponent(sanitized)}`);
    if (s2 === 200) return { status: s2, body: b2 };
  }

  // Try just lowercase (for docs with accents in _id)
  const lower = path.toLowerCase();
  if (lower !== path && lower !== sanitized) {
    const { status: s3, body: b3 } = await couchFetch(`/${encodeURIComponent(lower)}`);
    if (s3 === 200) return { status: s3, body: b3 };
  }

  return { status: 404, body: null };
}

// LiveSync internal doc IDs to exclude from note listings
const INTERNAL_IDS = new Set([
  "obsydian_livesync_version",
  "syncinfo",
]);

function isNote(docId) {
  if (docId.startsWith("_")) return false;       // CouchDB system docs (_design, _local)
  if (docId.startsWith("h:")) return false;       // Chunk/leaf documents
  if (docId.startsWith("ps:")) return false;      // Plugin settings sync
  if (docId.startsWith("ix:")) return false;      // Index documents
  if (docId.startsWith("cc:")) return false;      // Conflict check docs
  if (docId.startsWith("f:")) return false;       // Obfuscated path docs (avoid duplicates)
  if (INTERNAL_IDS.has(docId)) return false;      // Fixed internal docs
  return true;
}

function isMarkdown(docId) {
  return docId.endsWith(".md");
}

// --- OAuth 2.1 Provider (in-memory, same pattern as telegram-bot-mcp) ---

const FIXED_CLIENT_ID = createHash("sha256").update(`${MCP_SECRET}:client_id`).digest("hex").slice(0, 36);
const FIXED_CLIENT_SECRET = createHash("sha256").update(`${MCP_SECRET}:client_secret`).digest("hex");

class ClientsStore {
  constructor() {
    this.client = {
      client_id: FIXED_CLIENT_ID,
      client_secret: FIXED_CLIENT_SECRET,
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ],
      client_name: "Claude",
      token_endpoint_auth_method: "client_secret_post",
    };
  }
  async getClient(clientId) {
    return clientId === FIXED_CLIENT_ID ? this.client : undefined;
  }
  async registerClient(_metadata) {
    return this.client;
  }
}

class OAuthProvider {
  constructor() {
    this.clientsStore = new ClientsStore();
    this.codes = new Map();
    this.tokens = new Map();
  }

  async authorize(client, params, res) {
    console.log(`[oauth] authorize: client=${client.client_id} redirect=${params.redirectUri}`);
    const code = randomUUID();
    this.codes.set(code, { client, params, createdAt: Date.now() });
    const searchParams = new URLSearchParams({ code });
    if (params.state) searchParams.set("state", params.state);
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(_client, code) {
    const data = this.codes.get(code);
    if (!data) throw new Error("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier) {
    console.log(`[oauth] exchangeCode: client=${client.client_id} code=${code.slice(0, 8)}...`);
    const data = this.codes.get(code);
    if (!data) throw new Error("Invalid authorization code");
    if (data.client.client_id !== client.client_id) throw new Error("Client mismatch");
    this.codes.delete(code);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 86400;

    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      expiresAt: Date.now() + expiresIn * 1000,
      resource: data.params.resource,
    });
    this.tokens.set(refreshToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      type: "refresh",
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (data.params.scopes || []).join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, _resource) {
    const data = this.tokens.get(refreshToken);
    if (!data || data.type !== "refresh") throw new Error("Invalid refresh token");
    if (data.clientId !== client.client_id) throw new Error("Client mismatch");
    this.tokens.delete(refreshToken);

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const expiresIn = 86400;

    this.tokens.set(newAccessToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    this.tokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      type: "refresh",
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      scope: (scopes || data.scopes).join(" "),
    };
  }

  async verifyAccessToken(token) {
    console.log(`[oauth] verifyToken: ${token.slice(0, 8)}...`);
    const data = this.tokens.get(token);
    if (!data || data.type === "refresh") throw new Error("Invalid token");
    if (data.expiresAt && data.expiresAt < Date.now()) {
      this.tokens.delete(token);
      throw new Error("Token expired");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt ? Math.floor(data.expiresAt / 1000) : undefined,
      resource: data.resource,
    };
  }

  async revokeToken(token) {
    this.tokens.delete(token);
  }
}

// --- MCP Server (Obsidian CouchDB tools) ---

function createMcpServer() {
  const server = new McpServer({ name: "obsidian-couchdb-mcp", version: "1.0.0" });

  // --- read_note ---
  server.tool(
    "read_note",
    "Read an Obsidian note by its path. Returns the full markdown content.",
    {
      path: z.string().describe("Note path relative to vault root (e.g. 'Daily/2026-04-13.md')"),
    },
    async ({ path }) => {
      try {
        const { status, body } = await resolveNote(path);
        if (status === 404) {
          return { content: [{ type: "text", text: `Note not found: ${path}` }], isError: true };
        }
        const text = await readNoteContent(body);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error reading note: ${err.message}` }], isError: true };
      }
    }
  );

  // --- list_notes ---
  server.tool(
    "list_notes",
    "List notes in the Obsidian vault. Optionally filter by folder prefix or extension.",
    {
      folder: z.string().optional().describe("Folder prefix to filter (e.g. 'Projects/'). Lists all if omitted."),
      markdown_only: z.boolean().optional().describe("Only list .md files (default: true)"),
      limit: z.number().optional().describe("Max results (default: 100)"),
    },
    async ({ folder, markdown_only, limit }) => {
      try {
        const mdOnly = markdown_only !== false;
        const maxResults = limit || 100;

        const { body } = await couchFetch("/_all_docs?include_docs=false");
        if (!body.rows) {
          return { content: [{ type: "text", text: "No documents found" }] };
        }

        let notes = body.rows
          .map((r) => r.id)
          .filter(isNote);

        if (mdOnly) notes = notes.filter(isMarkdown);
        if (folder) notes = notes.filter((id) => id.startsWith(folder));

        const total = notes.length;
        notes = notes.slice(0, maxResults);

        const result = notes.join("\n");
        const summary = total > maxResults
          ? `Showing ${maxResults} of ${total} notes:\n${result}`
          : `${total} notes:\n${result}`;

        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error listing notes: ${err.message}` }], isError: true };
      }
    }
  );

  // --- search_notes ---
  server.tool(
    "search_notes",
    "Search Obsidian notes by content. Returns matching note paths and excerpts.",
    {
      query: z.string().describe("Text to search for (case-insensitive)"),
      folder: z.string().optional().describe("Restrict search to this folder prefix"),
      limit: z.number().optional().describe("Max results (default: 20)"),
    },
    async ({ query, folder, limit }) => {
      try {
        const maxResults = limit || 20;
        const queryLower = query.toLowerCase();

        // Get all note docs (include_docs=true so we can search content)
        const { body } = await couchFetch("/_all_docs?include_docs=true");
        if (!body.rows) {
          return { content: [{ type: "text", text: "No documents found" }] };
        }

        const matches = [];
        for (const row of body.rows) {
          if (matches.length >= maxResults) break;
          if (!row.doc || !isNote(row.id) || !isMarkdown(row.id)) continue;
          if (folder && !row.id.startsWith(folder)) continue;

          // For plain docs, search data directly
          // For newnote, we only search if data is available (avoid fetching all chunks)
          const data = row.doc.data || "";
          if (!data) continue;

          const idx = data.toLowerCase().indexOf(queryLower);
          if (idx === -1) continue;

          // Extract excerpt around match
          const start = Math.max(0, idx - 80);
          const end = Math.min(data.length, idx + query.length + 80);
          const excerpt = (start > 0 ? "..." : "") + data.slice(start, end) + (end < data.length ? "..." : "");

          matches.push({ path: row.doc.path || row.id, excerpt });
        }

        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No notes matching "${query}"` }] };
        }

        const result = matches
          .map((m) => `## ${m.path}\n${m.excerpt}`)
          .join("\n\n");

        return { content: [{ type: "text", text: `${matches.length} match(es):\n\n${result}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error searching: ${err.message}` }], isError: true };
      }
    }
  );

  // --- write_note ---
  server.tool(
    "write_note",
    "Create or update an Obsidian note. Writes directly to CouchDB — LiveSync propagates to devices.",
    {
      path: z.string().describe("Note path relative to vault root (e.g. 'Projects/idea.md')"),
      content: z.string().describe("Full markdown content for the note"),
    },
    async ({ path, content: noteContent }) => {
      try {
        const now = Date.now();

        // Strip accents from path (accented filenames cause sync issues)
        // Keep casing for path field, lowercase for _id
        const stripAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const safePath = stripAccents(path);

        // Check if doc already exists (need _rev for update)
        const { status, body: existing } = await resolveNote(path);
        const docId = (status === 200 && existing._id) ? existing._id : sanitizePath(path);

        // LiveSync requires content in chunk documents — metadata data field must be empty
        const children = await writeChunks(noteContent);

        // LiveSync MetadataDocument format
        const doc = {
          _id: docId,
          path: safePath,
          data: "",
          ctime: existing?.ctime || now,
          mtime: now,
          size: Buffer.byteLength(noteContent, "utf-8"),
          type: "plain",
          children: children,
          eden: {},
        };

        if (status === 200 && existing._rev) {
          doc._rev = existing._rev;
        }

        const { status: putStatus, body: putBody } = await couchFetch(`/${encodeURIComponent(docId)}`, {
          method: "PUT",
          body: JSON.stringify(doc),
        });

        if (putBody.ok) {
          const action = status === 200 ? "Updated" : "Created";
          return { content: [{ type: "text", text: `${action}: ${path} (rev: ${putBody.rev})` }] };
        }

        return {
          content: [{ type: "text", text: `CouchDB error: ${JSON.stringify(putBody)}` }],
          isError: true,
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error writing note: ${err.message}` }], isError: true };
      }
    }
  );

  // --- delete_note ---
  server.tool(
    "delete_note",
    "Delete an Obsidian note from the vault.",
    {
      path: z.string().describe("Note path to delete (e.g. 'Scratch/temp.md')"),
    },
    async ({ path }) => {
      try {
        const { status, body } = await resolveNote(path);
        if (status === 404) {
          return { content: [{ type: "text", text: `Note not found: ${path}` }], isError: true };
        }

        // Only delete the metadata doc — chunks are immutable and shared.
        // LiveSync handles chunk garbage collection.
        const { body: delBody } = await couchFetch(
          `/${encodeURIComponent(body._id)}?rev=${body._rev}`,
          { method: "DELETE" }
        );

        if (delBody.ok) {
          return { content: [{ type: "text", text: `Deleted: ${path}` }] };
        }

        return {
          content: [{ type: "text", text: `CouchDB error: ${JSON.stringify(delBody)}` }],
          isError: true,
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error deleting note: ${err.message}` }], isError: true };
      }
    }
  );

  // --- get_note_metadata ---
  server.tool(
    "get_note_metadata",
    "Get metadata (timestamps, size, type) for a note without fetching its full content.",
    {
      path: z.string().describe("Note path relative to vault root"),
    },
    async ({ path }) => {
      try {
        const { status, body } = await resolveNote(path);
        if (status === 404) {
          return { content: [{ type: "text", text: `Note not found: ${path}` }], isError: true };
        }
        const meta = {
          id: body._id,
          path: body.path || body._id,
          rev: body._rev,
          type: body.type || "plain",
          size: body.size || 0,
          ctime: body.ctime ? new Date(body.ctime).toISOString() : null,
          mtime: body.mtime ? new Date(body.mtime).toISOString() : null,
          children: body.children ? body.children.length : 0,
          deleted: body.deleted || false,
        };
        return { content: [{ type: "text", text: JSON.stringify(meta, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- recent_notes ---
  server.tool(
    "recent_notes",
    "List recently modified notes, sorted by modification time (newest first).",
    {
      limit: z.number().optional().describe("Max results (default: 20)"),
      folder: z.string().optional().describe("Restrict to this folder prefix"),
    },
    async ({ limit, folder }) => {
      try {
        const maxResults = limit || 20;

        const { body } = await couchFetch("/_all_docs?include_docs=true");
        if (!body.rows) {
          return { content: [{ type: "text", text: "No documents found" }] };
        }

        let notes = body.rows
          .filter((r) => r.doc && isNote(r.id) && isMarkdown(r.id))
          .map((r) => ({ path: r.id, mtime: r.doc.mtime || 0 }));

        if (folder) notes = notes.filter((n) => n.path.startsWith(folder));

        notes.sort((a, b) => b.mtime - a.mtime);
        notes = notes.slice(0, maxResults);

        const result = notes
          .map((n) => `${new Date(n.mtime).toISOString().slice(0, 16)}  ${n.path}`)
          .join("\n");

        return { content: [{ type: "text", text: result || "No notes found" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// --- Express App ---

const provider = new OAuthProvider();
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// Health (unauthenticated)
app.get("/health", async (_, res) => {
  try {
    const { status } = await couchFetch("/");
    res.json({ ok: status === 200, version: "1.0.0", couchdb: status === 200 });
  } catch {
    res.json({ ok: false, version: "1.0.0", couchdb: false });
  }
});

// OAuth endpoints
const issuerUrl = new URL(SERVER_URL);
app.use(mcpAuthRouter({
  provider,
  issuerUrl,
  scopesSupported: ["mcp:tools"],
}));

// Streamable HTTP transport for MCP
const transports = new Map();

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log(`[auth] ${req.method} ${req.path} auth=${authHeader ? authHeader.slice(0, 20) + "..." : "none"}`);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log(`[auth] no bearer token, sending 401`);
    res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "Missing token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const authInfo = await provider.verifyAccessToken(token);
    console.log(`[auth] accepted clientId=${authInfo.clientId}`);
    req.auth = authInfo;
    next();
  } catch (err) {
    console.log(`[auth] rejected: ${err.message}`);
    res.status(401).set("WWW-Authenticate", `Bearer error="invalid_token"`).json({ error: err.message });
  }
};

app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    console.log(`[mcp] POST session=${sessionId || "new"} body=${JSON.stringify(req.body).slice(0, 200)}`);
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
    } else {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
        console.log(`[mcp] new session: ${transport.sessionId}`);
      }
    }
  } catch (err) {
    console.error(`[mcp] POST error: ${err.message}\n${err.stack}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: "Missing or invalid session ID" });
  }
  await transports.get(sessionId).handleRequest(req, res);
});

app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId).handleRequest(req, res);
    transports.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`obsidian-couchdb-mcp listening on :${PORT}`);
  console.log(`CouchDB: ${COUCHDB_URL}/${COUCHDB_DATABASE}`);
  console.log(`OAuth issuer: ${SERVER_URL}`);
  console.log(`OAuth client_id: ${FIXED_CLIENT_ID}`);
  console.log(`OAuth client_secret: ${FIXED_CLIENT_SECRET}`);
  console.log(`MCP endpoint: ${SERVER_URL}/mcp (Streamable HTTP)`);
});
