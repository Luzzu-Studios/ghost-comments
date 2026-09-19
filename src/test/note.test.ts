import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNoteFile, serializeNoteFile } from "../model/note";
import type { StoredNote } from "../model/note";

const timestamp = "2026-09-17T10:00:00.000Z";

function note(id: string, filePath = "src/a.ts", line = 2): StoredNote {
  return {
    id, filePath,
    range: { start: { line, character: 0 }, end: { line, character: 6 } },
    anchor: { text: "export", before: [], after: [] },
    body: "Keep this export stable.", author: "Test Author",
    createdAt: timestamp, updatedAt: timestamp, status: "active",
  };
}

function fileWith(value: unknown): string {
  return JSON.stringify({ schemaVersion: 1, notes: [value] });
}

test("serializes deterministic notes, round-trips, and ends with one newline", () => {
  const z = note("z", "src/z.ts", 8);
  const a = note("a");
  const input = [z, a];
  const text = serializeNoteFile(input);
  assert.deepEqual(parseNoteFile(text), { schemaVersion: 1, notes: [a, z] });
  assert.ok(text.endsWith("\n"));
  assert.ok(!text.endsWith("\n\n"));
  assert.deepEqual(input, [z, a]);
});

test("rejects unsupported schema versions", () => {
  assert.throws(() => parseNoteFile('{"schemaVersion":2,"notes":[]}'), /schema version 1/);
});

test("rejects paths outside the workspace", () => {
  for (const filePath of ["../secret.ts", "src/../secret.ts", "/secret.ts", "src\\secret.ts"]) {
    assert.throws(() => parseNoteFile(fileWith(note("id", filePath))), /must be relative/);
  }
});

test("rejects duplicate IDs", () => {
  assert.throws(() => parseNoteFile(serializeNoteFile([note("same"), note("same")])) , /IDs must be unique/);
});

test("validates objects, required strings, dates, ranges, anchors, and status", () => {
  for (const root of [null, [], {}, { schemaVersion: 1, notes: null }]) {
    assert.throws(() => parseNoteFile(JSON.stringify(root)), /schema version 1/);
  }
  assert.throws(() => parseNoteFile(fileWith(null)), /Note 0 must be an object/);
  for (const field of ["id", "filePath", "body", "author", "createdAt", "updatedAt"]) {
    assert.throws(() => parseNoteFile(fileWith({ ...note("id"), [field]: " " })), new RegExp(`invalid ${field}`));
  }
  assert.throws(() => parseNoteFile(fileWith({ ...note("id"), createdAt: "invalid" })), /invalid createdAt/);
  assert.throws(() => parseNoteFile(fileWith({ ...note("id"), status: "resolved" })), /Note 0 has an invalid status/);
  assert.throws(() => parseNoteFile(fileWith({ ...note("id"), anchor: { text: "", before: [1], after: [] } })), /invalid anchor/);
  for (const line of [-1, 0.5]) {
    assert.throws(() => parseNoteFile(fileWith({ ...note("id"), range: { start: { line, character: 0 }, end: { line: 2, character: 0 } } })), /invalid range position/);
  }
  assert.throws(() => parseNoteFile(fileWith({ ...note("id"), range: { start: { line: 2, character: 7 }, end: { line: 2, character: 0 } } })), /range must be normalized/);
  const untrimmed = { ...note("id"), body: "  keep whitespace  ", anchor: { text: "", before: [], after: [] } };
  assert.deepEqual(parseNoteFile(fileWith(untrimmed)).notes, [untrimmed]);
});

test("orders ties by start character and ID", () => {
  const a = note("a");
  const b = note("b");
  const c = { ...note("c"), range: { start: { line: 2, character: 1 }, end: { line: 2, character: 6 } } };
  assert.deepEqual(parseNoteFile(serializeNoteFile([c, b, a])).notes, [a, b, c]);
});
