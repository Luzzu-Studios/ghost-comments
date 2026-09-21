import * as vscode from "vscode";
import type {
  DiscussionReference,
  DiscussionSummary,
  NoteController,
} from "../comments/noteController";
import {
  configuredTags,
  tagThemeColor,
} from "./tagConfiguration";
import { displayTag } from "./tagDefinitions";
import type { DisplayTag } from "./tagDefinitions";

interface TagNode {
  kind: "tag";
  tag: DisplayTag;
  discussions: DiscussionSummary[];
}

interface FileNode {
  kind: "file";
  tag: DisplayTag;
  label: string;
  discussions: DiscussionSummary[];
}

interface NoteNode extends DiscussionReference {
  kind: "note";
  discussion: DiscussionSummary;
}

type TagTreeNode = TagNode | FileNode | NoteNode;

function notePreview(body: string): string {
  return body.split(/\r?\n/).find((line) => line.trim())?.trim()
    ?? "Untitled note";
}

export class TagTreeProvider implements vscode.TreeDataProvider<TagTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TagTreeNode | undefined>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: NoteController) {
    this.subscription = controller.onDidChangeDiscussions(() => this.emitter.fire(undefined));
  }

  getTreeItem(element: TagTreeNode): vscode.TreeItem {
    if (element.kind === "tag") {
      const item = new vscode.TreeItem(
        element.tag.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(element.discussions.length);
      item.iconPath = new vscode.ThemeIcon("tag", tagThemeColor(element.tag.color));
      item.contextValue = "ghostComments.tag";
      return item;
    }
    if (element.kind === "file") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = String(element.discussions.length);
      item.iconPath = new vscode.ThemeIcon("file");
      item.contextValue = "ghostComments.file";
      return item;
    }
    const { note } = element.discussion;
    const item = new vscode.TreeItem(notePreview(note.body));
    item.description = `${note.author} · line ${note.range.start.line + 1}${
      note.status === "stale" ? " · stale" : ""
    }`;
    item.tooltip = new vscode.MarkdownString(note.body);
    item.iconPath = new vscode.ThemeIcon(
      note.status === "stale" ? "warning" : "comment-discussion",
    );
    item.contextValue = "ghostComments.note";
    item.command = {
      command: "ghostComments.revealDiscussion",
      title: "Open Ghost Comment",
      arguments: [{ workspaceUri: element.workspaceUri, noteId: element.noteId }],
    };
    return item;
  }

  getChildren(element?: TagTreeNode): TagTreeNode[] {
    if (!element) {
      return this.tagNodes();
    }
    if (element.kind === "tag") {
      const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
      const files = new Map<string, DiscussionSummary[]>();
      for (const discussion of element.discussions) {
        const key = `${discussion.workspaceUri}::${discussion.note.filePath}`;
        const entries = files.get(key) ?? [];
        entries.push(discussion);
        files.set(key, entries);
      }
      return [...files.values()]
        .map((discussions): FileNode => ({
          kind: "file",
          tag: element.tag,
          label: multiRoot
            ? `${discussions[0]!.workspaceFolder.name}/${discussions[0]!.note.filePath}`
            : discussions[0]!.note.filePath,
          discussions,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    if (element.kind === "file") {
      return [...element.discussions]
        .sort((a, b) => a.note.range.start.line - b.note.range.start.line
          || a.note.range.start.character - b.note.range.start.character
          || a.note.id.localeCompare(b.note.id))
        .map((discussion): NoteNode => ({
          kind: "note",
          workspaceUri: discussion.workspaceUri,
          noteId: discussion.noteId,
          discussion,
        }));
    }
    return [];
  }

  private tagNodes(): TagNode[] {
    const definitions = configuredTags();
    const configuredOrder = new Map(definitions.map((tag, index) => [tag.id, index]));
    const groups = new Map<string, TagNode>();
    for (const discussion of this.controller.discussions) {
      const tag = displayTag(discussion.note.tag, definitions);
      const key = discussion.note.tag ?? "";
      const group = groups.get(key) ?? { kind: "tag", tag, discussions: [] };
      group.discussions.push(discussion);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => {
      const aOrder = configuredOrder.get(a.tag.id);
      const bOrder = configuredOrder.get(b.tag.id);
      if (aOrder !== undefined || bOrder !== undefined) {
        return (aOrder ?? Number.MAX_SAFE_INTEGER) - (bOrder ?? Number.MAX_SAFE_INTEGER);
      }
      if (a.tag.untagged !== b.tag.untagged) {
        return a.tag.untagged ? 1 : -1;
      }
      return a.tag.label.localeCompare(b.tag.label);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
