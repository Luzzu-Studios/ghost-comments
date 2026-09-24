import * as vscode from "vscode";
import { parseNoteFile, serializeNoteFile } from "../model/note";
import type { StoredNote } from "../model/note";

const STORAGE_DIRECTORY = ".gc";
const STORAGE_FILE = "comments.json";
const LEGACY_STORAGE_FILE = "notes.json";
const BACKUP_FILE = "comments-backup.json";
const STORAGE_FILE = "comments.json";
const LEGACY_STORAGE_FILE = "notes.json";
const BACKUP_FILE = "comments-backup.json";
const DEFAULT_BACKUP_INTERVAL = 10;

export interface BackupState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

class PrimaryWriteError extends Error {
  constructor(readonly originalError: unknown) {
    super(
      originalError instanceof Error
        ? originalError.message
        : String(originalError),
    );
    this.name = "PrimaryWriteError";
  }
}

export class NoteStore implements vscode.Disposable {
  private notes = new Map<string, StoredNote>();
  private readonly emitter = new vscode.EventEmitter<readonly StoredNote[]>();
  private readonly watcher: vscode.FileSystemWatcher;
  private writeQueue: Promise<void> = Promise.resolve();
  private revision = 0;
  private ownWriteText: string | undefined;
  private volatileBackupCount = 0;
  readonly onDidChange = this.emitter.event;

