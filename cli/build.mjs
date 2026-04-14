#!/usr/bin/env node
/**
 * Build script for agent-logs CLI.
 *
 * Usage:
 *   node build.mjs               — bundle + generate SEA blob
 *   node build.mjs --bundle-only — bundle only (for CI where blob is generated separately)
 */
import { execSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import esbuild from "esbuild";

const bundleOnly = process.argv.includes("--bundle-only");

mkdirSync("dist", { recursive: true });

// Step 1: Bundle all ES modules into a single ESM file
await esbuild.build({
  entryPoints: ["index.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/bundle.mjs",
  // All imports are Node built-ins — mark them external
  external: [
    "fs", "path", "os", "crypto", "readline", "tty",
    "child_process", "http", "https", "net", "url",
    "stream", "buffer", "events", "util", "assert",
  ],
});

console.log("✓ Bundled ESM to dist/bundle.mjs");

// Step 2: Convert ESM bundle to CJS-compatible async IIFE for SEA
// Node 22 SEA only supports CJS entry points. We convert:
//   import { x } from "mod"  →  const { x } = require("mod")
// and wrap everything in an async IIFE for top-level await support.
let code = readFileSync("dist/bundle.mjs", "utf8");

// Strip shebang line if present
code = code.replace(/^#!.*\n/, "");

// Convert ESM imports to require() calls
// Also convert `x as y` (ESM) to `x: y` (CJS destructuring)
code = code.replace(
  /^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";?$/gm,
  (_, names, mod) => {
    const cjsNames = names.replace(/\b(\w+)\s+as\s+(\w+)\b/g, "$1: $2");
    return `const {${cjsNames}} = require("${mod}");`;
  }
);

// Convert default imports: import x from "mod" → const x = require("mod")
code = code.replace(
  /^import\s+(\w+)\s+from\s+"([^"]+)";?$/gm,
  (_, name, mod) => `const ${name} = require("${mod}");`
);

// Extract all require() lines (they must be at the top, outside the async IIFE)
const lines = code.split("\n");
const requires = [];
const body = [];
for (const line of lines) {
  if (line.startsWith("const ") && line.includes("require(")) {
    requires.push(line);
  } else {
    body.push(line);
  }
}

const cjsCode = [
  ...requires,
  "",
  "(async () => {",
  ...body,
  "})().catch(e => { console.error(e.message); process.exit(1); });",
].join("\n");

writeFileSync("dist/bundle.cjs", cjsCode);
console.log("✓ Converted to CJS at dist/bundle.cjs");

if (bundleOnly) process.exit(0);

// Step 3: Generate SEA blob (platform-independent when useCodeCache is false)
execSync("node --experimental-sea-config sea-config.json", { stdio: "inherit" });
console.log("✓ SEA blob generated at dist/sea-prep.blob");
