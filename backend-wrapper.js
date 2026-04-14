// Wrapper for obsidian-sync-mcp that suppresses ChangeManager errors.
// The vault's internal change watcher throws unhandled errors from node-fetch
// when using relative URLs in headless/server mode. The core MCP API still works.

// Suppress ALL uncaught errors during startup — the ChangeManager watcher
// throws various errors (TypeError, fetch errors) that crash the process
// but the core MCP API works fine without the watcher.
process.on("uncaughtException", (err) => {
  console.log(`[backend] suppressed uncaught: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  console.log(`[backend] suppressed rejection: ${reason?.message || reason}`);
});

await import("obsidian-sync-mcp/dist/main.js");
