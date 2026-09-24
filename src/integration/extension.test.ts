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
    const extension = vscode.extensions.getExtension("LuzzuStudios.ghost-comments");
    assert.ok(extension);
    for (const color of TAG_COLORS) {
      const svg = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(tagPickerIcon(extension.extensionUri, color)),
      );
      assert.match(svg, /<svg\b/);
      assert.match(svg, /stroke="#[0-9a-f]{6}"/);
    }
  });

  test("creates tags from new notes and existing discussions", async () => {
    const configuration = vscode.workspace.getConfiguration("ghostComments");
    const previous = configuration.inspect("tags")?.workspaceValue;
    const controller = new NoteController(undefined, undefined, false);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "sample.ts"));
    const editor = await vscode.window.showTextDocument(document);
    controller["authorName"] = async () => "Tag Author";
    controller["showTagPicker"] = async () => ({ kind: "create" });
    controller["pickTagColor"] = async () => "purple";
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(0, 0, 0, 6);
      controller["promptTagName"] = async () => "Review";
      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      await controller["submitNote"]({ thread: draft, text: "Created with a tag" });
      const binding = [...controller["bindings"].values()][0]!;
      assert.equal(binding.store.all[0]!.tag, "review");
      assert.equal(binding.thread.label, "Discussion · Review");
      assert.equal(binding.thread.contextValue, "active-purple");
      const tree = new TagTreeProvider(controller, vscode.extensions.getExtension("LuzzuStudios.ghost-comments")!.extensionUri);
      try {
        assert.equal(tree.getTreeItem(tree.getChildren()[0]!).label, "Review");
      } finally {
        tree.dispose();
      }
      controller["promptTagName"] = async () => "Review Again";
      await controller["setTag"](binding.thread);
      assert.equal(binding.store.all[0]!.tag, "review-again");
      assert.equal(binding.thread.label, "Discussion · Review Again");
      const tags = vscode.workspace.getConfiguration("ghostComments")
        .get<{ id: string; label: string; color: string }[]>("tags")!;
      assert.deepEqual(tags.slice(-2), [
        { id: "review", label: "Review", color: "purple" },
        { id: "review-again", label: "Review Again", color: "purple" },
      ]);
    } finally {
      controller.dispose();
      await configuration.update("tags", previous, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("keeps drafts and existing tags when creation is cancelled or fails", async () => {
    const controller = new NoteController(undefined, undefined, false);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "sample.ts"));
    const editor = await vscode.window.showTextDocument(document);
    controller["authorName"] = async () => "Tag Author";
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(0, 0, 0, 6);
      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      controller["showTagPicker"] = async () => undefined;
      await controller["submitNote"]({ thread: draft, text: "Keep this draft" });
      assert.equal(controller["drafts"].has(draft), true);
      assert.equal((draft.comments[0] as NoteComment).savedBody, "Keep this draft");
      assert.equal([...controller["stores"].values()][0]!.all.length, 0);
      let selections = 0;
      controller["showTagPicker"] = async () =>
        ++selections === 1 ? { kind: "create" } : { kind: "tag", tagId: null };
      controller["promptTagName"] = async () => undefined;
      assert.equal(await controller["pickTag"](), null);
      assert.equal(selections, 2);
      selections = 0;
      controller["promptTagName"] = async () => "Cancelled Color";
      controller["pickTagColor"] = async () => undefined;
      assert.equal(await controller["pickTag"](), null);
      assert.equal(selections, 2);
      selections = 0;
      controller["promptTagName"] = async () => "Cannot Save";
      controller["pickTagColor"] = async () => "red";
      controller["saveTagDefinition"] = async () => { throw new Error("test settings failure"); };
      controller["showTagPicker"] = async () =>
        ++selections === 1 ? { kind: "create" } : undefined;
      await controller["submitNote"]({ thread: draft, text: "Keep this draft" });
      assert.equal(controller["drafts"].has(draft), true);
      assert.equal((draft.comments[0] as NoteComment).savedBody, "Keep this draft");
      assert.equal([...controller["stores"].values()][0]!.all.length, 0);
      assert.equal(selections, 2);
      controller["showTagPicker"] = async () => ({ kind: "tag", tagId: null });
      await controller["submitNote"]({ thread: draft, text: "Keep this draft" });
      const binding = [...controller["bindings"].values()][0]!;
      const before = binding.store.all[0]!;
      selections = 0;
      controller["showTagPicker"] = async () =>
        ++selections === 1 ? { kind: "create" } : undefined;
      await controller["setTag"](binding.thread);
      assert.equal(binding.store.all[0]!.tag, before.tag);
      assert.equal(binding.store.all[0]!.updatedAt, before.updatedAt);
      assert.equal(selections, 2);
    } finally {
      controller.dispose();
    }
  });

  test("submits and cancels drafts without modifying source code", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "sample.ts"));
    const editor = await vscode.window.showTextDocument(document);
    const original = document.getText();
    const controller = new NoteController(undefined, undefined, false);
    controller["authorName"] = async () => "Draft Test";
    controller["pickTag"] = async () => null;
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(0, 0, 0, 6);
      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      const comment = draft.comments[0] as NoteComment;
      assert.equal(comment.mode, vscode.CommentMode.Editing);
      await controller["submitNote"]({ thread: draft, text: "Typed into the note" });
      assert.equal(document.getText(), original);
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

  test("validates comment bodies before prompting or saving", async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, "sample.ts"),
    );
    const editor = await vscode.window.showTextDocument(document);
    const controller = new NoteController(undefined, undefined, false);
    let authorPrompts = 0;
    let tagPrompts = 0;
    controller["authorName"] = async () => {
      authorPrompts += 1;
      return "Validation Test";
    };
    controller["pickTag"] = async () => {
      tagPrompts += 1;
      return null;
    };
    try {
      await controller.initialize();
      editor.selection = new vscode.Selection(0, 0, 0, 6);
      const store = [...controller["stores"].values()][0]!;

      for (const text of ["", " \n\t "]) {
        controller["createNote"]();
        const draft = [...controller["drafts"]][0]!;
        let disposed = false;
        const dispose = draft.dispose.bind(draft);
        draft.dispose = () => {
          disposed = true;
          dispose();
        };
        // VS Code changes an editing comment to preview before invoking Save.
        const draftComment = draft.comments[0] as NoteComment;
        draftComment.mode = vscode.CommentMode.Preview;
        draft.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        await assert.rejects(
          controller["submitNote"]({ thread: draft, text }),
          /Enter a comment before saving/,
        );
        assert.equal(controller["drafts"].has(draft), false);
        assert.equal(controller["draftAwaitingEditor"], undefined);
        assert.equal(disposed, true);
        assert.equal(store.all.length, 0);
      }
      assert.equal(authorPrompts, 0);
      assert.equal(tagPrompts, 0);

      controller["createNote"]();
      const draft = [...controller["drafts"]][0]!;
      await controller["submitNote"]({
        thread: draft,
        text: "  **Safe markdown** [command](command:workbench.action.closeWindow)  ",
      });
      assert.equal(
        store.all[0]!.body,
        "**Safe markdown** [command](command:workbench.action.closeWindow)",
      );
      assert.equal(authorPrompts, 1);
      assert.equal(tagPrompts, 1);

      const binding = [...controller["bindings"].values()][0]!;
      const noteComment = binding.thread.comments[0] as NoteComment;
      assert.equal(noteComment.body.isTrusted, false);
      assert.equal(noteComment.body.supportHtml, false);

      await assert.rejects(
        controller["replyNote"]({ thread: binding.thread, text: " \t " }),
        /Enter a comment before saving/,
      );
      assert.equal(authorPrompts, 1);
      assert.equal(store.all[0]!.replies, undefined);

      await controller["replyNote"]({
        thread: binding.thread,
        text: "  Reply with <b>HTML</b>  ",
      });
      assert.equal(store.all[0]!.replies![0]!.body, "Reply with <b>HTML</b>");
      const replyComment = binding.thread.comments[1] as NoteComment;

      controller["editNote"](noteComment);
      noteComment.body = new vscode.MarkdownString(" \n ");
      await assert.rejects(
        controller["saveNote"](noteComment),
        /Enter a comment before saving/,
      );
      assert.equal(store.all[0]!.body.startsWith("**Safe markdown**"), true);
      assert.equal(noteComment.mode, vscode.CommentMode.Preview);
      assert.equal(
        noteComment.body.value,
        "**Safe markdown** [command](command:workbench.action.closeWindow)",
      );

      controller["editNote"](replyComment);
      replyComment.body = new vscode.MarkdownString("\t");
      await assert.rejects(
        controller["saveNote"](replyComment),
        /Enter a comment before saving/,
      );
      assert.equal(store.all[0]!.replies![0]!.body, "Reply with <b>HTML</b>");
      assert.equal(replyComment.mode, vscode.CommentMode.Preview);
      assert.equal(replyComment.body.value, "Reply with <b>HTML</b>");

      const tree = new TagTreeProvider(
        controller,
        vscode.extensions.getExtension("LuzzuStudios.ghost-comments")!.extensionUri,
      );
      try {
        const tagNode = tree.getChildren()[0]!;
        const fileNode = tree.getChildren(tagNode)[0]!;
        const noteNode = tree.getChildren(fileNode)[0]!;
        const noteTooltip = tree.getTreeItem(noteNode).tooltip as vscode.MarkdownString;
        assert.equal(noteTooltip.isTrusted, false);
        assert.equal(noteTooltip.supportHtml, false);
        const replyNode = tree.getChildren(noteNode)[0]!;
        const replyTooltip = tree.getTreeItem(replyNode).tooltip as vscode.MarkdownString;
        assert.equal(replyTooltip.isTrusted, false);
        assert.equal(replyTooltip.supportHtml, false);
      } finally {
        tree.dispose();
      }
    } finally {
      controller.dispose();
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
      const tagTree = new TagTreeProvider(controller, vscode.extensions.getExtension("LuzzuStudios.ghost-comments")!.extensionUri);
      try {
        const tagNodes = tagTree.getChildren();
        assert.equal(tagNodes.length, 1);
        const tagItem = tagTree.getTreeItem(tagNodes[0]!);
        assert.equal(tagItem.label, "To Do");
        assert.equal((tagItem.iconPath as vscode.Uri).path.endsWith("/assets/tag-icons/orange.svg"), true);
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
      const storageTemporary = vscode.Uri.joinPath(folder.uri, ".gc", "comments.json.tmp");
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
      const repliesTree = new TagTreeProvider(controller, vscode.extensions.getExtension("LuzzuStudios.ghost-comments")!.extensionUri);
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
      const updatedTree = new TagTreeProvider(controller, vscode.extensions.getExtension("LuzzuStudios.ghost-comments")!.extensionUri);
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
      "LuzzuStudios.ghost-comments",
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

  test("migrates legacy notes storage to comments storage", async () => {
    const store = new NoteStore(folder);
    const legacyUri = vscode.Uri.joinPath(folder.uri, ".gc", "notes.json");
    const legacyBackupUri = vscode.Uri.joinPath(folder.uri, ".gc", "notes-backup.json");
    const note: StoredNote = {
      id: "legacy-note",
      filePath: "sample.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      anchor: { text: "export", before: [], after: [] },
      body: "Migrated comment",
      author: "Migration Test",
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
      status: "active",
    };
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".gc"));
      await vscode.workspace.fs.writeFile(
        legacyUri,
        new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, notes: [note] })),
      );
      await vscode.workspace.fs.writeFile(
        legacyBackupUri,
        new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, notes: [note] })),
      );

      await store.load();

      assert.deepEqual(store.all, [note]);
      assert.deepEqual(
        parseNoteFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(store.storageUri))).notes,
        [note],
      );
      assert.deepEqual(
        parseNoteFile(new TextDecoder().decode(await vscode.workspace.fs.readFile(store.backupUri))).notes,
        [note],
      );
      await assert.rejects(async () => vscode.workspace.fs.stat(legacyUri));
      await assert.rejects(async () => vscode.workspace.fs.stat(legacyBackupUri));
    } finally {
      store.dispose();
    }
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
      const backupTemporary = vscode.Uri.joinPath(folder.uri, ".gc", "comments-backup.json.tmp");
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
      const primaryTemporary = vscode.Uri.joinPath(folder.uri, ".gc", "comments.json.tmp");
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
