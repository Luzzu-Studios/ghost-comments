import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { captureAnchor, reanchor } from "../anchors/reanchor";
import type { StoredNote, TextRange } from "../model/note";
import { NoteStore } from "../storage/noteStore";
import { commentBodyText, NoteComment } from "./noteComment";

interface Binding {
  key: string;
  store: NoteStore;
  noteId: string;
  thread: vscode.CommentThread;
  comment: NoteComment;
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
  private readonly drafts = new Set<vscode.CommentThread>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController("ghostComments", "Ghost Comments");
    this.controller.options = { prompt: "Add a durable code note", placeHolder: "Write a note in Markdown" };
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
    this.subscriptions.push(this.controller);
    this.subscriptions.push(
      vscode.commands.registerCommand("ghostComments.createNote", () => this.run(() => this.createNote())),
      vscode.commands.registerCommand("ghostComments.submitNote", (reply: vscode.CommentReply) => this.run(() => this.submitNote(reply))),
      vscode.commands.registerCommand("ghostComments.cancelNote", (reply: vscode.CommentReply) => this.run(() => this.cancelNote(reply))),
      vscode.commands.registerCommand("ghostComments.editNote", (comment: NoteComment) => this.run(() => this.editNote(comment))),
      vscode.commands.registerCommand("ghostComments.saveNote", (comment: NoteComment) => this.run(() => this.saveNote(comment))),
      vscode.commands.registerCommand("ghostComments.cancelEdit", (comment: NoteComment) => this.run(() => this.cancelEdit(comment))),
      vscode.commands.registerCommand("ghostComments.deleteNote", (comment: NoteComment) => this.run(() => this.deleteNote(comment))),
      vscode.commands.registerCommand("ghostComments.reattachNote", (thread: vscode.CommentThread) => this.run(() => this.reattachNote(thread))),
      vscode.workspace.onDidOpenTextDocument((document) => this.run(() => this.validateAnchors(document))),
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

  private run(operation: () => void | Promise<void>): void {
    void Promise.resolve().then(operation).catch((error: unknown) => {
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
    comment.parent.comments = [comment];
  }

  private async saveNote(comment: NoteComment): Promise<void> {
    const binding = this.requireBinding(comment.parent);
    const body = commentBodyText(comment.body).trim();
    if (!body) {
      throw new Error("A note cannot be empty. Delete it instead.");
    }
    await binding.store.upsert({ ...this.currentNote(binding), body, updatedAt: new Date().toISOString() });
  }

  private cancelEdit(comment: NoteComment): void {
    this.requireBinding(comment.parent);
    comment.restore();
    comment.parent.comments = [comment];
  }

  private async deleteNote(comment: NoteComment): Promise<void> {
    const binding = this.requireBinding(comment.parent);
    const action = await vscode.window.showWarningMessage("Delete this shared code note?", { modal: true }, "Delete");
    if (action === "Delete") {
      await binding.store.delete(binding.noteId);
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
    await binding.store.upsert({
      ...this.currentNote(binding),
      filePath: this.relativePath(binding.store, editor.document.uri),
      range,
      anchor: captureAnchor(editor.document.getText(), range),
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private clearBindings(store: NoteStore): void {
    for (const [key, binding] of this.bindings) {
      if (binding.store === store) {
        binding.thread.dispose();
        this.reverseBindings.delete(binding.thread);
        this.bindings.delete(key);
      }
    }
  }

  private reconcile(store: NoteStore): void {
    this.clearBindings(store);
    for (const note of store.all) {
      const stale = note.status === "stale";
      const thread = this.controller.createCommentThread(
        vscode.Uri.joinPath(store.workspaceFolder.uri, note.filePath),
        editorRange(note.range),
        [],
      );
      if (stale) {
        thread.range = undefined;
      }
      thread.contextValue = note.status;
      thread.label = stale ? "Stale anchor" : undefined;
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      const comment = new NoteComment(note.id, note.body, note.author, thread, note.updatedAt, stale);
      thread.comments = [comment];
      const key = bindingKey(store, note.id);
      const binding = { key, store, noteId: note.id, thread, comment };
      this.bindings.set(key, binding);
      this.reverseBindings.set(thread, binding);
    }
  }

  private async validateAnchors(document: vscode.TextDocument): Promise<void> {
    const store = this.managedStore(document.uri);
    if (!store) {
      return;
    }
    const filePath = this.relativePath(store, document.uri);
    for (const note of store.all.filter((note) => note.filePath === filePath)) {
      const result = reanchor(document.getText(), note.range, note.anchor);
      const range = result.range ?? note.range;
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
    // Capture every live range before an upsert reconciles all of this store's threads.
    const updates = store.all.filter((note) => note.filePath === filePath && note.status === "active")
      .flatMap((note): StoredNote[] => {
        const liveRange = this.bindings.get(bindingKey(store, note.id))?.thread.range;
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
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