  constructor(
    readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly backupState?: BackupState,
    private readonly backupIntervalProvider: () => number = () =>
      vscode.workspace
        .getConfiguration("ghostThreads")
        .get<number>("backupInterval", DEFAULT_BACKUP_INTERVAL),
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        workspaceFolder,
        `${STORAGE_DIRECTORY}/${STORAGE_FILE}`,
      ),
    );
    this.watcher.onDidCreate(() => {
      void this.reload();
    });
    this.watcher.onDidChange(() => {
      void this.reload();
    });
    this.watcher.onDidDelete(() => {
      void this.reload();
    });
  }

  get storageUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      STORAGE_DIRECTORY,
      STORAGE_FILE,
    );
  }

  private get legacyStorageUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      STORAGE_DIRECTORY,
      LEGACY_STORAGE_FILE,
    );
  }

  private get legacyBackupUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      STORAGE_DIRECTORY,
      "notes-backup.json",
    );
  }

  private get legacyStorageUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      STORAGE_DIRECTORY,
      LEGACY_STORAGE_FILE,
    );
  }

  private get legacyBackupUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      STORAGE_DIRECTORY,
      "notes-backup.json",
    );
  }

  get backupUri(): vscode.Uri {
    return vscode.Uri.joinPath(
      this.workspaceFolder.uri,
      STORAGE_DIRECTORY,
      BACKUP_FILE,
    );
  }

  get all(): readonly StoredNote[] {
    return [...this.notes.values()];
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(this.storageUri),
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        await this.loadLegacyStorage();
        await this.loadLegacyStorage();
        return;
      }
      throw error;
    }
    this.replace(parseNoteFile(text).notes);
  }

  private async loadLegacyStorage(): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(this.legacyStorageUri),
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        this.replace([]);
        return;
      }
      throw error;
    }

    const notes = parseNoteFile(text).notes;
    await vscode.workspace.fs.rename(this.legacyStorageUri, this.storageUri, {
      overwrite: false,
    });
    if (
      !(await this.fileExists(this.backupUri)) &&
      (await this.fileExists(this.legacyBackupUri))
    ) {
      await vscode.workspace.fs.rename(this.legacyBackupUri, this.backupUri, {
        overwrite: false,
      });
    }
    this.replace(notes);
  }

  private async loadLegacyStorage(): Promise<void> {
    let text: string;
    try {
      text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(this.legacyStorageUri),
      );
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        this.replace([]);
        return;
      }
      throw error;
    }

    const notes = parseNoteFile(text).notes;
    await vscode.workspace.fs.rename(this.legacyStorageUri, this.storageUri, {
      overwrite: false,
    });
    if (
      !(await this.fileExists(this.backupUri)) &&
      (await this.fileExists(this.legacyBackupUri))
    ) {
      await vscode.workspace.fs.rename(this.legacyBackupUri, this.backupUri, {
        overwrite: false,
      });
    }
    this.replace(notes);
  }

  async upsert(note: StoredNote): Promise<void> {
    await this.upsertMany([note]);
  }

  async upsertMany(notes: readonly StoredNote[]): Promise<void> {
    if (!notes.length) {
      return;
    }
    const previous = this.notes;
    this.notes = new Map(this.notes);
    this.revision++;
    const mutationRevision = this.revision;
    for (const note of notes) {
      this.notes.set(note.id, note);
    }
    this.emitter.fire(this.all);
    try {
      await this.persist();
    } catch (error) {
      this.rollbackPrimaryFailure(error, mutationRevision, previous);
      throw error;
    }
  }

  async delete(noteId: string): Promise<void> {
    const previous = this.notes;
    this.notes = new Map(this.notes);
    if (!this.notes.delete(noteId)) {
      this.notes = previous;
      return;
    }
    this.revision++;
    const mutationRevision = this.revision;
    this.emitter.fire(this.all);
    try {
      await this.persist();
    } catch (error) {
      this.rollbackPrimaryFailure(error, mutationRevision, previous);
      throw error;
    }
  }

  async updateFilePath(oldPath: string, newPath: string): Promise<void> {
    const previous = this.notes;
    this.notes = new Map(this.notes);
    let changed = false;
    for (const [id, note] of this.notes) {
      if (note.filePath === oldPath) {
        this.notes.set(id, { ...note, filePath: newPath });
        changed = true;
      }
    }
    if (changed) {
      this.revision++;
      const mutationRevision = this.revision;
      this.emitter.fire(this.all);
      try {
        await this.persist();
      } catch (error) {
        this.rollbackPrimaryFailure(error, mutationRevision, previous);
        throw error;
      }
    } else {
      this.notes = previous;
    }
  }

  private rollbackPrimaryFailure(
    error: unknown,
    mutationRevision: number,
    previous: Map<string, StoredNote>,
  ): void {
    if (
      !(error instanceof PrimaryWriteError) ||
      this.revision !== mutationRevision
    ) {
      return;
    }
    this.revision++;
    this.notes = previous;
    this.emitter.fire(this.all);
  }

  private replace(notes: readonly StoredNote[]): void {
    this.revision++;
    this.ownWriteText = undefined;
    this.notes = new Map(notes.map((note) => [note.id, note]));
    this.emitter.fire(this.all);
  }

  private persist(): Promise<void> {
    const text = serializeNoteFile(this.all);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        this.ownWriteText = text;
        const directory = vscode.Uri.joinPath(
          this.workspaceFolder.uri,
          STORAGE_DIRECTORY,
        );
        await vscode.workspace.fs.createDirectory(directory);
        try {
          await this.writeAtomically(directory, STORAGE_FILE, text);
        } catch (error) {
          throw new PrimaryWriteError(error);
        }
        await this.updateBackup(directory, text);
      });
    return this.writeQueue;
  }

  private async updateBackup(
    directory: vscode.Uri,
    text: string,
  ): Promise<void> {
    const interval = this.backupInterval();
    if (interval === 0) {
      return;
    }

    if (!(await this.fileExists(this.backupUri))) {
      await this.writeAtomically(directory, BACKUP_FILE, text);
      await this.setBackupCount(0);
      return;
    }

    const count = this.backupCount() + 1;
    await this.setBackupCount(count);
    if (count >= interval) {
      await this.writeAtomically(directory, BACKUP_FILE, text);
      await this.setBackupCount(0);
    }
  }

  private backupInterval(): number {
    const configured = this.backupIntervalProvider();
    return Number.isInteger(configured) && configured >= 0
      ? configured
      : DEFAULT_BACKUP_INTERVAL;
  }

  private get backupStateKey(): string {
    return `ghostThreads.backupChangeCount:${this.workspaceFolder.uri.toString()}`;
  }

  private backupCount(): number {
    const count =
      this.backupState?.get<number>(this.backupStateKey, 0) ??
      this.volatileBackupCount;
    return Number.isInteger(count) && count >= 0 ? count : 0;
  }

  private async setBackupCount(count: number): Promise<void> {
    if (this.backupState) {
      await this.backupState.update(this.backupStateKey, count);
    } else {
      this.volatileBackupCount = count;
    }
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch (error) {
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        return false;
      }
      throw error;
    }
  }

  private async writeAtomically(
    directory: vscode.Uri,
    fileName: string,
    text: string,
  ): Promise<void> {
    const destination = vscode.Uri.joinPath(directory, fileName);
    const temporary = vscode.Uri.joinPath(directory, `${fileName}.tmp`);
    let previous: Uint8Array | undefined;
    try {
      previous = await vscode.workspace.fs.readFile(destination);
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
    await vscode.workspace.fs.writeFile(
      temporary,
      new TextEncoder().encode(text),
    );
    try {
      await vscode.workspace.fs.rename(temporary, destination, {
        overwrite: true,
      });
    } catch (error) {
      if (previous && !(await this.fileExists(destination))) {
        try {
          await vscode.workspace.fs.writeFile(destination, previous);
        } catch (restoreError) {
          const originalMessage =
            error instanceof Error ? error.message : String(error);
          const restoreMessage =
            restoreError instanceof Error
              ? restoreError.message
              : String(restoreError);
          throw new Error(
            `${originalMessage} The previous ${fileName} could not be restored: ${restoreMessage}`,
          );
        }
      }
      throw error;
    }
  }

  private async reload(): Promise<void> {
    // Atomic replacement can emit a delete before the replacement file appears.
    // Wait for our writes and ignore reads overtaken by a newer local mutation.
    await this.writeQueue.catch(() => {});
    const revision = this.revision;
    try {
      const text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(this.storageUri),
      );
      if (revision !== this.revision || text === this.ownWriteText) {
        return;
      }
      this.replace(parseNoteFile(text).notes);
    } catch (error) {
      if (revision !== this.revision) {
        return;
      }
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileNotFound"
      ) {
        this.replace([]);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `Ghost Threads could not reload ${this.workspaceFolder.name}/.gc/comments.json: ${message}`,
      );
    }
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
