import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const context = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  minify: !watch,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: watch,
  target: "node20",
});
if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
