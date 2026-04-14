import { randomUUID, createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import { z } from "zod";

// Polyfills required by livesync-commonlib (browser globals)
if (!("navigator" in globalThis)) globalThis.navigator = { language: "en" };

// The vault's internal change watcher throws unhandled errors in headless mode.
// Catch them to prevent process crash — the core read/write APIs still work.
process.on("uncaughtException", (err) => {
  if (err.message?.includes("Only absolute URLs") || err.message?.includes("watching changes")) {
    console.log(`[vault] suppressed watcher error: ${err.message}`);
    return;
  }
  console.error("[fatal]", err);
  process.exit(1);
});

// --- Configuration ---

const COUCHDB_URL = process.env.COUCHDB_URL;
const COUCHDB_DATABASE = process.env.COUCHDB_DATABASE || "obsidian";
const COUCHDB_USER = process.env.COUCHDB_USERNAME || process.env.COUCHDB_USER || "";
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD || "";
const COUCHDB_PASSPHRASE = process.env.COUCHDB_PASSPHRASE || undefined;
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

// --- Vault backend (obsidian-sync-mcp + livesync-commonlib) ---

// Import Vault from obsidian-sync-mcp's compiled output
// The postinstall script patches the bundle to include adapter: "http"
// This handles all LiveSync format details: chunks, encryption, soft-deletes, etc.
const { Vault } = await import("obsidian-sync-mcp/dist/vault-5Y35MEZS.js");

const vault = new Vault({
  url: COUCHDB_URL,
  username: COUCHDB_USER,
  password: COUCHDB_PASSWORD,
  database: COUCHDB_DATABASE,
  passphrase: COUCHDB_PASSPHRASE,
});

try {
  await vault.init();
  console.log(`Vault connected: ${COUCHDB_URL}/${COUCHDB_DATABASE}`);
} catch (err) {
  // vault.init() may throw from watchChanges — the core API still works
  console.log(`Vault initialized with warning: ${err.message}`);
  console.log(`Vault: ${COUCHDB_URL}/${COUCHDB_DATABASE} (watch disabled)`);
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

// --- MCP Server (tools powered by Vault backend) ---

function createMcpServer() {
  const server = new McpServer({ name: "obsidian-couchdb-mcp", version: "2.0.0" });

  // --- read_note ---
  server.tool(
    "read_note",
    "Read an Obsidian note by its path. Returns the full markdown content.",
    { path: z.string().describe("Note path (e.g. 'Daily/2026-04-13.md')") },
    async ({ path }) => {
      try {
        const text = await vault.readNote(path);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- write_note ---
  server.tool(
    "write_note",
    "Create or update an Obsidian note. LiveSync propagates to all devices.",
    {
      path: z.string().describe("Note path (e.g. 'Projects/idea.md')"),
      content: z.string().describe("Full markdown content"),
    },
    async ({ path, content: noteContent }) => {
      try {
        await vault.writeNote(path, noteContent);
        return { content: [{ type: "text", text: `Written: ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- delete_note ---
  server.tool(
    "delete_note",
    "Delete an Obsidian note from the vault.",
    { path: z.string().describe("Note path to delete") },
    async ({ path }) => {
      try {
        await vault.deleteNote(path);
        return { content: [{ type: "text", text: `Deleted: ${path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- move_note ---
  server.tool(
    "move_note",
    "Move or rename an Obsidian note.",
    {
      old_path: z.string().describe("Current path"),
      new_path: z.string().describe("New path"),
    },
    async ({ old_path, new_path }) => {
      try {
        await vault.moveNote(old_path, new_path);
        return { content: [{ type: "text", text: `Moved: ${old_path} → ${new_path}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- list_notes ---
  server.tool(
    "list_notes",
    "List notes in the vault. Optionally filter by folder prefix.",
    {
      folder: z.string().optional().describe("Folder prefix to filter (e.g. 'Projects/')"),
      limit: z.number().optional().describe("Max results (default: 100)"),
    },
    async ({ folder, limit }) => {
      try {
        const maxResults = limit || 100;
        let notes = await vault.listNotes();

        if (folder) {
          const folderLower = folder.toLowerCase();
          notes = notes.filter((n) => n.path.toLowerCase().startsWith(folderLower));
        }

        const total = notes.length;
        notes = notes.slice(0, maxResults);

        const result = notes.map((n) => n.path).join("\n");
        const summary = total > maxResults
          ? `Showing ${maxResults} of ${total} notes:\n${result}`
          : `${total} notes:\n${result}`;

        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- search_notes ---
  server.tool(
    "search_notes",
    "Search Obsidian notes by content. Returns matching paths and excerpts.",
    {
      query: z.string().describe("Text to search for (case-insensitive)"),
      folder: z.string().optional().describe("Restrict to folder prefix"),
      limit: z.number().optional().describe("Max results (default: 20)"),
    },
    async ({ query, folder, limit }) => {
      try {
        const maxResults = limit || 20;
        const queryLower = query.toLowerCase();
        const allNotes = await vault.listNotes();

        let notes = allNotes;
        if (folder) {
          const folderLower = folder.toLowerCase();
          notes = notes.filter((n) => n.path.toLowerCase().startsWith(folderLower));
        }

        const matches = [];
        for (const note of notes) {
          if (matches.length >= maxResults) break;
          try {
            const content = await vault.readNote(note.path);
            const idx = content.toLowerCase().indexOf(queryLower);
            if (idx === -1) continue;

            const start = Math.max(0, idx - 80);
            const end = Math.min(content.length, idx + query.length + 80);
            const excerpt = (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
            matches.push({ path: note.path, excerpt });
          } catch { /* skip unreadable notes */ }
        }

        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No notes matching "${query}"` }] };
        }

        const result = matches.map((m) => `## ${m.path}\n${m.excerpt}`).join("\n\n");
        return { content: [{ type: "text", text: `${matches.length} match(es):\n\n${result}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- get_note_metadata ---
  server.tool(
    "get_note_metadata",
    "Get metadata (timestamps, size) for a note without fetching content.",
    { path: z.string().describe("Note path") },
    async ({ path }) => {
      try {
        const meta = await vault.getMetadata(path);
        const result = {
          path: meta.path,
          size: meta.size,
          ctime: meta.ctime ? new Date(meta.ctime).toISOString() : null,
          mtime: meta.mtime ? new Date(meta.mtime).toISOString() : null,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
      folder: z.string().optional().describe("Restrict to folder prefix"),
    },
    async ({ limit, folder }) => {
      try {
        const maxResults = limit || 20;
        let notes = await vault.listNotesWithMtime();

        if (folder) {
          const folderLower = folder.toLowerCase();
          notes = notes.filter((n) => n.path.toLowerCase().startsWith(folderLower));
        }

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
app.get("/health", (_, res) => {
  res.json({ ok: true, version: "2.0.0" });
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
  console.log(`obsidian-couchdb-mcp v2.0.0 listening on :${PORT}`);
  console.log(`Vault: ${COUCHDB_URL}/${COUCHDB_DATABASE}`);
  console.log(`OAuth issuer: ${SERVER_URL}`);
  console.log(`OAuth client_id: ${FIXED_CLIENT_ID}`);
  console.log(`OAuth client_secret: ${FIXED_CLIENT_SECRET}`);
  console.log(`MCP endpoint: ${SERVER_URL}/mcp (Streamable HTTP)`);
});
