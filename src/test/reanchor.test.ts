import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAnchor, reanchor, textForRange } from "../anchors/reanchor";
import type { TextRange } from "../model/note";

function range(line: number, length: number): TextRange {
  return { start: { line, character: 0 }, end: { line, character: length } };
}

test("unchanged anchors retain their range", () => {
  const text = "first\nconst value = 1;\nlast";
  const original = range(1, 16);
  assert.deepEqual(reanchor(text, original, captureAnchor(text, original)), { status: "active", range: original });
});

test("anchors follow inserted lines", () => {
  const text = "first\nconst value = 1;\nlast";
  const original = range(1, 16);
  assert.deepEqual(reanchor(`inserted\n${text}`, original, captureAnchor(text, original)), { status: "active", range: range(2, 16) });
});

test("context distinguishes duplicate text", () => {
  const text = "target context\nreturn value;\nnext context";
  const original = range(1, 13);
  const changed = `other\nreturn value;\nother\n${text}`;
  assert.deepEqual(reanchor(changed, original, captureAnchor(text, original)), { status: "active", range: range(4, 13) });
});

test("indistinguishable context-free duplicates become stale", () => {
  assert.deepEqual(reanchor("return value;\nreturn value;", range(5, 13), { text: "return value;", before: [], after: [] }), { status: "stale" });
});

test("deleted anchor becomes stale", () => {
  const text = "before\nremove me\nafter";
  const original = range(1, 9);
  assert.deepEqual(reanchor("before\nafter", original, captureAnchor(text, original)), { status: "stale" });
});

test("empty lines follow insertion and use context to disambiguate", () => {
  const text = "before\n\nafter";
  const original = range(1, 0);
  assert.deepEqual(reanchor(`inserted\n${text}\nother\n\nlast`, original, captureAnchor(text, original)), { status: "active", range: range(2, 0) });
});

test("normalizes CRLF and CR and preserves multiline text and whitespace", () => {
  const original = { start: { line: 1, character: 2 }, end: { line: 3, character: 2 } };
  const text = " before \r\n  abc\rmiddle\r\nend\nafter ";
  const anchor = captureAnchor(text, original);
  assert.deepEqual(anchor, { text: "abc\nmiddle\nen", before: [" before "], after: ["after "] });
  assert.deepEqual(reanchor(`new\n${text}`, original, anchor), {
    status: "active", range: { start: { line: 2, character: 2 }, end: { line: 4, character: 2 } },
  });
});

test("rejects invalid ranges and captures at most two context lines", () => {
  const lines = ["a", "bc"];
  for (const invalid of [range(2, 0), range(0, 2), { start: { line: 1, character: 1 }, end: { line: 0, character: 0 } }]) {
    assert.equal(textForRange(lines, invalid), undefined);
    assert.throws(() => captureAnchor(lines.join("\n"), invalid), /Cannot capture an anchor outside the document/);
  }
  assert.deepEqual(captureAnchor("0\n1\n2\n3\n4\n5\n6", range(3, 1)), { text: "3", before: ["1", "2"], after: ["4", "5"] });
});

test("keeps a context-free exact stored range and accepts a unique changed-context match", () => {
  assert.deepEqual(reanchor("x\nx", range(0, 1), { text: "x", before: [], after: [] }), { status: "active", range: range(0, 1) });
  assert.deepEqual(reanchor("changed\nx\nchanged", range(0, 1), { text: "x", before: ["before"], after: ["after"] }), { status: "active", range: range(1, 1) });
});

test("retains overlapping candidates and rejects tied positive context scores", () => {
  assert.deepEqual(reanchor("aaa", range(4, 2), { text: "aa", before: [], after: [] }), { status: "stale" });
  assert.deepEqual(reanchor("before\nx\nafter\nbefore\nx\nafter", range(7, 1), { text: "x", before: ["before"], after: ["after"] }), { status: "stale" });
});

test("empty anchors only match actual empty lines", () => {
  assert.deepEqual(reanchor("abc", range(0, 0), { text: "", before: [], after: [] }), { status: "stale" });
});
