import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const root = fileURLToPath(new URL("../", import.meta.url));
const cachePath = path.join(root, ".vscode-test");
const executable = await downloadAndUnzipVSCode({
  cachePath,
  extensionDevelopmentPath: root,
});

const child = spawn(executable, [
  path.join(root, "test/fixtures/workspace"),
  path.join(root, "test/fixtures/workspace/sample.ts"),
  `--extensionDevelopmentPath=${root}`,
  `--user-data-dir=${path.join(cachePath, "sandbox-user-data")}`,
  `--extensions-dir=${path.join(cachePath, "sandbox-extensions")}`,
  "--disable-extensions",
  "--new-window",
  "--skip-welcome",
  "--skip-release-notes",
], { stdio: "inherit" });

console.log("Ghost Comments sandbox is opening. Close its VS Code window to stop.");
const [code] = await once(child, "exit");
process.exitCode = code ?? 1;
