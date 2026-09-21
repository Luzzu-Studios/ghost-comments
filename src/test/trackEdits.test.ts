import assert from "node:assert/strict";
import { test } from "node:test";
import { trackEdits } from "../anchors/trackEdits";

const range = { start: 10, end: 20 };

test("detects deletion of exactly the commented code and enclosing code", () => {
  assert.deepEqual(trackEdits(range, [{ rangeOffset: 10, rangeLength: 10, text: "" }]), { start: 10, end: 10, deleted: true });
  assert.deepEqual(trackEdits(range, [{ rangeOffset: 5, rangeLength: 25, text: "" }]), { start: 5, end: 5, deleted: true });
});

test("tracks inserted and partially edited code without deleting comments", () => {
  assert.deepEqual(trackEdits(range, [{ rangeOffset: 0, rangeLength: 0, text: "new\n" }]), { start: 14, end: 24, deleted: false });
  assert.deepEqual(trackEdits(range, [{ rangeOffset: 12, rangeLength: 4, text: "" }]), { start: 10, end: 16, deleted: false });
  assert.deepEqual(trackEdits(range, [{ rangeOffset: 10, rangeLength: 10, text: "replacement" }]), { start: 10, end: 21, deleted: false });
  assert.deepEqual(trackEdits(range, [{ rangeOffset: 20, rangeLength: 1, text: "" }]), { ...range, deleted: false });
});

test("handles multiple simultaneous edits in original document coordinates", () => {
  assert.deepEqual(trackEdits(range, [
    { rangeOffset: 0, rangeLength: 0, text: "abc" },
    { rangeOffset: 10, rangeLength: 10, text: "" },
  ]), { start: 13, end: 13, deleted: true });
});

test("detects deletion after earlier unsaved edits", () => {
  const shifted = trackEdits(range, [{ rangeOffset: 0, rangeLength: 0, text: "abc" }]);
  assert.equal(trackEdits(shifted, [{ rangeOffset: 13, rangeLength: 10, text: "" }]).deleted, true);
});

test("does not treat empty anchors or no-op events as code deletions", () => {
  assert.equal(trackEdits({ start: 10, end: 10 }, [{ rangeOffset: 9, rangeLength: 2, text: "" }]).deleted, false);
  assert.deepEqual(trackEdits(range, []), { ...range, deleted: false });
});
