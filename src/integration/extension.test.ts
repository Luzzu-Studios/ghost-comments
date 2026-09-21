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
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, ".gc"), {
        recursive: true,
        useTrash: false,
      });
    } catch (error) {
      if (
        !(
          error instanceof vscode.FileSystemError &&
          error.code === "FileNotFound"
        )
      ) {
        throw error;
      }
    }
  }

  setup(cleanStorage);
  teardown(cleanStorage);

  test("preserves detached discussions until explicit selection or line reattachment", async () => {
    const controller = new NoteController();
    controller["authorName"] = async () => "Integration Author";
    const attachmentPrompts: ((choice: string | undefined) => void)[] = [];
    controller["showAttachmentPrompt"] = () =>
      new Promise<string | undefined>((resolve) => {
        attachmentPrompts.push(resolve);
      });
    let finishWarning: ((choice: string | undefined) => void) | undefined;
    controller["warnAboutDeletedCode"] = () =>
      new Promise<string | undefined>((resolve) => {
        finishWarning = resolve;
      });
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, "sample.ts"),
    );
    const originalText = document.getText();
    const editor = await vscode.window.showTextDocument(document);
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Timed out waiting for controller state");
    };
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(
        0,
        0,
        0,
        document.lineAt(0).text.length,
      );
      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      assert.equal(draft.label, "Add a Ghost Comment");
      await controller["submitNote"]({ thread: draft, text: "Initial note" });
      const binding = () => [...controller["bindings"].values()][0]!;
      assert.equal(binding().thread.canReply, true);
      await controller["replyNote"]({
        thread: binding().thread,
        text: "**My own reply**",
      });
      assert.equal(binding().thread.comments.length, 2);
      assert.equal(
        binding().thread.comments[1]!.author.name,
        "Integration Author",
      );
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
      const restore = new vscode.WorkspaceEdit();
      restore.insert(document.uri, range.start, deletedText);
      await vscode.workspace.applyEdit(restore);
      await controller["validateAnchors"](document);
      await controller["refreshAnchors"](document);
      assert.equal(binding().store.all[0]!.status, "stale");
      assert.equal(binding().thread.range, undefined);
      const detachedComment = binding().thread.comments[0] as NoteComment;
      assert.equal(detachedComment.label, "⚠️ Needs reattachment");
      assert.equal(binding().thread.label, "⚠️ Detached");
      assert.equal(detachedComment.body.value, "Initial note");
      assert.equal(binding().store.all[0]!.body, "Initial note");
      controller["editNote"](detachedComment);
      assert.equal(detachedComment.body.value, "Initial note");
      controller["cancelEdit"](detachedComment);
      assert.equal(detachedComment.body.value, "Initial note");
      finishWarning!("Reattach…");
      await waitFor(() => attachmentPrompts.length === 1);
      const originalReplies = binding().store.all[0]!.replies;
      assert.equal(binding().store.all[0]!.status, "stale");
      attachmentPrompts[0]!("Cancel");
      await waitFor(() => controller["pendingAttachment"] === undefined);
      assert.equal(controller["pendingAttachment"], undefined);
      assert.equal(binding().store.all[0]!.status, "stale");
      assert.equal(detachedComment.label, "⚠️ Needs reattachment");
      await controller["reattachNote"](binding().thread);
      await waitFor(() => attachmentPrompts.length === 2);
      editor.selection = new vscode.Selection(0, 1, 0, 4);
      attachmentPrompts[1]!("Attach here");
      await waitFor(() => controller["pendingAttachment"] === undefined);
      assert.equal(binding().store.all[0]!.status, "active");
      assert.deepEqual(binding().store.all[0]!.range, {
        start: { line: 0, character: 1 },
        end: { line: 0, character: 4 },
      });
      assert.equal(
        binding().store.all[0]!.anchor.text,
        document.getText(new vscode.Range(0, 1, 0, 4)),
      );
      assert.deepEqual(binding().store.all[0]!.replies, originalReplies);
      assert.equal(controller["pendingAttachment"], undefined);
      assert.equal(
        binding().thread.collapsibleState,
        vscode.CommentThreadCollapsibleState.Expanded,
      );
      assert.equal(detachedComment.label, undefined);
      assert.equal(binding().thread.label, undefined);
      assert.equal(detachedComment.body.value, "Initial note");

      // A cursor-only destination attaches the entire line.
      await binding().store.upsert({
        ...binding().store.all[0]!,
        status: "stale",
      });
      await controller["reattachNote"](binding().thread);
      await waitFor(() => attachmentPrompts.length === 3);
      editor.selection = new vscode.Selection(0, 2, 0, 2);
      attachmentPrompts[2]!("Attach here");
      await waitFor(() => controller["pendingAttachment"] === undefined);
      assert.deepEqual(binding().store.all[0]!.range, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: document.lineAt(0).text.length },
      });
      assert.equal(binding().store.all[0]!.anchor.text, deletedText);
      assert.deepEqual(binding().store.all[0]!.replies, originalReplies);

      // A failed destination leaves the discussion detached and the flow retryable.
      await binding().store.upsert({
        ...binding().store.all[0]!,
        status: "stale",
      });
      await controller["reattachNote"](binding().thread);
      const untitled = await vscode.workspace.openTextDocument({
        content: "outside workspace",
      });
      await vscode.window.showTextDocument(untitled);
      await assert.rejects(
        () => controller["attachHere"](),
        /inside an open workspace folder/,
      );
      assert.equal(binding().store.all[0]!.status, "stale");
      assert.ok(controller["pendingAttachment"]);
      await vscode.window.showTextDocument(document);
      await controller["attachHere"]();
      assert.equal(binding().store.all[0]!.status, "active");

      // Separate explicit deletion still removes the entire discussion.
      controller["confirmDeleteNote"] = async () => "Delete";
      await controller["deleteNote"](
        binding().thread.comments[0] as NoteComment,
      );
      assert.equal(controller["bindings"].size, 0);
    } finally {
      finishWarning?.("Later");
      controller.dispose();
      const restore = new vscode.WorkspaceEdit();
      restore.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        originalText,
      );
      await vscode.workspace.applyEdit(restore);
      await document.save();
    }
  });

  test("groups missing anchors and keeps persisted detached notes detached on reload", async () => {
    const controller = new NoteController();
    const prompts: number[] = [];
    controller["warnAboutDeletedCode"] = async (count) => {
      prompts.push(count);
      return undefined;
    };
    try {
      await controller.initialize();
      const store = [...controller["stores"].values()][0]!;
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(folder.uri, "sample.ts"),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const id of ["missing-one", "missing-two"]) {
        await store.upsert({
          id,
          filePath: "sample.ts",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 6 },
          },
          anchor: {
            text: "not present anywhere in fixture",
            before: [],
            after: [],
          },
          body: id,
          author: "Test",
          status: "active",
          createdAt: "2026-09-17T10:00:00.000Z",
          updatedAt: "2026-09-17T10:00:00.000Z",
        });
      }
      await controller["validateAnchors"](document);
      await controller["promptDetached"](store, store.all);
      assert.deepEqual(prompts, [2]);
      assert.ok(store.all.every((note) => note.status === "stale"));
      // Even an exact match must not revive a previously detached note.
      for (const note of store.all) {
        await store.upsert({
          ...note,
          anchor: {
            text: document.getText().slice(0, 6),
            before: [],
            after: [],
          },
        });
      }
      await store.load();
      await controller["validateAnchors"](document);
      assert.ok(store.all.every((note) => note.status === "stale"));
      assert.ok(
        [...controller["bindings"].values()].every(
          (binding) => binding.thread.range === undefined,
        ),
      );
      assert.deepEqual(prompts, [2]);
    } finally {
      controller.dispose();
    }
  });

  test("activates and registers its public command", async () => {
    const extension = vscode.extensions.getExtension(
      "ghost-comments.ghost-comments",
    );
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("ghostComments.createNote"));
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, "sample.ts"),
    );
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("ghostComments.createNote");
  });

  test("persists deterministic workspace notes and retains the last good state", async () => {
    const store = new NoteStore(folder);
    try {
      await store.load();
      const note: StoredNote = {
        id: "integration-note",
        filePath: "sample.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
        anchor: { text: "export", before: [], after: [] },
        body: "Keep this export stable.",
        author: "Integration Test",
        status: "active",
        createdAt: "2026-09-17T10:00:00.000Z",
        updatedAt: "2026-09-17T10:00:00.000Z",
      };
      await store.upsert(note);
      const text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(store.storageUri),
      );
      assert.deepEqual(parseNoteFile(text).notes, [note]);
      note.replies = [
        {
          id: "own-reply",
          body: "**Follow-up**",
          author: note.author,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        },
      ];
      await store.upsert(note);
      await store.load();
      assert.deepEqual(store.all, [note]);
      await vscode.workspace.fs.writeFile(
        store.storageUri,
        new TextEncoder().encode("{invalid"),
      );
      await assert.rejects(() => store.load());
      assert.deepEqual(store.all, [note]);
    } finally {
      store.dispose();
    }
  });
});
