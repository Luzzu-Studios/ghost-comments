export const TAG_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
] as const;

export type TagColor = typeof TAG_COLORS[number];

export interface TagDefinition {
  id: string;
  label: string;
  color: TagColor;
}

export interface DisplayTag extends TagDefinition {
  unknown?: boolean;
  untagged?: boolean;
}

export const DEFAULT_TAGS: readonly TagDefinition[] = [
  { id: "todo", label: "To Do", color: "orange" },
  { id: "question", label: "Question", color: "blue" },
  { id: "important", label: "Important", color: "red" },
  { id: "done", label: "Done", color: "green" },
];

const COLOR_EMOJI: Record<TagColor, string> = {
  red: "🔴",
  orange: "🟠",
  yellow: "🟡",
  green: "🟢",
  blue: "🔵",
  purple: "🟣",
  gray: "⚪",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);
}

export function parseTagDefinitions(value: unknown): TagDefinition[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_TAGS];
  }
  const ids = new Set<string>();
  const definitions: TagDefinition[] = [];
  for (const entry of value) {
    if (!isObject(entry)
      || typeof entry.id !== "string"
      || !/^[a-z0-9][a-z0-9._-]*$/.test(entry.id)
      || typeof entry.label !== "string"
      || !entry.label.trim()
      || !isTagColor(entry.color)
      || ids.has(entry.id)) {
      continue;
    }
    ids.add(entry.id);
    definitions.push({
      id: entry.id,
      label: entry.label.trim(),
      color: entry.color,
    });
  }
  return definitions;
}

export function displayTag(
  tagId: string | undefined,
  definitions: readonly TagDefinition[] = DEFAULT_TAGS,
): DisplayTag {
  if (!tagId) {
    return { id: "", label: "Untagged", color: "gray", untagged: true };
  }
  return definitions.find((tag) => tag.id === tagId)
    ?? { id: tagId, label: `Unknown: ${tagId}`, color: "gray", unknown: true };
}

export function nativeTagLabel(
  tagId: string | undefined,
  definitions?: readonly TagDefinition[],
): string | undefined {
  if (!tagId) {
    return undefined;
  }
  const tag = displayTag(tagId, definitions);
  return `${COLOR_EMOJI[tag.color]} ${tag.label}`;
}
