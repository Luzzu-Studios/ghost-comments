export const NOTE_SCHEMA_VERSION = 1;

export interface TextPosition {
  line: number;
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface NoteAnchor {
  text: string;
  before: string[];
  after: string[];
}

export interface StoredReply {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredNote {
  replies?: StoredReply[];
  tag?: string;
  id: string;
  filePath: string;
  range: TextRange;
  anchor: NoteAnchor;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "stale";
}

export interface NoteFile {
  schemaVersion: typeof NOTE_SCHEMA_VERSION;
  notes: StoredNote[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Note ${index} has an invalid ${field}.`);
  }
  return value;
}

function position(value: unknown, index: number): TextPosition {
  if (!isObject(value)
    || typeof value.line !== "number" || !Number.isInteger(value.line) || value.line < 0
    || typeof value.character !== "number" || !Number.isInteger(value.character) || value.character < 0) {
    throw new Error(`Note ${index} has an invalid range position.`);
  }
  return { line: value.line, character: value.character };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parseNoteFile(text: string): NoteFile {
  const root: unknown = JSON.parse(text);
  if (!isObject(root) || root.schemaVersion !== NOTE_SCHEMA_VERSION || !Array.isArray(root.notes)) {
    throw new Error("Expected Ghost Comments note schema version 1.");
  }
  const ids = new Set<string>();
  const notes = root.notes.map((value: unknown, index): StoredNote => {
    if (!isObject(value)) {
      throw new Error(`Note ${index} must be an object.`);
    }
    const id = requiredString(value.id, index, "id");
    if (ids.has(id)) {
      throw new Error("Ghost Comments note IDs must be unique.");
    }
    ids.add(id);
    const filePath = requiredString(value.filePath, index, "filePath");
    if (filePath.includes("\\") || filePath.startsWith("/") || filePath.split("/").includes("..")) {
      throw new Error(`Note ${index} filePath must be relative to its workspace folder.`);
    }
    const body = requiredString(value.body, index, "body");
    let tag: string | undefined;
    if (value.tag !== undefined) {
      tag = requiredString(value.tag, index, "tag");
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(tag)) {
        throw new Error(`Note ${index} has an invalid tag.`);
      }
    }
    const author = requiredString(value.author, index, "author");
    const createdAt = requiredString(value.createdAt, index, "createdAt");
    const updatedAt = requiredString(value.updatedAt, index, "updatedAt");
    for (const [field, date] of [["createdAt", createdAt], ["updatedAt", updatedAt]] as const) {
      if (Number.isNaN(Date.parse(date))) {
        throw new Error(`Note ${index} has an invalid ${field}.`);
      }
    }
    if (value.status !== "active" && value.status !== "stale") {
      throw new Error(`Note ${index} has an invalid status.`);
    }
    if (!isObject(value.range)) {
      throw new Error(`Note ${index} has an invalid range.`);
    }
    const start = position(value.range.start, index);
    const end = position(value.range.end, index);
    if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
      throw new Error(`Note ${index} range must be normalized.`);
    }
    const anchor = value.anchor;
    if (!isObject(anchor) || typeof anchor.text !== "string"
      || !stringArray(anchor.before) || !stringArray(anchor.after)) {
      throw new Error(`Note ${index} has an invalid anchor.`);
    }
    let replies: StoredReply[] | undefined;
    if (value.replies !== undefined) {
      if (!Array.isArray(value.replies)) {
        throw new Error(`Note ${index} has invalid replies.`);
      }
      const replyIds = new Set<string>([id]);
      replies = value.replies.map((reply: unknown): StoredReply => {
        if (!isObject(reply)) {
          throw new Error(`Note ${index} has an invalid reply.`);
        }
        const result: StoredReply = {
          id: requiredString(reply.id, index, "reply id"),
          body: requiredString(reply.body, index, "reply body"),
          author: requiredString(reply.author, index, "reply author"),
          createdAt: requiredString(reply.createdAt, index, "reply createdAt"),
          updatedAt: requiredString(reply.updatedAt, index, "reply updatedAt"),
        };
        if (replyIds.has(result.id)) {
          throw new Error(`Note ${index} reply IDs must be unique.`);
        }
        replyIds.add(result.id);
        if (Number.isNaN(Date.parse(result.createdAt)) || Number.isNaN(Date.parse(result.updatedAt))) {
          throw new Error(`Note ${index} has an invalid reply timestamp.`);
        }
        return result;
      });
    }
    return {
      ...(replies === undefined ? {} : { replies }),
      ...(tag === undefined ? {} : { tag }),
      id, filePath, range: { start, end },
      anchor: { text: anchor.text, before: anchor.before, after: anchor.after },
      body, author, createdAt, updatedAt, status: value.status,
    };
  });
  return { schemaVersion: NOTE_SCHEMA_VERSION, notes };
}

export function serializeNoteFile(notes: readonly StoredNote[]): string {
  const sorted = [...notes].sort((a, b) => a.filePath.localeCompare(b.filePath)
    || a.range.start.line - b.range.start.line
    || a.range.start.character - b.range.start.character
    || a.id.localeCompare(b.id));
  return `${JSON.stringify({ schemaVersion: NOTE_SCHEMA_VERSION, notes: sorted }, null, 2)}\n`;
}
