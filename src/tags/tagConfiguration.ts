import * as vscode from "vscode";
import {
  DEFAULT_TAGS,
  parseTagDefinitions,
} from "./tagDefinitions";
import type { TagColor, TagDefinition } from "./tagDefinitions";

export function configuredTags(): TagDefinition[] {
  return parseTagDefinitions(
    vscode.workspace.getConfiguration("ghostThreads").get<unknown>("tags", DEFAULT_TAGS),
  );
}

export function tagPickerIcon(extensionUri: vscode.Uri, color: TagColor): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "assets", "tag-icons", `${color}.svg`);
}
