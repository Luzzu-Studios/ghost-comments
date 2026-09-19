import assert from "node:assert/strict";
import * as vscode from "vscode";
import { parseNoteFile } from "../model/note";
import type { StoredNote } from "../model/note";
import { NoteStore } from "../storage/noteStore";

suite("Ghost Comments", () => {
  const folder = vscode.workspace.workspaceFolders![0]!;

  async function cleanStorage(): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, ".gc"), { recursive: true, useTrash: false });
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
        throw error;
      }
    }
  }

  setup(cleanStorage);
  teardown(cleanStorage);

  test("activates and registers its public command", async () => {
    const extension = vscode.extensions.getExtension("ghost-comments.ghost-comments");
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("ghostComments.createNote"));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "sample.ts"));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("ghostComments.createNote");
  });

  test("persists deterministic workspace notes and retains the last good state", async () => {
    const store = new NoteStore(folder);
    try {
      await store.load();
      const note: StoredNote = {
        id: "integration-note", filePath: "sample.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        anchor: { text: "export", before: [], after: [] },
        body: "Keep this export stable.", author: "Integration Test", status: "active",
        createdAt: "2026-09-17T10:00:00.000Z", updatedAt: "2026-09-17T10:00:00.000Z",
      };
      await store.upsert(note);
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(store.storageUri));
      assert.deepEqual(parseNoteFile(text).notes, [note]);
      await vscode.workspace.fs.writeFile(store.storageUri, new TextEncoder().encode("{invalid"));
      await assert.rejects(() => store.load());
      assert.deepEqual(store.all, [note]);
    } finally {
      store.dispose();
    }
  });
});
