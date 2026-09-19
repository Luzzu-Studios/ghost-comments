import type { NoteAnchor, TextPosition, TextRange } from "../model/note";

const CONTEXT_LINES = 2;

export interface ReanchorResult {
  status: "active" | "stale";
  range?: TextRange;
}

function linesOf(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function textForRange(lines: readonly string[], range: TextRange): string | undefined {
  const { start, end } = range;
  const first = lines[start.line];
  const last = lines[end.line];
  if (first === undefined || last === undefined
    || !Number.isInteger(start.line) || !Number.isInteger(end.line)
    || !Number.isInteger(start.character) || !Number.isInteger(end.character)
    || start.character < 0 || end.character < 0
    || start.character > first.length || end.character > last.length
    || start.line > end.line || (start.line === end.line && start.character > end.character)) {
    return undefined;
  }
  if (start.line === end.line) {
    return first.slice(start.character, end.character);
  }
  return [first.slice(start.character), ...lines.slice(start.line + 1, end.line), last.slice(0, end.character)].join("\n");
}

export function captureAnchor(documentText: string, range: TextRange): NoteAnchor {
  const lines = linesOf(documentText);
  const text = textForRange(lines, range);
  if (text === undefined) {
    throw new Error("Cannot capture an anchor outside the document.");
  }
  return {
    text,
    before: lines.slice(Math.max(0, range.start.line - CONTEXT_LINES), range.start.line),
    after: lines.slice(range.end.line + 1, range.end.line + 1 + CONTEXT_LINES),
  };
}

function contextScore(lines: readonly string[], range: TextRange, anchor: NoteAnchor): number {
  let score = 0;
  for (let offset = 0; offset < anchor.before.length; offset++) {
    if (lines[range.start.line - 1 - offset] === anchor.before[anchor.before.length - 1 - offset]) {
      score++;
    }
  }
  for (let offset = 0; offset < anchor.after.length; offset++) {
    if (lines[range.end.line + 1 + offset] === anchor.after[offset]) {
      score++;
    }
  }
  return score;
}

function positionAt(lines: readonly string[], offset: number): TextPosition {
  for (let line = 0; line < lines.length; line++) {
    const length = lines[line]!.length;
    if (offset <= length) {
      return { line, character: offset };
    }
    offset -= length + 1;
  }
  throw new Error("Offset is outside the document.");
}

export function reanchor(documentText: string, storedRange: TextRange, anchor: NoteAnchor): ReanchorResult {
  const lines = linesOf(documentText);
  if (textForRange(lines, storedRange) === anchor.text
    && (anchor.text !== "" || lines[storedRange.start.line] === "")
    && contextScore(lines, storedRange, anchor) === anchor.before.length + anchor.after.length) {
    return { status: "active", range: storedRange };
  }
  const candidates: TextRange[] = [];
  if (anchor.text === "") {
    lines.forEach((line, index) => {
      if (line === "") {
        candidates.push({ start: { line: index, character: 0 }, end: { line: index, character: 0 } });
      }
    });
  } else {
    const text = lines.join("\n");
    for (let offset = text.indexOf(anchor.text); offset !== -1; offset = text.indexOf(anchor.text, offset + 1)) {
      candidates.push({ start: positionAt(lines, offset), end: positionAt(lines, offset + anchor.text.length) });
    }
  }
  if (candidates.length === 1) {
    return { status: "active", range: candidates[0]! };
  }
  const scored = candidates.map((range) => ({ range, score: contextScore(lines, range, anchor) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0 || best.score === scored[1]?.score) {
    return { status: "stale" };
  }
  return { status: "active", range: best.range };
}
