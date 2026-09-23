export interface OffsetRange {
  start: number;
  end: number;
}

export interface TextEdit {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** Changes in one document event refer to the same original document. */
export function trackEdits(range: OffsetRange, changes: readonly TextEdit[]): OffsetRange & { deleted: boolean } {
  let { start, end } = range;
  let removed = false;
  for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    const from = change.rangeOffset;
    const to = from + change.rangeLength;
    const delta = change.text.length - change.rangeLength;
    if (to <= start) {
      start += delta;
      end += delta;
    } else if (from < end) {
      if (change.text === "" && from <= start && to >= end) {
        removed = true;
      }
      start = start < from ? start : from;
      end = end > to ? end + delta : from + change.text.length;
    }
  }
  return { start, end, deleted: removed && range.end > range.start && end === start };
}
