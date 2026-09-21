import assert from "node:assert/strict";
import * as vscode from "vscode";
import { parseNoteFile } from "../model/note";
import type { StoredNote } from "../model/note";
import { NoteController } from "../comments/noteController";
import type { NoteComment } from "../comments/noteComment";
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

  test("supports own replies, draft labels, deletion warnings, and undo recovery", async () => {
    const controller = new NoteController();
    controller["authorName"] = async () => "Integration Author";
    let finishWarning: ((choice: string | undefined) => void) | undefined;
    controller["warnAboutDeletedCode"] = () => new Promise<string | undefined>((resolve) => { finishWarning = resolve; });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "sample.ts"));
    const originalText = document.getText();
    const editor = await vscode.window.showTextDocument(document);
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) { return; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Timed out waiting for controller state");
    };
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(0, 0, 0, document.lineAt(0).text.length);
      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      assert.equal(draft.label, "Add a Ghost Comment");
      await controller["submitNote"]({ thread: draft, text: "Initial note" });
      const binding = () => [...controller["bindings"].values()][0]!;
      assert.equal(binding().thread.canReply, true);
      await controller["replyNote"]({ thread: binding().thread, text: "**My own reply**" });
      assert.equal(binding().thread.comments.length, 2);
      assert.equal(binding().thread.comments[1]!.author.name, "Integration Author");
      const reply = binding().thread.comments[1] as NoteComment;
      controller["editNote"](reply);
      assert.equal(binding().thread.comments.length, 2);
      reply.body = new vscode.MarkdownString("Edited reply");
      await controller["saveNote"](reply);
      assert.equal(binding().store.all[0]!.body, "Initial note");
      assert.equal(binding().store.all[0]!.replies![0]!.body, "Edited reply");
      const range = binding().thread.range!;
      const deletedText = document.getText(range);
      const edit = new vscode.WorkspaceEdit();
      edit.delete(document.uri, range);
      await vscode.workspace.applyEdit(edit);
      await waitFor(() => finishWarning !== undefined);
      assert.equal(binding().store.all[0]!.status, "stale");
      await controller["refreshAnchors"](document);
      assert.equal(binding().store.all[0]!.anchor.text, deletedText);
      // Restoring the code before choosing Delete must preserve the discussion.
      const restore = new vscode.WorkspaceEdit();
      restore.insert(document.uri, range.start, deletedText);
      await vscode.workspace.applyEdit(restore);
      await waitFor(() => binding().store.all[0]!.status === "active");
      finishWarning!("Delete Comments");
      await waitFor(() => controller["pendingDeletions"].size === 0);
      assert.equal(binding().thread.comments.length, 2);
      finishWarning = undefined;
      await vscode.workspace.applyEdit(edit);
      await waitFor(() => finishWarning !== undefined);
      finishWarning!("Keep Comments");
      await waitFor(() => controller["pendingDeletions"].size === 0);
      assert.equal(binding().thread.comments.length, 2);
      assert.equal(binding().thread.range, undefined);
      await vscode.workspace.applyEdit(restore);
      await waitFor(() => binding().store.all[0]!.status === "active");
      finishWarning = undefined;
      await vscode.workspace.applyEdit(edit);
      await waitFor(() => finishWarning !== undefined);
      finishWarning!("Delete Comments");
      await waitFor(() => controller["bindings"].size === 0);
    } finally {
      finishWarning?.("Keep Comments");
      controller.dispose();
      const restore = new vscode.WorkspaceEdit();
      restore.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), originalText);
      await vscode.workspace.applyEdit(restore);
      await document.save();
    }
  });

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
      note.replies = [{
        id: "own-reply", body: "**Follow-up**", author: note.author,
        createdAt: note.createdAt, updatedAt: note.updatedAt,
      }];
      await store.upsert(note);
      await store.load();
      assert.deepEqual(store.all, [note]);
      await vscode.workspace.fs.writeFile(store.storageUri, new TextEncoder().encode("{invalid"));
      await assert.rejects(() => store.load());
      assert.deepEqual(store.all, [note]);
    } finally {
      store.dispose();
    }
  });
});
