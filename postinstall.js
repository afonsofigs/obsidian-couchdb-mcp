// Patch obsidian-sync-mcp vault bundle to include adapter: "http" in PouchDB options.
// The HeadlessDatabaseServiceExt.createPouchDBInstance override omits the adapter,
// causing "Invalid Adapter: undefined" at runtime.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distDir = "node_modules/obsidian-sync-mcp/dist";
let files;
try {
  files = readdirSync(distDir).filter((f) => f.startsWith("vault-") && f.endsWith(".js"));
} catch {
  console.log("postinstall: dist directory not found, skipping patch");
  process.exit(0);
}

if (files.length === 0) {
  console.log("postinstall: vault bundle not found, skipping patch");
  process.exit(0);
}

const needle = `return new PouchDB(option.url + "/" + option.database, {
          auth: { username: option.username, password: option.password }
        });`;

const replacement = `return new PouchDB(option.url + "/" + option.database, {
          adapter: "http",
          auth: { username: option.username, password: option.password }
        });`;

for (const file of files) {
  const path = join(distDir, file);
  const content = readFileSync(path, "utf-8");

  if (content.includes('adapter: "http"') && content.includes(replacement.trim())) {
    console.log(`postinstall: ${file} already patched`);
    continue;
  }

  if (!content.includes(needle)) {
    console.log(`postinstall: patch target not found in ${file}, skipping`);
    continue;
  }

  writeFileSync(path, content.replace(needle, replacement));
  console.log(`postinstall: patched ${file} (added adapter: "http")`);
}
