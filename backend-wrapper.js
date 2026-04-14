// Wrapper for obsidian-sync-mcp that suppresses ChangeManager errors.
// The vault's internal change watcher throws unhandled errors from node-fetch
// when using relative URLs in headless/server mode. The core MCP API still works.

process.on("uncaughtException", (err) => {
  console.log(`[backend] suppressed uncaught: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  console.log(`[backend] suppressed rejection: ${reason?.message || reason}`);
});

import("obsidian-sync-mcp/dist/main.js").catch((err) => {
  console.error("[backend] failed to load:", err.message);
  process.exit(1);
});
