import { context, build } from "esbuild";

const minify = process.argv.includes("--minify");

// the extension runs in Node, each entity page in a webview
const builds = [
  { entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", target: "node22", external: ["vscode"] },
  { entryPoints: ["src/page/entity.ts"], outfile: "dist/page.js", platform: "browser", format: "iife", target: "es2022" },
].map((o) => ({ ...o, bundle: true, sourcemap: true, minify }));

if (process.argv.includes("--watch")) {
  for (const o of builds) await (await context(o)).watch();
} else {
  await Promise.all(builds.map((o) => build(o)));
}
