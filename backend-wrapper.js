// Wrapper for obsidian-sync-mcp that suppresses ChangeManager errors.
// The vault's internal change watcher throws unhandled errors from node-fetch
// when using relative URLs in headless/server mode. The core MCP API still works.

process.on("uncaughtException", (err) => {
  if (
    err.message?.includes("Only absolute URLs") ||
    err.message?.includes("watching changes") ||
    err.message?.includes("ChangeManager")
  ) {
    console.log(`[backend] suppressed watcher error: ${err.message}`);
    return;
  }
  console.error("[backend] fatal:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  if (
    msg.includes("Only absolute URLs") ||
    msg.includes("watching changes") ||
    msg.includes("ChangeManager")
  ) {
    console.log(`[backend] suppressed watcher rejection: ${msg}`);
    return;
  }
  console.error("[backend] unhandled rejection:", reason);
  process.exit(1);
});

await import("obsidian-sync-mcp/dist/main.js");
