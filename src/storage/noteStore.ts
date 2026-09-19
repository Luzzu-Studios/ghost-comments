import * as vscode from "vscode";
import { parseNoteFile, serializeNoteFile } from "../model/note";
import type { StoredNote } from "../model/note";

const STORAGE_DIRECTORY = ".gc";
const STORAGE_FILE = "notes.json";

export class NoteStore implements vscode.Disposable {
  private notes = new Map<string, StoredNote>();
  private readonly emitter = new vscode.EventEmitter<readonly StoredNote[]>();
  private readonly watcher: vscode.FileSystemWatcher;
  private writeQueue: Promise<void> = Promise.resolve();
  private ownWriteText: string | undefined;
  readonly onDidChange = this.emitter.event;

  constructor(readonly workspaceFolder: vscode.WorkspaceFolder) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, `${STORAGE_DIRECTORY}/${STORAGE_FILE}`),
    );
    this.watcher.onDidCreate(() => { void this.reload(); });
    this.watcher.onDidChange(() => { void this.reload(); });
    this.watcher.onDidDelete(() => { this.replace([]); });
  }

  get storageUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.workspaceFolder.uri, STORAGE_DIRECTORY, STORAGE_FILE);
  }

  get all(): readonly StoredNote[] {
    return [...this.notes.values()];
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.storageUri));
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        this.replace([]);
        return;
      }
      throw error;
    }
    this.replace(parseNoteFile(text).notes);
  }

  async upsert(note: StoredNote): Promise<void> {
    this.notes.set(note.id, note);
    this.emitter.fire(this.all);
    await this.persist();
  }

  async delete(noteId: string): Promise<void> {
    if (!this.notes.delete(noteId)) {
      return;
    }
    this.emitter.fire(this.all);
    await this.persist();
  }

  async updateFilePath(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    const updatedAt = new Date().toISOString();
    for (const [id, note] of this.notes) {
      if (note.filePath === oldPath) {
        this.notes.set(id, { ...note, filePath: newPath, updatedAt });
        changed = true;
      }
    }
    if (changed) {
      this.emitter.fire(this.all);
      await this.persist();
    }
  }

  private replace(notes: readonly StoredNote[]): void {
    this.notes = new Map(notes.map((note) => [note.id, note]));
    this.emitter.fire(this.all);
  }

  private persist(): Promise<void> {
    const text = serializeNoteFile(this.all);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      this.ownWriteText = text;
      const directory = vscode.Uri.joinPath(this.workspaceFolder.uri, STORAGE_DIRECTORY);
      await vscode.workspace.fs.createDirectory(directory);
      const temporary = vscode.Uri.joinPath(directory, `${STORAGE_FILE}.tmp`);
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(text));
      await vscode.workspace.fs.rename(temporary, this.storageUri, { overwrite: true });
    });
    return this.writeQueue;
  }

  private async reload(): Promise<void> {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.storageUri));
      if (text === this.ownWriteText) {
        this.ownWriteText = undefined;
        return;
      }
      this.replace(parseNoteFile(text).notes);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        this.replace([]);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Ghost Comments could not reload ${this.workspaceFolder.name}/.gc/notes.json: ${message}`,
      );
    }
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
