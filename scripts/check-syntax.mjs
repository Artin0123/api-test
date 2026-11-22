// Syntax-checks every JS file the project serves or bundles, in one pass.
// Replaces the old chain of `node --check` calls in package.json, which could
// silently miss a file the moment a new one was added.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__pycache__") continue;
      out.push(...walk(full));
    } else if (/\.(js|mjs)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...walk(join(root, "src")),
  ...walk(join(root, "public")),
];

let failed = false;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed = true;
    console.error(`Syntax error in ${file}:\n${res.stderr}`);
  }
}

if (failed) process.exit(1);
console.log(`syntax OK for ${files.length} JS files`);
