import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import express from "express";
import { z } from "zod";
import { spawn } from "node:child_process";

// --- Configuration ---

const MCP_SECRET = process.env.MCP_SECRET;
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || "8787", 10);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

if (!MCP_SECRET) {
  console.error("Error: MCP_SECRET environment variable is required");
  process.exit(1);
}

// --- Start obsidian-sync-mcp backend ---

// HOST pins the backend to loopback: it must only ever be reachable through our
// OAuth proxy on :3000, never directly from other pods on the cluster network.
const backend = spawn("node", ["backend-wrapper.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(BACKEND_PORT), HOST: "127.0.0.1" },
});

backend.stdout.on("data", (d) => process.stdout.write(`[backend] ${d}`));
backend.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));
backend.on("exit", (code) => {
  console.error(`[backend] obsidian-sync-mcp exited with code ${code}`);
  process.exit(1);
});

// Wait for backend to be ready
await new Promise((resolve) => {
  const check = async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/health`);
      if (r.ok) return resolve();
    } catch {}
    setTimeout(check, 500);
  };
  check();
});
console.log(`Backend ready at ${BACKEND_URL}`);

// --- Discover tools from backend ---

let backendInstructions;

async function backendMcpCall(method, params = {}) {
  // Initialize session
  const initRes = await fetch(`${BACKEND_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...(process.env.MCP_AUTH_TOKEN ? { "Authorization": `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "oauth-proxy", version: "2.0.0" },
      },
      id: 1,
    }),
  });

  const initText = await initRes.text();
  const sessionId = initRes.headers.get("mcp-session-id");

  // Capture the backend's instructions once, so MCP_INSTRUCTIONS / vault
  // conventions set on obsidian-sync-mcp reach the client through this proxy.
  if (backendInstructions === undefined) {
    try {
      const m = initText.match(/data: (.+)/);
      backendInstructions = JSON.parse(m ? m[1] : initText).result?.instructions ?? null;
    } catch {
      backendInstructions = null;
    }
  }

  try {
    // Send initialized notification
    await fetch(`${BACKEND_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        ...(process.env.MCP_AUTH_TOKEN ? { "Authorization": `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    // Call the method
    const res = await fetch(`${BACKEND_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        ...(process.env.MCP_AUTH_TOKEN ? { "Authorization": `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 2 }),
    });

    const text = await res.text();
    const match = text.match(/data: (.+)/);
    return match ? JSON.parse(match[1]) : JSON.parse(text);
  } finally {
    // Every call opens a backend session; left open, the backend keeps them
    // forever and the pod's memory grows until it is OOM-killed.
    if (sessionId) {
      await fetch(`${BACKEND_URL}/mcp`, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId,
          ...(process.env.MCP_AUTH_TOKEN ? { "Authorization": `Bearer ${process.env.MCP_AUTH_TOKEN}` } : {}),
        },
      }).catch(() => {});
    }
  }
}

// Get available tools from backend
const toolsResponse = await backendMcpCall("tools/list");
const backendTools = toolsResponse.result?.tools || [];
console.log(`Discovered ${backendTools.length} tools: ${backendTools.map((t) => t.name).join(", ")}`);

// --- OAuth 2.1 Provider (file-persisted, survives pod restarts) ---

const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || "/data/oauth-tokens.json";

// Authorization codes are single-use and short-lived; RFC 6749 caps them at ten
// minutes. Anything older is an abandoned flow.
const CODE_TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const FIXED_CLIENT_ID = createHash("sha256").update(`${MCP_SECRET}:client_id`).digest("hex").slice(0, 36);
const FIXED_CLIENT_SECRET = createHash("sha256").update(`${MCP_SECRET}:client_secret`).digest("hex");

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { tokens: {}, codes: {} };
    this._load();
    this._prune();
    // Restarts alone are not a reliable broom: a pod can run for months.
    // unref so this timer never keeps the process alive on shutdown.
    this.pruneTimer = setInterval(() => this._prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
        this.data = {
          tokens: parsed?.tokens ?? {},
          codes: parsed?.codes ?? {},
        };
      }
    } catch (err) {
      console.warn(`[tokenstore] Failed to load ${this.filePath}: ${err.message}, starting fresh`);
      this.data = { tokens: {}, codes: {} };
    }
    this._dropForeign();
  }

  /**
   * The client id is derived from MCP_SECRET, so rotating the secret must
   * revoke everything issued before it. Every record names its client (tokens
   * by `clientId`, codes by `client.client_id`); one that names another
   * client, or none, is dropped.
   */
  _dropForeign() {
    const { tokens = {}, codes = {} } = this.data;
    const keep = (entries, idOf) => Object.fromEntries(entries.filter(([, v]) => idOf(v) === FIXED_CLIENT_ID));
    this.data = {
      tokens: keep(Object.entries(tokens), (v) => v?.clientId),
      codes: keep(Object.entries(codes), (v) => v?.client?.client_id),
    };
    const dropped = Object.keys(tokens).length + Object.keys(codes).length -
      Object.keys(this.data.tokens).length - Object.keys(this.data.codes).length;
    if (dropped) {
      console.log(`[tokenstore] Dropped ${dropped} record(s) issued to another client (MCP_SECRET rotated)`);
      this._save();
    }
  }

  // An expired access token is otherwise only dropped when someone tries to use
  // it (see verifyAccessToken), so tokens nobody touches again stay on disk
  // forever. Four months of that left 101 dead entries out of 104.
  _prune() {
    const now = Date.now();
    let tokens = 0;
    let codes = 0;

    for (const [key, value] of Object.entries(this.data.tokens)) {
      // Refresh tokens deliberately carry no expiry: they end by rotation in
      // exchangeRefreshToken, or by revocation. Age must never drop them.
      if (value?.type === "refresh") continue;
      if (value?.expiresAt && value.expiresAt < now) {
        delete this.data.tokens[key];
        tokens++;
      }
    }

    for (const [key, value] of Object.entries(this.data.codes)) {
      if (value?.createdAt && now - value.createdAt > CODE_TTL_MS) {
        delete this.data.codes[key];
        codes++;
      }
    }

    if (tokens || codes) {
      console.log(`[tokenstore] pruned ${tokens} expired token(s), ${codes} stale code(s)`);
      this._save();
    }
  }

  _save() {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data));
    } catch (err) {
      console.error(`[tokenstore] Failed to save ${this.filePath}: ${err.message}`);
    }
  }

  getToken(key) { return this.data.tokens[key]; }
  setToken(key, value) { this.data.tokens[key] = value; this._save(); }
  deleteToken(key) { delete this.data.tokens[key]; this._save(); }

  getCode(key) { return this.data.codes[key]; }
  setCode(key, value) { this.data.codes[key] = value; this._save(); }
  deleteCode(key) { delete this.data.codes[key]; this._save(); }
}

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
  // No registerClient: without it the SDK neither mounts nor advertises
  // /register, which would hand the fixed client_secret to anyone who asked.
  // The credentials are entered by hand in the connector's settings.
  async getClient(clientId) {
    return clientId === FIXED_CLIENT_ID ? this.client : undefined;
  }
}

class OAuthProvider {
  constructor(store) {
    this.clientsStore = new ClientsStore();
    this.store = store;
  }

  async authorize(client, params, res) {
    console.log(`[oauth] authorize: client=${client.client_id} redirect=${params.redirectUri}`);
    const code = randomUUID();
    this.store.setCode(code, { client, params, createdAt: Date.now() });
    const searchParams = new URLSearchParams({ code });
    if (params.state) searchParams.set("state", params.state);
    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(_client, code) {
    const data = this.store.getCode(code);
    if (!data) throw new Error("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _codeVerifier) {
    console.log(`[oauth] exchangeCode: client=${client.client_id} code=${code.slice(0, 8)}...`);
    const data = this.store.getCode(code);
    if (!data) throw new Error("Invalid authorization code");
    if (data.client.client_id !== client.client_id) throw new Error("Client mismatch");
    this.store.deleteCode(code);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresIn = 86400;

    this.store.setToken(accessToken, {
      clientId: client.client_id,
      scopes: data.params.scopes || [],
      expiresAt: Date.now() + expiresIn * 1000,
      resource: data.params.resource,
    });
    this.store.setToken(refreshToken, {
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
    const data = this.store.getToken(refreshToken);
    if (!data || data.type !== "refresh") throw new Error("Invalid refresh token");
    if (data.clientId !== client.client_id) throw new Error("Client mismatch");
    this.store.deleteToken(refreshToken);

    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const expiresIn = 86400;

    this.store.setToken(newAccessToken, {
      clientId: client.client_id,
      scopes: scopes || data.scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    this.store.setToken(newRefreshToken, {
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
    const data = this.store.getToken(token);
    if (!data || data.type === "refresh" || data.clientId !== FIXED_CLIENT_ID) throw new Error("Invalid token");
    if (data.expiresAt && data.expiresAt < Date.now()) {
      this.store.deleteToken(token);
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

  // RFC 7009: an unknown token, or one of another client, is still a 200.
  async revokeToken(client, request) {
    const data = this.store.getToken(request.token);
    if (data && data.clientId === client.client_id) this.store.deleteToken(request.token);
  }
}

// --- MCP Server (proxy tools to backend) ---

function createMcpServer() {
  const server = new McpServer(
    { name: "obsidian-couchdb-mcp", version: "2.0.0" },
    backendInstructions ? { instructions: backendInstructions } : undefined,
  );

  // Register each backend tool as a proxy
  for (const tool of backendTools) {
    // Build zod schema from JSON Schema input
    const properties = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    const shape = {};

    for (const [key, prop] of Object.entries(properties)) {
      let schema;
      if (prop.type === "number" || prop.type === "integer") {
        schema = z.number();
      } else if (prop.type === "boolean") {
        schema = z.boolean();
      } else {
        schema = z.string();
      }
      if (prop.description) schema = schema.describe(prop.description);
      if (!required.has(key)) schema = schema.optional();
      shape[key] = schema;
    }

    server.tool(tool.name, tool.description || tool.name, shape, async (args) => {
      try {
        const result = await backendMcpCall("tools/call", { name: tool.name, arguments: args });
        if (result.result) return result.result;
        if (result.error) {
          return { content: [{ type: "text", text: `Backend error: ${result.error.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Proxy error: ${err.message}` }], isError: true };
      }
    });
  }

  return server;
}

// --- Express App ---

const tokenStore = new TokenStore(TOKEN_STORE_PATH);
const provider = new OAuthProvider(tokenStore);
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// Health (unauthenticated) — also checks backend
app.get("/health", async (_, res) => {
  try {
    const r = await fetch(`${BACKEND_URL}/health`, {
      headers: process.env.MCP_AUTH_TOKEN
        ? { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` }
        : {},
    });
    // The backend answers plain text ("✓ Ok"), not JSON, so parse defensively:
    // treating it as JSON threw and made a healthy backend report as down.
    const text = await r.text();
    let ok = r.ok;
    try {
      ok = ok && JSON.parse(text).ok !== false;
    } catch {
      // non-JSON body is fine, the status code already told us
    }
    res.json({ ok, version: "2.0.0", backend: r.ok });
  } catch {
    res.json({ ok: false, version: "2.0.0", backend: false });
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

/**
 * Sessions live in memory, so a restart forgets every one of them while the
 * clients still hold their ids. The spec's answer is 404, which tells a
 * client to initialize a new session. Handing the request to a fresh
 * transport instead gets a 400 "Server not initialized", and a claude.ai chat
 * that was open across the restart then fails its tool calls outright.
 */
const unknownSession = (res) =>
  res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log(`[auth] ${req.method} ${req.path} auth=${authHeader ? authHeader.slice(0, 20) + "..." : "none"}`);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).set("WWW-Authenticate", 'Bearer error="invalid_token"').json({ error: "Missing token" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const authInfo = await provider.verifyAccessToken(token);
    req.auth = authInfo;
    next();
  } catch (err) {
    res.status(401).set("WWW-Authenticate", `Bearer error="invalid_token"`).json({ error: err.message });
  }
};

app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
    } else if (sessionId) {
      unknownSession(res);
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
      }
    }
  } catch (err) {
    console.error(`[mcp] POST error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId) return res.status(400).json({ error: "Missing session ID" });
  if (!transports.has(sessionId)) return unknownSession(res);
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
  console.log(`Backend: ${BACKEND_URL} (obsidian-sync-mcp)`);
  console.log(`OAuth issuer: ${SERVER_URL}`);
  console.log(`OAuth client_id: ${FIXED_CLIENT_ID}`);
  console.log(`OAuth client_secret: ${FIXED_CLIENT_SECRET}`);
  console.log(`MCP endpoint: ${SERVER_URL}/mcp (Streamable HTTP)`);
  console.log(`Tools: ${backendTools.map((t) => t.name).join(", ")}`);
});
