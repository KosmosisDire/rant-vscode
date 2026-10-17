import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { context, build } from "esbuild";

const minify = process.argv.includes("--minify");

// Rant's wasm module finds its .wasm beside itself through import.meta.url, which a CommonJS
// bundle answers with its own file, so the .wasm is copied beside the bundle
const rantDist = dirname(createRequire(import.meta.url).resolve("rant-middleware"));
const meta = { define: { "import.meta.url": "importMetaUrl" }, banner: { js: 'const importMetaUrl = require("url").pathToFileURL(__filename).href;' } };

// the extension runs in Node, each entity page in a webview
const builds = [
  { entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node22", external: ["vscode"], ...meta },
  { entryPoints: ["src/page/entity.ts"], outfile: "dist/page.js", platform: "browser", format: "iife", target: "es2022" },
].map((o) => ({ ...o, bundle: true, sourcemap: true, minify }));

await mkdir("dist", { recursive: true });
await copyFile(join(rantDist, "rant_wasm.wasm"), "dist/rant_wasm.wasm");
if (process.argv.includes("--watch")) {
  for (const o of builds) await (await context(o)).watch();
} else {
  await Promise.all(builds.map((o) => build(o)));
}
