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

const backend = spawn("node", ["backend-wrapper.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(BACKEND_PORT) },
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

  await initRes.text();
  const sessionId = initRes.headers.get("mcp-session-id");

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
}

// Get available tools from backend
const toolsResponse = await backendMcpCall("tools/list");
const backendTools = toolsResponse.result?.tools || [];
console.log(`Discovered ${backendTools.length} tools: ${backendTools.map((t) => t.name).join(", ")}`);

// --- OAuth 2.1 Provider (file-persisted, survives pod restarts) ---

const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH || "/data/oauth-tokens.json";

const FIXED_CLIENT_ID = createHash("sha256").update(`${MCP_SECRET}:client_id`).digest("hex").slice(0, 36);
const FIXED_CLIENT_SECRET = createHash("sha256").update(`${MCP_SECRET}:client_secret`).digest("hex");

class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { tokens: {}, codes: {} };
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      }
    } catch (err) {
      console.warn(`[tokenstore] Failed to load ${this.filePath}: ${err.message}, starting fresh`);
      this.data = { tokens: {}, codes: {} };
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
  async getClient(clientId) {
    return clientId === FIXED_CLIENT_ID ? this.client : undefined;
  }
  async registerClient(_metadata) {
    return this.client;
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
    if (!data || data.type === "refresh") throw new Error("Invalid token");
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

  async revokeToken(token) {
    this.store.deleteToken(token);
  }
}

// --- MCP Server (proxy tools to backend) ---

function createMcpServer() {
  const server = new McpServer({ name: "obsidian-couchdb-mcp", version: "2.0.0" });

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
    const r = await fetch(`${BACKEND_URL}/health`);
    const body = await r.json();
    res.json({ ok: body.ok !== false, version: "2.0.0", backend: true });
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
  console.log(`Backend: ${BACKEND_URL} (obsidian-sync-mcp)`);
  console.log(`OAuth issuer: ${SERVER_URL}`);
  console.log(`OAuth client_id: ${FIXED_CLIENT_ID}`);
  console.log(`OAuth client_secret: ${FIXED_CLIENT_SECRET}`);
  console.log(`MCP endpoint: ${SERVER_URL}/mcp (Streamable HTTP)`);
  console.log(`Tools: ${backendTools.map((t) => t.name).join(", ")}`);
});
