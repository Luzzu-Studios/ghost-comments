import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { trackEdits } from "../anchors/trackEdits";
import { captureAnchor, reanchor } from "../anchors/reanchor";
import type { StoredNote, TextRange } from "../model/note";
import { NoteStore } from "../storage/noteStore";
import { commentBodyText, NoteComment } from "./noteComment";

interface Binding {
  key: string;
  store: NoteStore;
  noteId: string;
  thread: vscode.CommentThread;
  note: StoredNote;
}

function storedRange(range: vscode.Range): TextRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function editorRange(range: TextRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function sameRange(a: TextRange, b: TextRange): boolean {
  return a.start.line === b.start.line && a.start.character === b.start.character
    && a.end.line === b.end.line && a.end.character === b.end.character;
}

function bindingKey(store: NoteStore, noteId: string): string {
  return `${store.workspaceFolder.uri.toString()}::${noteId}`;
}

export class NoteController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly stores = new Map<string, NoteStore>();
  private readonly bindings = new Map<string, Binding>();
  private readonly reverseBindings = new Map<vscode.CommentThread, Binding>();
  private readonly tracked = new Map<string, { uri: string; start: number; end: number; range: TextRange; anchor: StoredNote["anchor"] }>();
  private readonly pendingDeletions = new Set<string>();
  private readonly drafts = new Set<vscode.CommentThread>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController("ghostComments", "Ghost Comments");
    this.controller.options = { prompt: "Reply…", placeHolder: "Write a comment in Markdown" };
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
    this.subscriptions.push(this.controller);
    this.subscriptions.push(
      vscode.commands.registerCommand("ghostComments.createNote", () => this.run(() => this.createNote())),
      vscode.commands.registerCommand("ghostComments.submitNote", (reply: vscode.CommentReply) => this.run(() => this.submitNote(reply))),
      vscode.commands.registerCommand("ghostComments.replyNote", (reply: vscode.CommentReply) => this.run(() => this.replyNote(reply))),
      vscode.commands.registerCommand("ghostComments.cancelNote", (reply: vscode.CommentReply) => this.run(() => this.cancelNote(reply))),
      vscode.commands.registerCommand("ghostComments.editNote", (comment: NoteComment) => this.run(() => this.editNote(comment))),
      vscode.commands.registerCommand("ghostComments.saveNote", (comment: NoteComment) => this.run(() => this.saveNote(comment))),
      vscode.commands.registerCommand("ghostComments.cancelEdit", (comment: NoteComment) => this.run(() => this.cancelEdit(comment))),
      vscode.commands.registerCommand("ghostComments.deleteNote", (comment: NoteComment) => this.run(() => this.deleteNote(comment))),
      vscode.commands.registerCommand("ghostComments.reattachNote", (thread: vscode.CommentThread) => this.run(() => this.reattachNote(thread))),
      vscode.workspace.onDidOpenTextDocument((document) => this.run(() => this.validateAnchors(document))),
      vscode.workspace.onDidChangeTextDocument((event) => this.trackChanges(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        for (const [key, tracked] of this.tracked) {
          if (tracked.uri === document.uri.toString()) {
            this.tracked.delete(key);
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => this.run(() => this.refreshAnchors(document))),
      vscode.workspace.onDidRenameFiles((event) => this.run(() => this.renameFiles(event))),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => this.run(async () => {
        for (const folder of event.removed) {
          this.removeStore(folder);
        }
        for (const folder of event.added) {
          await this.addStore(folder);
        }
      })),
    );
  }

  private run(operation: () => void | Promise<void>): Promise<void> {
    return Promise.resolve().then(operation).catch((error: unknown) => {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    });
  }

  async initialize(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.addStore(folder);
    }
    for (const document of vscode.workspace.textDocuments) {
      await this.validateAnchors(document);
    }
  }

  private async addStore(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    if (this.stores.has(key)) {
      return;
    }
    const store = new NoteStore(folder);
    this.stores.set(key, store);
    this.subscriptions.push(store, store.onDidChange(() => this.reconcile(store)));
    try {
      await store.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Ghost Comments could not load ${folder.name}/.gc/notes.json: ${message}`);
    }
  }

  private removeStore(folder: vscode.WorkspaceFolder): void {
    const store = this.stores.get(folder.uri.toString());
    if (!store) {
      return;
    }
    this.clearBindings(store);
    this.stores.delete(folder.uri.toString());
    store.dispose();
  }

  private managedStore(uri: vscode.Uri): NoteStore | undefined {
    if (uri.scheme === "untitled") {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.stores.get(folder.uri.toString()) : undefined;
  }

  private requireStore(uri: vscode.Uri): NoteStore {
    const store = this.managedStore(uri);
    if (!store) {
      throw new Error("Ghost Comments notes can only be attached to files inside an open workspace folder.");
    }
    return store;
  }

  private relativePath(store: NoteStore, uri: vscode.Uri): string {
    const relative = path.posix.relative(store.workspaceFolder.uri.path, uri.path);
    if (!relative || path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
      throw new Error("The selected file must be inside its workspace folder.");
    }
    return relative;
  }

  private selection(editor: vscode.TextEditor): vscode.Range {
    return editor.selection.isEmpty ? editor.document.lineAt(editor.selection.active.line).range
      : new vscode.Range(editor.selection.start, editor.selection.end);
  }

  private createNote(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open a workspace file before creating a note.");
    }
    const store = this.requireStore(editor.document.uri);
    this.relativePath(store, editor.document.uri);
    const thread = this.controller.createCommentThread(editor.document.uri, this.selection(editor), []);
    thread.contextValue = "draft";
    thread.label = "Add a Ghost Comment";
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.drafts.add(thread);
  }

  private async submitNote(reply: vscode.CommentReply): Promise<void> {
    const body = reply.text.trim();
    const thread = reply.thread;
    if (!body || !this.drafts.has(thread) || !thread.range) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(thread.uri);
    const store = this.requireStore(thread.uri);
    const author = await this.authorName();
    if (!author) {
      return;
    }
    const range = storedRange(thread.range);
    const now = new Date().toISOString();
    const note: StoredNote = {
      id: randomUUID(),
      filePath: this.relativePath(store, thread.uri),
      range,
      anchor: captureAnchor(document.getText(), range),
      body, author, createdAt: now, updatedAt: now, status: "active",
    };
    this.drafts.delete(thread);
    thread.dispose();
    await store.upsert(note);
  }

  private async authorName(): Promise<string | undefined> {
    const configuration = vscode.workspace.getConfiguration("ghostComments");
    let author = configuration.get<string>("authorName", "").trim();
    if (!author) {
      const entered = await vscode.window.showInputBox({
        prompt: "Choose the author name stored with your Ghost Comments notes",
        placeHolder: "Display name",
        validateInput: (value) => value.trim() ? undefined : "Enter a display name.",
      });
      if (entered === undefined || !entered.trim()) {
        return;
      }
      author = entered.trim();
      await configuration.update("authorName", author, vscode.ConfigurationTarget.Global);
    }
    return author;
  }

  private async replyNote(reply: vscode.CommentReply): Promise<void> {
    const body = reply.text.trim();
    if (!body) {
      return;
    }
    const binding = this.requireBinding(reply.thread);
    const author = await this.authorName();
    if (!author) {
      return;
    }
    const note = this.currentNote(binding);
    const now = new Date().toISOString();
    await binding.store.upsert({
      ...note,
      replies: [...(note.replies ?? []), {
        id: randomUUID(), body, author, createdAt: now, updatedAt: now,
      }],
    });
  }

  private cancelNote(reply: vscode.CommentReply): void {
    if (this.drafts.delete(reply.thread)) {
      reply.thread.dispose();
    }
  }

  private requireBinding(thread: vscode.CommentThread): Binding {
    const binding = this.reverseBindings.get(thread);
    if (!binding) {
      throw new Error("This note is no longer active. Reopen it and try again.");
    }
    return binding;
  }

  private currentNote(binding: Binding): StoredNote {
    const note = binding.store.all.find((note) => note.id === binding.noteId);
    if (!note) {
      throw new Error("This note no longer exists in shared storage.");
    }
    return note;
  }

  private editNote(comment: NoteComment): void {
    this.requireBinding(comment.parent);
    comment.mode = vscode.CommentMode.Editing;
    comment.parent.comments = [...comment.parent.comments];
  }

  private async saveNote(comment: NoteComment): Promise<void> {
    const binding = this.requireBinding(comment.parent);
    const body = commentBodyText(comment.body).trim();
    if (!body) {
      throw new Error("A note cannot be empty. Delete it instead.");
    }
    const note = this.currentNote(binding);
    const updatedAt = new Date().toISOString();
    if (comment.replyId) {
      if (!note.replies?.some((reply) => reply.id === comment.replyId)) {
        throw new Error("This reply no longer exists in shared storage.");
      }
      await binding.store.upsert({ ...note, replies: note.replies.map((reply) =>
        reply.id === comment.replyId ? { ...reply, body, updatedAt } : reply) });
    } else {
      await binding.store.upsert({ ...note, body, updatedAt });
    }
    this.cancelEdit(comment);
  }

  private cancelEdit(comment: NoteComment): void {
    this.requireBinding(comment.parent);
    comment.restore();
    comment.parent.comments = [...comment.parent.comments];
  }

  private confirmDeleteNote(comment: NoteComment): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(comment.replyId ? "Delete this shared reply?" : "Delete this shared code note and all its replies?", { modal: true }, "Delete");
  }

  private async deleteNote(comment: NoteComment): Promise<void> {
    const binding = this.requireBinding(comment.parent);
    const action = await this.confirmDeleteNote(comment);
    if (action === "Delete") {
      if (comment.replyId) {
        const note = this.currentNote(binding);
        await binding.store.upsert({ ...note, replies: (note.replies ?? []).filter((reply) => reply.id !== comment.replyId) });
      } else {
        await binding.store.delete(binding.noteId);
      }
    }
  }

  private async reattachNote(thread: vscode.CommentThread): Promise<void> {
    const binding = this.requireBinding(thread);
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open a workspace file and select the new anchor first.");
    }
    if (this.requireStore(editor.document.uri) !== binding.store) {
      throw new Error("A stale note can only be reattached inside its current workspace folder.");
    }
    const range = storedRange(this.selection(editor));
    this.tracked.delete(binding.key);
    await binding.store.upsert({
      ...this.currentNote(binding),
      filePath: this.relativePath(binding.store, editor.document.uri),
      range,
      anchor: captureAnchor(editor.document.getText(), range),
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private removeBinding(binding: Binding): void {
    binding.thread.dispose();
    this.reverseBindings.delete(binding.thread);
    this.bindings.delete(binding.key);
    this.tracked.delete(binding.key);
  }

  private clearBindings(store: NoteStore): void {
    for (const binding of this.bindings.values()) {
      if (binding.store === store) {
        this.removeBinding(binding);
      }
    }
  }

  private reconcile(store: NoteStore): void {
    const notes = store.all;
    const liveKeys = new Set(notes.map((note) => bindingKey(store, note.id)));
    for (const binding of this.bindings.values()) {
      if (binding.store === store && !liveKeys.has(binding.key)) {
        this.removeBinding(binding);
      }
    }
    for (const note of notes) {
      const key = bindingKey(store, note.id);
      const uri = vscode.Uri.joinPath(store.workspaceFolder.uri, note.filePath);
      const stale = note.status === "stale";
      let binding = this.bindings.get(key);
      const collapsed = binding?.thread.collapsibleState ?? vscode.CommentThreadCollapsibleState.Collapsed;
      // VS Code makes a thread's URI read-only, so only a file move needs a new thread.
      if (binding && binding.thread.uri.toString() !== uri.toString()) {
        this.removeBinding(binding);
        binding = undefined;
      }
      const created = !binding;
      if (!binding) {
        const thread = this.controller.createCommentThread(uri, editorRange(note.range), []);
        thread.canReply = true;
        thread.collapsibleState = collapsed;
        binding = { key, store, noteId: note.id, thread, note };
        this.bindings.set(key, binding);
        this.reverseBindings.set(thread, binding);
      }
      const { thread } = binding;
      const anchorChanged = created || binding.note.status !== note.status || !sameRange(binding.note.range, note.range);
      if (anchorChanged) {
        thread.range = stale ? undefined : editorRange(note.range);
        this.tracked.delete(key);
      }
      if (thread.contextValue !== note.status) {
        thread.contextValue = note.status;
      }
      const label = stale ? "Code location missing — reattach note" : undefined;
      if (thread.label !== label) {
        thread.label = label;
      }
      const existing = new Map((thread.comments as readonly NoteComment[]).map((comment) => [comment.replyId ?? note.id, comment]));
      let changed = false;
      const comments = [note, ...(note.replies ?? [])].map((message, index) => {
        const comment = existing.get(message.id);
        if (comment) {
          changed = comment.update(message.body, message.author, message.updatedAt, stale) || changed;
          return comment;
        }
        changed = true;
        return new NoteComment(note.id, message.body, message.author, thread, message.updatedAt, stale, index === 0 ? undefined : message.id);
      });
      if (changed || comments.length !== thread.comments.length || comments.some((comment, index) => comment !== thread.comments[index])) {
        thread.comments = comments;
      }
      binding.note = note;
      const document = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
      if (document && !stale && !this.tracked.has(key)) {
        this.trackNote(store, note, document);
      }
      if (stale) {
        this.tracked.delete(key);
      }
    }
  }

  private trackNote(store: NoteStore, note: StoredNote, document: vscode.TextDocument): void {
    this.tracked.set(bindingKey(store, note.id), {
      uri: document.uri.toString(),
      start: document.offsetAt(editorRange(note.range).start),
      end: document.offsetAt(editorRange(note.range).end),
      range: note.range,
      anchor: note.anchor,
    });
  }

  private trackChanges(event: vscode.TextDocumentChangeEvent): void {
    if (!event.contentChanges.length) {
      return;
    }
    const store = this.managedStore(event.document.uri);
    if (!store) {
      return;
    }
    const filePath = this.relativePath(store, event.document.uri);
    const deleted: StoredNote[] = [];
    for (const note of store.all.filter((note) => note.filePath === filePath && note.status === "active")) {
      const key = bindingKey(store, note.id);
      const previous = this.tracked.get(key);
      if (!previous || this.pendingDeletions.has(key)) {
        continue;
      }
      const result = trackEdits(previous, event.contentChanges);
      if (result.deleted) {
        this.pendingDeletions.add(key);
        deleted.push({ ...note, range: previous.range, anchor: previous.anchor });
        this.tracked.delete(key);
      } else {
        const range = storedRange(new vscode.Range(event.document.positionAt(result.start), event.document.positionAt(result.end)));
        this.tracked.set(key, { ...previous, ...result, range, anchor: captureAnchor(event.document.getText(), range) });
      }
    }
    if (deleted.length) {
      this.run(() => this.confirmDeletedCode(store, event.document, deleted));
    }
    // Undo or pasting moved code can restore an unanchored discussion.
    this.run(async () => {
      for (const note of store.all.filter((note) => note.filePath === filePath && note.status === "stale")) {
        const result = reanchor(event.document.getText(), note.range, note.anchor);
        if (result.range) {
          const restored = { ...note, range: result.range, status: "active" as const };
          this.pendingDeletions.delete(bindingKey(store, note.id));
          this.trackNote(store, restored, event.document);
          await store.upsert(restored);
        }
      }
    });
  }

  private warnAboutDeletedCode(count: number): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(
      `You deleted code with ${count} Ghost Comments discussion(s). Deleting the associated comments will also delete all their replies. Undo the code deletion to restore the attachment, or keep the comments to reattach later.`,
      "Delete Comments", "Keep Comments",
    );
  }

  private async confirmDeletedCode(store: NoteStore, document: vscode.TextDocument, deleted: StoredNote[]): Promise<void> {
    try {
      for (const note of deleted) {
        const current = store.all.find((entry) => entry.id === note.id);
        if (current) {
          await store.upsert({ ...current, range: note.range, anchor: note.anchor, status: "stale" });
        }
      }
      const action = await this.warnAboutDeletedCode(deleted.length);
      for (const deletedNote of deleted) {
        const current = store.all.find((entry) => entry.id === deletedNote.id);
        if (!current || current.status !== "stale") {
          continue;
        }
        const result = reanchor(document.getText(), current.range, current.anchor);
        if (result.range) {
          const restored = { ...current, range: result.range, status: "active" as const };
          this.trackNote(store, restored, document);
          await store.upsert(restored);
        } else if (action === "Delete Comments") {
          await store.delete(current.id);
        }
      }
    } finally {
      for (const note of deleted) {
        this.pendingDeletions.delete(bindingKey(store, note.id));
      }
    }
  }

  private async validateAnchors(document: vscode.TextDocument): Promise<void> {
    const store = this.managedStore(document.uri);
    if (!store) {
      return;
    }
    const filePath = this.relativePath(store, document.uri);
    for (const note of store.all.filter((note) => note.filePath === filePath)) {
      if (this.pendingDeletions.has(bindingKey(store, note.id))) {
        continue;
      }
      const result = reanchor(document.getText(), note.range, note.anchor);
      const range = result.range ?? note.range;
      if (result.status === "active") {
        this.trackNote(store, { ...note, range }, document);
      }
      if (result.status !== note.status || !sameRange(range, note.range)) {
        await store.upsert({ ...note, range, status: result.status, updatedAt: new Date().toISOString() });
      }
    }
  }

  private async refreshAnchors(document: vscode.TextDocument): Promise<void> {
    const store = this.managedStore(document.uri);
    if (!store) {
      return;
    }
    const filePath = this.relativePath(store, document.uri);
    // Capture the current ranges before persisting updates.
    const updates = store.all.filter((note) => note.filePath === filePath && note.status === "active")
      .flatMap((note): StoredNote[] => {
        const key = bindingKey(store, note.id);
        if (this.pendingDeletions.has(key)) {
          return [];
        }
        const tracked = this.tracked.get(key);
        const liveRange = tracked ? editorRange(tracked.range) : this.bindings.get(key)?.thread.range;
        if (!liveRange) {
          return [];
        }
        const range = storedRange(liveRange);
        return [{ ...note, range, anchor: captureAnchor(document.getText(), range), updatedAt: new Date().toISOString() }];
      });
    for (const note of updates) {
      await store.upsert(note);
    }
  }

  private async renameFiles(event: vscode.FileRenameEvent): Promise<void> {
    for (const file of event.files) {
      const store = this.managedStore(file.oldUri);
      if (store && store === this.managedStore(file.newUri)) {
        await store.updateFilePath(this.relativePath(store, file.oldUri), this.relativePath(store, file.newUri));
      }
    }
  }

  dispose(): void {
    for (const draft of this.drafts) {
      draft.dispose();
    }
    this.drafts.clear();
    this.tracked.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
