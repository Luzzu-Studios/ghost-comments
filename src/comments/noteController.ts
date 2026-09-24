import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { trackEdits } from "../anchors/trackEdits";
import { captureAnchor, reanchor } from "../anchors/reanchor";
import type { StoredNote, TextRange } from "../model/note";
import { NoteStore } from "../storage/noteStore";
import type { BackupState } from "../storage/noteStore";
import { configuredTags, tagPickerIcon } from "../tags/tagConfiguration";
import { DEFAULT_TAGS, displayTag, nativeTagLabel, newTagId, parseTagDefinitions, tagNameExists, TAG_COLORS } from "../tags/tagDefinitions";
import type { TagColor, TagDefinition } from "../tags/tagDefinitions";
import { commentBodyText, NoteComment } from "./noteComment";

interface Binding {
  key: string;
  store: NoteStore;
  noteId: string;
  thread: vscode.CommentThread;
  note: StoredNote;
}

export interface DiscussionReference {
  workspaceUri: string;
  noteId: string;
}

export interface DiscussionSummary extends DiscussionReference {
  workspaceFolder: vscode.WorkspaceFolder;
  note: StoredNote;
}

function storedRange(range: vscode.Range): TextRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function editorRange(range: TextRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function sameRange(a: TextRange, b: TextRange): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function sameAnchor(a: StoredNote["anchor"], b: StoredNote["anchor"]): boolean {
  return (
    a.text === b.text &&
    a.before.length === b.before.length &&
    a.before.every((line, index) => line === b.before[index]) &&
    a.after.length === b.after.length &&
    a.after.every((line, index) => line === b.after[index])
  );
}

function bindingKey(store: NoteStore, noteId: string): string {
  return `${store.workspaceFolder.uri.toString()}::${noteId}`;
}

export class NoteController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly stores = new Map<string, NoteStore>();
  private readonly bindings = new Map<string, Binding>();
  private readonly reverseBindings = new Map<vscode.CommentThread, Binding>();
  private readonly tracked = new Map<
    string,
    {
      uri: string;
      start: number;
      end: number;
      range: TextRange;
      anchor: StoredNote["anchor"];
    }
  >();
  private readonly pendingDeletions = new Set<string>();
  private pendingAttachment: string | undefined;
  private attachmentPromptId = 0;
  private draftAwaitingEditor: vscode.CommentThread | undefined;
  private readonly attachmentStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  private readonly notifiedDetached = new Set<string>();
  private readonly drafts = new Set<vscode.CommentThread>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly discussionsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeDiscussions = this.discussionsEmitter.event;

  constructor(
    private readonly backupState?: BackupState,
    private readonly extensionUri?: vscode.Uri,
    registerCommands = true,
  ) {
    this.controller = vscode.comments.createCommentController(
      "ghostComments",
      "Ghost Comments",
    );
    this.controller.options = {
      prompt: "Reply…",
      placeHolder: "Write a comment in Markdown",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: () => [],
    };
    this.attachmentStatus.text = "$(link) Ghost Comments: Attach here";
    this.attachmentStatus.tooltip =
      "Select code or place the cursor on a line, then click to attach the detached note.";
    this.attachmentStatus.command = "ghostComments.attachHere";
    this.subscriptions.push(this.controller, this.attachmentStatus);
    if (registerCommands) {
      this.subscriptions.push(
        vscode.commands.registerCommand("ghostComments.createNote", () =>
          this.run(() => this.createNote()),
        ),
        vscode.commands.registerCommand(
          "ghostComments.submitNote",
          (reply: vscode.CommentReply) => this.run(() => this.submitNote(reply)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.replyNote",
          (reply: vscode.CommentReply) => this.run(() => this.replyNote(reply)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.cancelNote",
          (reply: vscode.CommentReply) => this.run(() => this.cancelNote(reply)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.editNote",
          (comment: NoteComment) => this.run(() => this.editNote(comment)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.saveNote",
          (comment: NoteComment) => this.run(() => this.saveNote(comment)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.cancelEdit",
          (comment: NoteComment) => this.run(() => this.cancelEdit(comment)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.deleteNote",
          (comment: NoteComment) => this.run(() => this.deleteNote(comment)),
        ),
        vscode.commands.registerCommand(
          "ghostComments.reattachNote",
          (thread: vscode.CommentThread) =>
            this.run(() => this.reattachNote(thread)),
        ),
        vscode.commands.registerCommand("ghostComments.attachHere", () =>
          this.run(() => this.attachHere()),
        ),
        vscode.commands.registerCommand("ghostComments.cancelReattach", () =>
          this.cancelReattach(),
        ),
        vscode.commands.registerCommand(
          "ghostComments.setTag",
          (target?: vscode.CommentThread | DiscussionReference) =>
            this.run(() => this.setTag(target)),
        ),
        ...TAG_COLORS.map((color) =>
          vscode.commands.registerCommand(
            `ghostComments.setTag.${color}`,
            (target?: vscode.CommentThread | DiscussionReference) =>
              this.run(() => this.setTag(target)),
          )
        ),
        vscode.commands.registerCommand(
          "ghostComments.clearTag",
          (target?: vscode.CommentThread | DiscussionReference) =>
            this.run(() => this.clearTag(target)),
        ),
      );
    }
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.scheme === "comment" && this.draftAwaitingEditor) {
          const draft = this.draftAwaitingEditor;
          this.draftAwaitingEditor = undefined;
          if (this.drafts.has(draft)) {
            const comment = draft.comments[0] as NoteComment;
            const focused = new NoteComment(comment.noteId, document.getText(), comment.author.name, draft, comment.timestamp.toISOString(), false);
            focused.mode = vscode.CommentMode.Editing;
            draft.comments = [focused];
          }
        }
        return this.run(() => this.validateAnchors(document));
      }),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.trackChanges(event),
      ),
      vscode.workspace.onDidCloseTextDocument((document) => {
        for (const [key, tracked] of this.tracked) {
          if (tracked.uri === document.uri.toString()) {
            this.tracked.delete(key);
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) =>
        this.run(() => this.refreshAnchors(document)),
      ),
      vscode.workspace.onDidRenameFiles((event) =>
        this.run(() => this.renameFiles(event)),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders((event) =>
        this.run(async () => {
          for (const folder of event.removed) {
            this.removeStore(folder);
          }
          for (const folder of event.added) {
            await this.addStore(folder);
          }
        }),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("ghostComments.tags")) {
          return;
        }
        for (const store of this.stores.values()) {
          this.reconcile(store);
        }
        this.discussionsEmitter.fire();
      }),
      this.discussionsEmitter,
    );
  }

  get discussions(): readonly DiscussionSummary[] {
    return [...this.stores.values()].flatMap((store) =>
      store.all.map((note) => ({
        workspaceUri: store.workspaceFolder.uri.toString(),
        noteId: note.id,
        workspaceFolder: store.workspaceFolder,
        note,
      })),
    );
  }

  private run(operation: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
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
    const store = new NoteStore(folder, this.backupState);
    this.stores.set(key, store);
    this.subscriptions.push(
      store,
      store.onDidChange(() => {
        this.reconcile(store);
        this.discussionsEmitter.fire();
      }),
    );
    try {
      await store.load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Ghost Comments could not load ${folder.name}/.gc/comments.json: ${message}`,
      );
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
    this.discussionsEmitter.fire();
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
      throw new Error(
        "Ghost Comments notes can only be attached to files inside an open workspace folder.",
      );
    }
    return store;
  }

  private relativePath(store: NoteStore, uri: vscode.Uri): string {
    const relative = path.posix.relative(
      store.workspaceFolder.uri.path,
      uri.path,
    );
    if (
      !relative ||
      path.posix.isAbsolute(relative) ||
      relative.split("/").includes("..")
    ) {
      throw new Error("The selected file must be inside its workspace folder.");
    }
    return relative;
  }

  private selection(editor: vscode.TextEditor): vscode.Range {
    return editor.selection.isEmpty
      ? editor.document.lineAt(editor.selection.active.line).range
      : new vscode.Range(editor.selection.start, editor.selection.end);
  }

  private createNote(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error("Open a workspace file before creating a note.");
    }
    const store = this.requireStore(editor.document.uri);
    this.relativePath(store, editor.document.uri);
    const thread = this.controller.createCommentThread(
      editor.document.uri,
      this.selection(editor),
      [],
    );
    thread.contextValue = "draft";
    thread.label = "Add a Ghost Comment";
    // An editing comment receives native editor focus when the draft expands.
    // An empty reply form can expand while keyboard focus stays in the source.
    const draft = new NoteComment(
      randomUUID(), "", vscode.workspace.getConfiguration("ghostComments").get<string>("authorName", "").trim() || "You",
      thread, new Date().toISOString(), false,
    );
    draft.mode = vscode.CommentMode.Editing;
    thread.canReply = false;
    thread.comments = [draft];
    // Expand after VS Code creates the input model: expanding before that
    // lets the source editor reclaim focus while the widget is being laid out.
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.drafts.add(thread);
    this.draftAwaitingEditor = thread;
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
    const selectedTag = await this.pickTag();
    if (selectedTag === undefined) {
      const draft = thread.comments[0] as NoteComment;
      draft.savedBody = body;
      draft.body = new vscode.MarkdownString(body);
      draft.mode = vscode.CommentMode.Editing;
      thread.comments = [draft];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return;
    }
    const note: StoredNote = {
      ...(selectedTag ? { tag: selectedTag } : {}),
      id: randomUUID(),
      filePath: this.relativePath(store, thread.uri),
      range,
      anchor: captureAnchor(document.getText(), range),
      body,
      author,
      createdAt: now,
      updatedAt: now,
      status: "active",
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
        validateInput: (value) =>
          value.trim() ? undefined : "Enter a display name.",
      });
      if (entered === undefined || !entered.trim()) {
        return;
      }
      author = entered.trim();
      await configuration.update(
        "authorName",
        author,
        vscode.ConfigurationTarget.Global,
      );
    }
    return author;
  }

  private async pickTag(): Promise<string | null | undefined> {
    for (;;) {
      const choice = await this.showTagPicker();
      if (!choice) {
        return undefined;
      }
      if (choice.kind === "tag") {
        return choice.tagId;
      }
      const created = await this.createTag();
      if (created) {
        return created;
      }
    }
  }

  private async showTagPicker(): Promise<
    { kind: "tag"; tagId: string | null } | { kind: "create" } | undefined
  > {
    type TagPickItem = vscode.QuickPickItem & (
      { choiceType: "tag"; tagId: string | null } | { choiceType: "create" }
    );
    const definitions = configuredTags();
    const untagged: TagPickItem = {
      choiceType: "tag", tagId: null, label: "Untagged", description: "No category",
    };
    const picker = vscode.window.createQuickPick<TagPickItem>();
    picker.items = [
      untagged,
      ...definitions.map((tag): TagPickItem => ({
        choiceType: "tag", tagId: tag.id,
        label: nativeTagLabel(tag.id, definitions)!,
        description: tag.id,
        iconPath: this.extensionUri
          ? tagPickerIcon(this.extensionUri, tag.color)
          : new vscode.ThemeIcon("tag"),
      })),
      { choiceType: "create", label: "$(add) Create New Tag…" },
    ];
    picker.placeholder = "Choose an optional Ghost Comments tag";
    picker.activeItems = [untagged];
    return new Promise((resolve) => {
      picker.onDidAccept(() => {
        const selected = picker.activeItems[0];
        resolve(selected?.choiceType === "tag"
          ? { kind: "tag", tagId: selected.tagId }
          : selected?.choiceType === "create" ? { kind: "create" } : undefined);
        picker.hide();
      });
      picker.onDidHide(() => {
        resolve(undefined);
        picker.dispose();
      });
      picker.show();
    });
  }

  private async createTag(): Promise<string | undefined> {
    const name = await this.promptTagName();
    if (name === undefined) {
      return undefined;
    }
    const label = name.trim();
    if (!label || tagNameExists(label, configuredTags())) {
      void vscode.window.showErrorMessage("Enter a unique tag name.");
      return undefined;
    }
    const color = await this.pickTagColor();
    if (!color) {
      return undefined;
    }
    const configuration = vscode.workspace.getConfiguration("ghostComments");
    const current = configuration.get<unknown>("tags", DEFAULT_TAGS);
    const definitions = parseTagDefinitions(current);
    if (tagNameExists(label, definitions)) {
      void vscode.window.showErrorMessage("A tag with this name already exists.");
      return undefined;
    }
    const tag: TagDefinition = { id: newTagId(label, definitions), label, color };
    try {
      await this.saveTagDefinition(
        [...(Array.isArray(current) ? current : definitions), tag],
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not create tag: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    return tag.id;
  }

  private promptTagName(): Thenable<string | undefined> {
    return vscode.window.showInputBox({
      prompt: "Name the new Ghost Comments tag",
      placeHolder: "Tag name",
      validateInput: (value) => {
        if (!value.trim()) {
          return "Enter a tag name.";
        }
        if (tagNameExists(value, configuredTags())) {
          return "A tag with this name already exists.";
        }
        return undefined;
      },
    });
  }

  private async saveTagDefinition(definitions: unknown[]): Promise<void> {
    await vscode.workspace.getConfiguration("ghostComments").update(
      "tags", definitions, vscode.ConfigurationTarget.Workspace,
    );
  }

  private async pickTagColor(): Promise<TagColor | undefined> {
    const selected = await vscode.window.showQuickPick(
      TAG_COLORS.map((color) => ({
        label: color[0]!.toUpperCase() + color.slice(1),
        iconPath: this.extensionUri
          ? tagPickerIcon(this.extensionUri, color)
          : new vscode.ThemeIcon("tag"),
        color,
      })),
      { placeHolder: "Choose a color for the new tag" },
    );
    return selected?.color;
  }

  private async targetBinding(
    target?: vscode.CommentThread | DiscussionReference,
  ): Promise<Binding | undefined> {
    if (target && "comments" in target) {
      return this.requireBinding(target);
    }
    if (target) {
      return this.bindings.get(`${target.workspaceUri}::${target.noteId}`);
    }
    const selected = await vscode.window.showQuickPick(
      [...this.bindings.values()].map((binding) => ({
        label: binding.note.body.split(/\r?\n/).find((line) => line.trim())?.trim()
          ?? "Untitled note",
        description: `${binding.store.workspaceFolder.name}/${binding.note.filePath}`,
        binding,
      })),
      { placeHolder: "Choose a Ghost Comments discussion" },
    );
    return selected?.binding;
  }

  private async setTag(
    target?: vscode.CommentThread | DiscussionReference,
  ): Promise<void> {
    const binding = await this.targetBinding(target);
    if (!binding) {
      return;
    }
    const tag = await this.pickTag();
    if (tag === undefined) {
      return;
    }
    await this.applyTag(binding, tag);
  }

  private async clearTag(
    target?: vscode.CommentThread | DiscussionReference,
  ): Promise<void> {
    const binding = await this.targetBinding(target);
    if (binding) {
      await this.applyTag(binding, null);
    }
  }

  private async applyTag(binding: Binding, tag: string | null): Promise<void> {
    const note = this.currentNote(binding);
    const nextTag = tag ?? undefined;
    if (note.tag === nextTag) {
      return;
    }
    const withoutTag = { ...note };
    delete withoutTag.tag;
    await binding.store.upsert({
      ...withoutTag,
      ...(nextTag ? { tag: nextTag } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async revealDiscussion(reference: DiscussionReference): Promise<void> {
    const binding = this.bindings.get(
      `${reference.workspaceUri}::${reference.noteId}`,
    );
    if (!binding) {
      return;
    }
    binding.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const document = await vscode.workspace.openTextDocument(binding.thread.uri);
    const editor = await vscode.window.showTextDocument(document);
    if (binding.note.status === "active") {
      const range = editorRange(binding.note.range);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
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
      replies: [
        ...(note.replies ?? []),
        {
          id: randomUUID(),
          body,
          author,
          createdAt: now,
          updatedAt: now,
        },
      ],
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
      throw new Error(
        "This note is no longer active. Reopen it and try again.",
      );
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
    comment.body = new vscode.MarkdownString(comment.savedBody);
    comment.mode = vscode.CommentMode.Editing;
    comment.parent.comments = [...comment.parent.comments];
  }

  private async saveNote(comment: NoteComment): Promise<void> {
    if (this.drafts.has(comment.parent)) {
      await this.submitNote({ thread: comment.parent, text: commentBodyText(comment.body) });
      return;
    }
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
      await binding.store.upsert({
        ...note,
        replies: note.replies.map((reply) =>
          reply.id === comment.replyId ? { ...reply, body, updatedAt } : reply,
        ),
      });
    } else {
      await binding.store.upsert({ ...note, body, updatedAt });
    }
    this.cancelEdit(comment);
  }

  private cancelEdit(comment: NoteComment): void {
    if (this.drafts.has(comment.parent)) {
      this.cancelNote({ thread: comment.parent, text: "" });
      return;
    }
    this.requireBinding(comment.parent);
    comment.restore();
    comment.parent.comments = [...comment.parent.comments];
  }

  private confirmDeleteNote(
    comment: NoteComment,
  ): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(
      comment.replyId
        ? "Delete this shared reply?"
        : "Delete this shared code note and all its replies?",
      { modal: true },
      "Delete",
    );
  }

  private async deleteNote(comment: NoteComment): Promise<void> {
    const binding = this.requireBinding(comment.parent);
    const action = await this.confirmDeleteNote(comment);
    if (action === "Delete") {
      if (comment.replyId) {
        const note = this.currentNote(binding);
        await binding.store.upsert({
          ...note,
          replies: (note.replies ?? []).filter(
            (reply) => reply.id !== comment.replyId,
          ),
        });
      } else {
        await binding.store.delete(binding.noteId);
      }
    }
  }

  private async reattachNote(thread?: vscode.CommentThread): Promise<void> {
    let binding = thread ? this.requireBinding(thread) : undefined;
    if (!binding) {
      const candidates = [...this.bindings.values()].filter(
        (entry) => entry.note.status === "stale",
      );
      const picked = await vscode.window.showQuickPick(
        candidates.map((entry) => ({
          label: entry.note.body.split("\n")[0]!,
          description: `${entry.store.workspaceFolder.name}/${entry.note.filePath}`,
          binding: entry,
        })),
        { placeHolder: "Choose a detached note to reattach" },
      );
      binding = picked?.binding;
    }
    if (!binding) {
      return;
    }
    if (this.currentNote(binding).status !== "stale") {
      throw new Error("This note is already attached.");
    }
    this.pendingAttachment = binding.key;
    this.attachmentStatus.show();
    await vscode.commands.executeCommand(
      "setContext",
      "ghostComments.reattaching",
      true,
    );
    const promptId = ++this.attachmentPromptId;
    void this.run(() => this.promptAttachment(binding.key, promptId));
  }

  private showAttachmentPrompt(): Thenable<string | undefined> {
    return vscode.window.showInformationMessage(
      "Select code or click a line in the note's workspace folder, then click Attach here.",
      "Attach here",
      "Cancel",
    );
  }

  private async promptAttachment(key: string, promptId: number): Promise<void> {
    const action = await this.showAttachmentPrompt();
    if (
      this.pendingAttachment !== key ||
      this.attachmentPromptId !== promptId
    ) {
      return;
    }
    if (action !== "Attach here") {
      this.cancelReattach();
      return;
    }
    try {
      await this.attachHere();
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
      if (
        this.pendingAttachment === key &&
        this.attachmentPromptId === promptId
      ) {
        void this.run(() => this.promptAttachment(key, promptId));
      }
    }
  }

  private cancelReattach(): void {
    this.attachmentPromptId++;
    this.pendingAttachment = undefined;
    this.attachmentStatus.hide();
    void vscode.commands.executeCommand(
      "setContext",
      "ghostComments.reattaching",
      false,
    );
  }

  private async attachHere(): Promise<void> {
    const binding = this.pendingAttachment
      ? this.bindings.get(this.pendingAttachment)
      : undefined;
    if (!binding || this.currentNote(binding).status !== "stale") {
      this.cancelReattach();
      throw new Error("Choose a detached note with Reattach Note first.");
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error(
        "Open a workspace file, then select code or place the cursor on the target line.",
      );
    }
    if (this.requireStore(editor.document.uri) !== binding.store) {
      throw new Error(
        "A detached note can only be reattached inside its current workspace folder.",
      );
    }
    const range = storedRange(this.selection(editor));
    const previous = this.currentNote(binding);
    try {
      await binding.store.upsert({
        ...previous,
        filePath: this.relativePath(binding.store, editor.document.uri),
        range,
        anchor: captureAnchor(editor.document.getText(), range),
        status: "active",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      // The store updates memory before persisting; restore detached state on failure.
      await binding.store.upsert(previous).catch(() => {});
      throw error;
    }
    this.cancelReattach();
    const attached = this.bindings.get(binding.key);
    if (attached) {
      attached.thread.collapsibleState =
        vscode.CommentThreadCollapsibleState.Expanded;
    }
    editor.revealRange(editorRange(range));
    void vscode.window.showInformationMessage("Note attached.");
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
    const tagDefinitions = configuredTags();
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
      const collapsed =
        binding?.thread.collapsibleState ??
        vscode.CommentThreadCollapsibleState.Collapsed;
      // VS Code makes a thread's URI read-only, so only a file move needs a new thread.
      if (binding && binding.thread.uri.toString() !== uri.toString()) {
        this.removeBinding(binding);
        binding = undefined;
      }
      const created = !binding;
      if (!binding) {
        const thread = this.controller.createCommentThread(
          uri,
          editorRange(note.range),
          [],
        );
        thread.canReply = true;
        thread.collapsibleState = collapsed;
        binding = { key, store, noteId: note.id, thread, note };
        this.bindings.set(key, binding);
        this.reverseBindings.set(thread, binding);
      }
      const { thread } = binding;
      const anchorChanged =
        created ||
        binding.note.status !== note.status ||
        !sameRange(binding.note.range, note.range);
      if (anchorChanged) {
        thread.range = stale ? undefined : editorRange(note.range);
        this.tracked.delete(key);
      }
      const tag = displayTag(note.tag, tagDefinitions);
      const contextValue = `${note.status}-${tag.untagged ? "untagged" : tag.color}`;
      if (thread.contextValue !== contextValue) {
        thread.contextValue = contextValue;
      }
      // VS Code only redraws an existing heading for a nonempty label.
      // Clearing it with undefined leaves the old reattachment warning visible.
      const heading = stale ? "⚠️ Needs reattachment" : "Discussion";
      const label = tag.untagged ? heading : `${heading} · ${tag.label}`;
      if (thread.label !== label) {
        thread.label = label;
      }
      const existing = new Map(
        (thread.comments as readonly NoteComment[]).map((comment) => [
          comment.replyId ?? note.id,
          comment,
        ]),
      );
      let changed = false;
      const comments = [note, ...(note.replies ?? [])].map((message, index) => {
        const comment = existing.get(message.id);
        if (comment) {
          changed =
            comment.update(
              message.body,
              message.author,
              message.updatedAt,
              stale,
            ) || changed;
          return comment;
        }
        changed = true;
        return new NoteComment(
          note.id,
          message.body,
          message.author,
          thread,
          message.updatedAt,
          stale,
          index === 0 ? undefined : message.id,
        );
      });
      if (
        changed ||
        comments.length !== thread.comments.length ||
        comments.some((comment, index) => comment !== thread.comments[index])
      ) {
        thread.comments = comments;
      }
      binding.note = note;
      const document = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === uri.toString(),
      );
      if (document && !stale && !this.tracked.has(key)) {
        this.trackNote(store, note, document);
      }
      if (stale) {
        this.tracked.delete(key);
      } else {
        this.notifiedDetached.delete(key);
      }
    }
  }

  private trackNote(
    store: NoteStore,
    note: StoredNote,
    document: vscode.TextDocument,
  ): void {
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
    for (const note of store.all.filter(
      (note) => note.filePath === filePath && note.status === "active",
    )) {
      const key = bindingKey(store, note.id);
      const previous = this.tracked.get(key);
      if (!previous || this.pendingDeletions.has(key)) {
        continue;
      }
      const result = trackEdits(previous, event.contentChanges);
      if (result.deleted) {
        this.pendingDeletions.add(key);
        deleted.push({
          ...note,
          range: previous.range,
          anchor: previous.anchor,
        });
        this.tracked.delete(key);
      } else {
        const range = storedRange(
          new vscode.Range(
            event.document.positionAt(result.start),
            event.document.positionAt(result.end),
          ),
        );
        this.tracked.set(key, {
          ...previous,
          ...result,
          range,
          anchor: captureAnchor(event.document.getText(), range),
        });
      }
    }
    if (deleted.length) {
      this.run(() => this.confirmDeletedCode(store, deleted));
    }
  }

  private warnAboutDeletedCode(count: number): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(
      count === 1
        ? "This comment is detached. Choose a new code location."
        : `${count} comments are detached. Choose new code locations. All comments and replies have been preserved.`,
      "Reattach…",
      "Later",
    );
  }

  private async promptDetached(
    store: NoteStore,
    notes: readonly StoredNote[],
  ): Promise<void> {
    const fresh = notes.filter(
      (note) => !this.notifiedDetached.has(bindingKey(store, note.id)),
    );
    if (!fresh.length) {
      return;
    }
    for (const note of fresh) {
      this.notifiedDetached.add(bindingKey(store, note.id));
    }
    const action = await this.warnAboutDeletedCode(fresh.length);
    if (action === "Reattach…") {
      const candidates = fresh
        .map((note) => this.bindings.get(bindingKey(store, note.id)))
        .filter(
          (binding): binding is Binding => binding?.note.status === "stale",
        );
      if (candidates.length === 1) {
        await this.reattachNote(candidates[0]!.thread);
      } else if (candidates.length) {
        await this.reattachNote();
      }
    }
  }

  private async confirmDeletedCode(
    store: NoteStore,
    deleted: StoredNote[],
  ): Promise<void> {
    try {
      const updates = deleted.flatMap((note): StoredNote[] => {
        const current = store.all.find((entry) => entry.id === note.id);
        return current
          ? [{
            ...current,
            range: note.range,
            anchor: note.anchor,
            status: "stale",
          }]
          : [];
      });
      await store.upsertMany(updates);
    } finally {
      for (const note of deleted) {
        this.pendingDeletions.delete(bindingKey(store, note.id));
      }
    }
    await this.promptDetached(store, deleted);
  }

  private async validateAnchors(document: vscode.TextDocument): Promise<void> {
    const store = this.managedStore(document.uri);
    if (!store) {
      return;
    }
    const filePath = this.relativePath(store, document.uri);
    const updates: StoredNote[] = [];
    for (const note of store.all.filter((note) => note.filePath === filePath)) {
      if (
        note.status === "stale" ||
        this.pendingDeletions.has(bindingKey(store, note.id))
      ) {
        continue;
      }
      const result = reanchor(document.getText(), note.range, note.anchor);
      const range = result.range ?? note.range;
      if (result.status === "active") {
        this.trackNote(store, { ...note, range }, document);
      }
      if (result.status !== note.status || !sameRange(range, note.range)) {
        updates.push({
          ...note,
          range,
          status: result.status,
        });
      }
    }
    await store.upsertMany(updates);
    void this.run(() =>
      this.promptDetached(
        store,
        store.all.filter(
          (note) => note.filePath === filePath && note.status === "stale",
        ),
      ),
    );
  }

  private async refreshAnchors(document: vscode.TextDocument): Promise<void> {
    const store = this.managedStore(document.uri);
    if (!store) {
      return;
    }
    const filePath = this.relativePath(store, document.uri);
    // Capture the current ranges before persisting updates.
    const updates = store.all
      .filter((note) => note.filePath === filePath && note.status === "active")
      .flatMap((note): StoredNote[] => {
        const key = bindingKey(store, note.id);
        if (this.pendingDeletions.has(key)) {
          return [];
        }
        const tracked = this.tracked.get(key);
        const liveRange = tracked
          ? editorRange(tracked.range)
          : this.bindings.get(key)?.thread.range;
        if (!liveRange) {
          return [];
        }
        const range = storedRange(liveRange);
        const anchor = captureAnchor(document.getText(), range);
        return sameRange(range, note.range) && sameAnchor(anchor, note.anchor)
          ? []
          : [{ ...note, range, anchor }];
      });
    await store.upsertMany(updates);
  }

  private async renameFiles(event: vscode.FileRenameEvent): Promise<void> {
    for (const file of event.files) {
      const store = this.managedStore(file.oldUri);
      if (store && store === this.managedStore(file.newUri)) {
        await store.updateFilePath(
          this.relativePath(store, file.oldUri),
          this.relativePath(store, file.newUri),
        );
      }
    }
  }

  dispose(): void {
    this.cancelReattach();
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
