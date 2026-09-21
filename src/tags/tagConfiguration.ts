import * as vscode from "vscode";
import {
  DEFAULT_TAGS,
  parseTagDefinitions,
} from "./tagDefinitions";
import type { TagColor, TagDefinition } from "./tagDefinitions";

const THEME_COLORS: Record<TagColor, string> = {
  red: "charts.red",
  orange: "charts.orange",
  yellow: "charts.yellow",
  green: "charts.green",
  blue: "charts.blue",
  purple: "charts.purple",
  gray: "charts.foreground",
};

export function configuredTags(): TagDefinition[] {
  return parseTagDefinitions(
    vscode.workspace.getConfiguration("ghostComments").get<unknown>("tags", DEFAULT_TAGS),
  );
}

export function tagThemeColor(color: TagColor): vscode.ThemeColor {
  return new vscode.ThemeColor(THEME_COLORS[color]);
}
