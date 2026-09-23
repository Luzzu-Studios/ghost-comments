import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TAGS,
  displayTag,
  nativeTagLabel,
  newTagId,
  parseTagDefinitions,
  tagNameExists,
} from "../tags/tagDefinitions";

test("uses defaults only when the tag setting is not an array", () => {
  assert.deepEqual(parseTagDefinitions(undefined), DEFAULT_TAGS);
  assert.deepEqual(parseTagDefinitions({}), DEFAULT_TAGS);
  assert.deepEqual(parseTagDefinitions([]), []);
});

test("creates stable unique IDs and rejects duplicate names", () => {
  const definitions = [
    { id: "review", label: "Review", color: "purple" },
    { id: "review-2", label: "Another", color: "red" },
    { id: "tag", label: "Misc", color: "gray" },
  ] as const;
  assert.equal(tagNameExists(" review ", definitions), true);
  assert.equal(tagNameExists("REVIEW", definitions), true);
  assert.equal(tagNameExists("Fresh", definitions), false);
  assert.equal(newTagId("Review", definitions), "review-3");
  assert.equal(newTagId("Café & Notes", definitions), "cafe-notes");
  assert.equal(newTagId("✨", definitions), "tag-2");
});

test("validates tag definitions and keeps the first duplicate in order", () => {
  assert.deepEqual(
    parseTagDefinitions([
      { id: "review", label: " Review ", color: "purple" },
      { id: "review", label: "Duplicate", color: "red" },
      { id: "Bad ID", label: "Bad", color: "blue" },
      { id: "wrong-color", label: "Bad", color: "pink" },
      { id: "empty", label: " ", color: "gray" },
      null,
    ]),
    [{ id: "review", label: "Review", color: "purple" }],
  );
});

test("resolves configured, unknown, and untagged display values", () => {
  const definitions = [{ id: "review", label: "Review", color: "purple" }] as const;
  assert.deepEqual(displayTag("review", definitions), definitions[0]);
  assert.deepEqual(displayTag("removed", definitions), {
    id: "removed",
    label: "Unknown: removed",
    color: "gray",
    unknown: true,
  });
  assert.deepEqual(displayTag(undefined, definitions), {
    id: "",
    label: "Untagged",
    color: "gray",
    untagged: true,
  });
  assert.equal(nativeTagLabel("review", definitions), "Review");
  assert.equal(nativeTagLabel(undefined, definitions), undefined);
});
