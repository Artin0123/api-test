// Assembles public/_worker.js from src/*.js (verbatim concatenation).
// Cloudflare Pages advanced mode requires _worker.js to be a single runnable
// ES module, so the sources are plain declaration files joined in a fixed
// order. Edit src/*.js, then run `npm run build` — never edit
// public/_worker.js directly: this script overwrites it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const order = [
  "entry.js",
  "storage.js",
  "auth.js",
  "utils.js",
  "settings.js",
  "settings-handlers.js",
  "results.js",
  "run-status.js",
  "dead-keys.js",
  "proxy.js",
  "proxy-handlers.js",
  "storage-migrate.js",
];

const parts = order.map((name) => {
  const text = readFileSync(join(root, "src", name), "utf8");
  if (!text.endsWith("\n")) throw new Error(`src/${name} must end with a newline`);
  return text.replace(/\n+$/, "");
});

writeFileSync(join(root, "public/_worker.js"), parts.join("\n\n") + "\n");
console.log(`built public/_worker.js from ${order.length} source files`);
