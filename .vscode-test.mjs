import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/integration/**/*.test.js",
  workspaceFolder: "./test/fixtures/integration-workspace",
  launchArgs: ["--disable-extensions"],
  mocha: { ui: "tdd", timeout: 20000 },
});
