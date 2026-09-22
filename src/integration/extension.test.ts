import assert from "node:assert/strict";
import * as vscode from "vscode";
import { parseNoteFile } from "../model/note";
import type { StoredNote } from "../model/note";
import { NoteController } from "../comments/noteController";
import type { NoteComment } from "../comments/noteComment";
import { NoteStore } from "../storage/noteStore";
import type { BackupState } from "../storage/noteStore";
import { TagTreeProvider } from "../tags/tagTree";
import { tagPickerIcon } from "../tags/tagConfiguration";
import { TAG_COLORS } from "../tags/tagDefinitions";

suite("Ghost Comments", () => {
  const folder = vscode.workspace.workspaceFolders![0]!;

  class MemoryBackupState implements BackupState {
    private readonly values = new Map<string, unknown>();

    get<T>(key: string, defaultValue: T): T {
      return (this.values.get(key) as T | undefined) ?? defaultValue;
    }

    update(key: string, value: unknown): Thenable<void> {
      this.values.set(key, value);
      return Promise.resolve();
    }
  }

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

  test("provides colored tag icons for the picker", async () => {
    const extension = vscode.extensions.getExtension("ghost-comments.ghost-comments");
    assert.ok(extension);
    for (const color of TAG_COLORS) {
      const svg = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(tagPickerIcon(extension.extensionUri, color)),
      );
      assert.match(svg, /<svg\b/);
      assert.match(svg, /stroke="#[0-9a-f]{6}"/);
    }
  });

  test("new draft takes typing focus without modifying source code", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "sample.ts"));
    const editor = await vscode.window.showTextDocument(document);
    const original = document.getText();
    const controller = new NoteController(undefined, undefined, false);
    controller["authorName"] = async () => "Focus Test";
    controller["pickTag"] = async () => null;
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(0, 0, 0, 6);
      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      const comment = draft.comments[0] as NoteComment;
      assert.equal(comment.mode, vscode.CommentMode.Editing);
      // Allow the native comment widget to render, without clicking or moving focus.
      await new Promise((resolve) => setTimeout(resolve, 700));
      console.log("FOCUS DEBUG", draft.collapsibleState, controller["draftAwaitingEditor"] !== undefined, vscode.workspace.textDocuments.map((d) => d.uri.toString()));
      await vscode.commands.executeCommand("type", { text: "Typed into the note" });
      assert.equal(document.getText(), original);
      const commentDocument = vscode.workspace.textDocuments.find((entry) =>
        entry.uri.scheme === "comment" && entry.getText() === "Typed into the note"
      );
      assert.ok(commentDocument);
      await controller["submitNote"]({ thread: draft, text: commentDocument.getText() });
      for (let attempt = 0; attempt < 100 && controller["drafts"].size; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(controller["drafts"].size, 0);
      const store = [...controller["stores"].values()][0]!;
      assert.equal(store.all[0]!.body, "Typed into the note");
      await vscode.window.showTextDocument(document);
      controller["createNote"]();
      const cancelled = [...controller["drafts"]][0]!;
      controller["cancelEdit"](cancelled.comments[0] as NoteComment);
      assert.equal(controller["drafts"].size, 0);
      assert.equal(store.all.length, 1);
    } finally {
      controller.dispose();
      if (document.getText() !== original) {
        const restore = new vscode.WorkspaceEdit();
        restore.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
        await vscode.workspace.applyEdit(restore);
      }
    }
  });

  test("preserves detached discussions until explicit selection or line reattachment", async () => {
    const controller = new NoteController(undefined, undefined, false);
    controller["authorName"] = async () => "Integration Author";
    controller["pickTag"] = async () => "todo";
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
      assert.equal(binding().store.all[0]!.tag, "todo");
      assert.equal(binding().thread.label, "Discussion · To Do");
      assert.equal(binding().thread.contextValue, "active-orange");
      assert.equal((binding().thread.comments[0] as NoteComment).label, undefined);
      const tagTree = new TagTreeProvider(controller);
      try {
        const tagNodes = tagTree.getChildren();
        assert.equal(tagNodes.length, 1);
        assert.equal(tagTree.getTreeItem(tagNodes[0]!).label, "To Do");
        const fileNodes = tagTree.getChildren(tagNodes[0]!);
        assert.equal(fileNodes.length, 1);
        assert.equal(tagTree.getTreeItem(fileNodes[0]!).label, "sample.ts");
        const noteNodes = tagTree.getChildren(fileNodes[0]!);
        assert.equal(noteNodes.length, 1);
        assert.equal(tagTree.getTreeItem(noteNodes[0]!).label, "Initial note");
      } finally {
        tagTree.dispose();
      }
      assert.equal(binding().thread.canReply, true);
      let originalUpdatedAt = binding().store.all[0]!.updatedAt;
      const storageBeforeUnchangedSave = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(binding().store.storageUri),
      );
      const storageTemporary = vscode.Uri.joinPath(folder.uri, ".gc", "notes.json.tmp");
      await vscode.workspace.fs.createDirectory(storageTemporary);
      try {
        await controller["refreshAnchors"](document);
      } finally {
        await vscode.workspace.fs.delete(storageTemporary, { recursive: true });
      }
      assert.equal(
        new TextDecoder().decode(
          await vscode.workspace.fs.readFile(binding().store.storageUri),
        ),
        storageBeforeUnchangedSave,
      );
      assert.equal(binding().store.all[0]!.updatedAt, originalUpdatedAt);
      await new Promise((resolve) => setTimeout(resolve, 2));
      controller["pickTag"] = async () => "question";
      await controller["setTag"](binding().thread);
      assert.equal(binding().store.all[0]!.tag, "question");
      assert.equal(binding().thread.label, "Discussion · Question");
      assert.equal(binding().thread.contextValue, "active-blue");
      assert.equal((binding().thread.comments[0] as NoteComment).label, undefined);
      assert.notEqual(binding().store.all[0]!.updatedAt, originalUpdatedAt);
      await controller["clearTag"](binding().thread);
      assert.equal(binding().store.all[0]!.tag, undefined);
      assert.equal(binding().thread.label, "Discussion");
      assert.equal(binding().thread.contextValue, "active-untagged");
      assert.equal((binding().thread.comments[0] as NoteComment).label, undefined);
      originalUpdatedAt = binding().store.all[0]!.updatedAt;
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
      let firstReplyTreeId: string | undefined;
      const repliesTree = new TagTreeProvider(controller);
      try {
        const tagNode = repliesTree.getChildren()[0]!;
        const fileNode = repliesTree.getChildren(tagNode)[0]!;
        const noteNode = repliesTree.getChildren(fileNode)[0]!;
        const noteItem = repliesTree.getTreeItem(noteNode);
        assert.equal(noteItem.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        const replyNodes = repliesTree.getChildren(noteNode);
        assert.equal(replyNodes.length, 1);
        const replyItem = repliesTree.getTreeItem(replyNodes[0]!);
        firstReplyTreeId = replyItem.id;
        assert.equal(replyItem.label, "Edited reply");
        assert.equal(replyItem.description, "Integration Author");
        assert.equal((replyItem.tooltip as vscode.MarkdownString).value, "Edited reply");
        await controller.revealDiscussion(replyItem.command!.arguments![0]);
        assert.equal(binding().thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
      } finally {
        repliesTree.dispose();
      }
      const range = binding().thread.range!;
      const deletedText = document.getText(range);
      const edit = new vscode.WorkspaceEdit();
      edit.delete(document.uri, range);
      await vscode.workspace.applyEdit(edit);
      await waitFor(() => finishWarning !== undefined);
      assert.equal(binding().store.all[0]!.status, "stale");
      assert.equal(binding().thread.contextValue, "stale-untagged");
      assert.equal(binding().store.all[0]!.updatedAt, originalUpdatedAt);
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
      assert.equal(detachedComment.label, undefined);
      assert.equal(binding().thread.label, "⚠️ Needs reattachment");
      assert.equal(detachedComment.body.value, "Initial note ⚠️");
      assert.equal(binding().store.all[0]!.body, "Initial note");
      controller["editNote"](detachedComment);
      assert.equal(detachedComment.body.value, "Initial note");
      controller["cancelEdit"](detachedComment);
      assert.equal(detachedComment.body.value, "Initial note ⚠️");
      finishWarning!("Reattach…");
      await waitFor(() => attachmentPrompts.length === 1);
      const detachedNoteId = binding().store.all[0]!.id;
      await controller["replyNote"]({
        thread: binding().thread,
        text: "Reply while detached\nMore detail",
      });
      assert.equal(binding().store.all.length, 1);
      assert.equal(binding().store.all[0]!.id, detachedNoteId);
      assert.equal(binding().store.all[0]!.status, "stale");
      assert.equal(binding().thread.range, undefined);
      assert.equal(binding().thread.label, "⚠️ Needs reattachment");
      assert.equal(binding().thread.comments.length, 3);
      const detachedReply = binding().thread.comments[2] as NoteComment;
      assert.equal(detachedReply.parent, binding().thread);
      assert.equal(detachedReply.body.value, "Reply while detached\nMore detail");
      assert.equal(binding().store.all[0]!.replies![1]!.body, "Reply while detached\nMore detail");
      const updatedTree = new TagTreeProvider(controller);
      try {
        const tagNode = updatedTree.getChildren()[0]!;
        const fileNode = updatedTree.getChildren(tagNode)[0]!;
        const noteNode = updatedTree.getChildren(fileNode)[0]!;
        const replyNodes = updatedTree.getChildren(noteNode);
        assert.deepEqual(replyNodes.map((node) => updatedTree.getTreeItem(node).label), [
          "Edited reply",
          "Reply while detached",
        ]);
        assert.equal(updatedTree.getTreeItem(replyNodes[0]!).id, firstReplyTreeId);
        assert.equal(
          (updatedTree.getTreeItem(replyNodes[1]!).tooltip as vscode.MarkdownString).value,
          "Reply while detached\nMore detail",
        );
      } finally {
        updatedTree.dispose();
      }
      await controller.revealDiscussion({ workspaceUri: folder.uri.toString(), noteId: detachedNoteId });
      assert.equal(binding().thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
      const originalReplies = binding().store.all[0]!.replies;
      assert.equal(binding().store.all[0]!.status, "stale");
      attachmentPrompts[0]!("Cancel");
      await waitFor(() => controller["pendingAttachment"] === undefined);
      assert.equal(controller["pendingAttachment"], undefined);
      assert.equal(binding().store.all[0]!.status, "stale");
      assert.equal(detachedComment.label, undefined);
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
      assert.equal(binding().thread.label, "Discussion");
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
    const controller = new NoteController(undefined, undefined, false);
    controller["pickTag"] = async () => null;
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
    assert.ok(commands.includes("ghostComments.setTag"));
    for (const color of TAG_COLORS) {
      assert.ok(commands.includes(`ghostComments.setTag.${color}`));
    }
    assert.ok(commands.includes("ghostComments.clearTag"));
    assert.ok(commands.includes("ghostComments.revealDiscussion"));
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
      const originalBackup = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(store.backupUri),
      );
      assert.deepEqual(parseNoteFile(text).notes, [note]);
      assert.equal(originalBackup, text);
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
      assert.equal(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(store.backupUri)),
        originalBackup,
      );
      await vscode.workspace.fs.delete(store.storageUri);
      await store.load();
      assert.deepEqual(store.all, []);
      assert.equal(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(store.backupUri)),
        originalBackup,
      );
    } finally {
      store.dispose();
    }
  });

  test("creates and periodically updates a durable notes backup", async () => {
    const state = new MemoryBackupState();
    let interval = 2;
    let store = new NoteStore(folder, state, () => interval);
    const note: StoredNote = {
      id: "backup-note",
      filePath: "sample.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 6 },
      },
      anchor: { text: "export", before: [], after: [] },
      body: "First version",
      author: "Backup Test",
      status: "active",
      createdAt: "2026-09-21T10:00:00.000Z",
      updatedAt: "2026-09-21T10:00:00.000Z",
    };
    const read = async (uri: vscode.Uri): Promise<string> =>
      new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));

    try {
      await store.load();
      await store.upsert(note);
      const firstBackup = await read(store.backupUri);
      assert.equal(firstBackup, await read(store.storageUri));

      const secondNote: StoredNote = {
        ...note,
        id: "second-backup-note",
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 6 },
        },
        body: "Second note",
      };
      await store.upsertMany([
        { ...note, body: "Second version" },
        secondNote,
      ]);
      assert.equal(await read(store.backupUri), firstBackup);

      // Recreating the store simulates a VS Code restart. The shared state keeps
      // the pending count, so the next change reaches the configured interval.
      store.dispose();
      store = new NoteStore(folder, state, () => interval);
      await store.load();
      await store.upsert({ ...store.all[0]!, body: "Third version" });
      const batchedBackup = parseNoteFile(await read(store.backupUri)).notes;
      assert.equal(batchedBackup.length, 2);
      assert.equal(batchedBackup[0]!.body, "Third version");

      // A lower interval applies on the next change, while zero pauses updates.
      interval = 0;
      const pausedBackup = await read(store.backupUri);
      await store.upsert({ ...store.all[0]!, body: "Paused version" });
      assert.equal(await read(store.backupUri), pausedBackup);
      interval = 1;
      await store.upsert({ ...store.all[0]!, body: "Resumed version" });
      assert.equal(parseNoteFile(await read(store.backupUri)).notes[0]!.body, "Resumed version");

      // A failed backup leaves the primary save in place and remains due for retry.
      const backupTemporary = vscode.Uri.joinPath(folder.uri, ".gc", "notes-backup.json.tmp");
      await vscode.workspace.fs.createDirectory(backupTemporary);
      await assert.rejects(() =>
        store.upsert({ ...store.all[0]!, body: "Backup initially fails" }),
      );
      assert.equal(parseNoteFile(await read(store.storageUri)).notes[0]!.body, "Backup initially fails");
      assert.notEqual(parseNoteFile(await read(store.backupUri)).notes[0]!.body, "Backup initially fails");
      await vscode.workspace.fs.delete(backupTemporary, { recursive: true });
      await store.upsert({ ...store.all[0]!, body: "Backup retry succeeds" });
      assert.equal(parseNoteFile(await read(store.backupUri)).notes[0]!.body, "Backup retry succeeds");

      // A primary-write failure restores the in-memory and on-disk states.
      const primaryBeforeFailure = await read(store.storageUri);
      const primaryTemporary = vscode.Uri.joinPath(folder.uri, ".gc", "notes.json.tmp");
      await vscode.workspace.fs.createDirectory(primaryTemporary);
      await assert.rejects(() =>
        store.upsert({ ...store.all[0]!, body: "Primary write fails" }),
      );
      assert.equal(await read(store.storageUri), primaryBeforeFailure);
      assert.notEqual(store.all[0]!.body, "Primary write fails");
      await vscode.workspace.fs.delete(primaryTemporary, { recursive: true });

      // Removing a backup recreates it on the next enabled change.
      await vscode.workspace.fs.delete(store.backupUri);
      await store.upsert({ ...store.all[0]!, body: "Replacement backup" });
      assert.equal(parseNoteFile(await read(store.backupUri)).notes[0]!.body, "Replacement backup");
    } finally {
      store.dispose();
    }
  });
});
