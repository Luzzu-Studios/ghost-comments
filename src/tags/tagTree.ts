import * as vscode from "vscode";
import type {
  DiscussionReference,
  DiscussionSummary,
  NoteController,
} from "../comments/noteController";
import {
  configuredTags,
  tagPickerIcon,
} from "./tagConfiguration";
import { displayTag } from "./tagDefinitions";
import type { DisplayTag } from "./tagDefinitions";
import type { StoredReply } from "../model/note";

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

interface ReplyNode extends DiscussionReference {
  kind: "reply";
  reply: StoredReply;
}

type TagTreeNode = TagNode | FileNode | NoteNode | ReplyNode;

function notePreview(body: string): string {
  return body.split(/\r?\n/).find((line) => line.trim())?.trim()
    ?? "Untitled note";
}

export class TagTreeProvider implements vscode.TreeDataProvider<TagTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TagTreeNode | undefined>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly controller: NoteController,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.subscription = controller.onDidChangeDiscussions(() => this.emitter.fire(undefined));
  }

  getTreeItem(element: TagTreeNode): vscode.TreeItem {
    if (element.kind === "tag") {
      const item = new vscode.TreeItem(
        element.tag.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = JSON.stringify(["tag", element.tag.id]);
      item.description = String(element.discussions.length);
      item.iconPath = tagPickerIcon(this.extensionUri, element.tag.color);
      item.contextValue = "ghostComments.tag";
      return item;
    }
    if (element.kind === "file") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      const first = element.discussions[0]!;
      item.id = JSON.stringify(["file", element.tag.id, first.workspaceUri, first.note.filePath]);
      item.description = String(element.discussions.length);
      item.iconPath = new vscode.ThemeIcon("file");
      item.contextValue = "ghostComments.file";
      return item;
    }
    if (element.kind === "reply") {
      const item = new vscode.TreeItem(notePreview(element.reply.body));
      item.id = JSON.stringify(["reply", element.workspaceUri, element.noteId, element.reply.id]);
      item.description = element.reply.author;
      item.tooltip = new vscode.MarkdownString(element.reply.body);
      item.iconPath = new vscode.ThemeIcon("comment");
      item.contextValue = "ghostComments.reply";
      item.command = {
        command: "ghostComments.revealDiscussion",
        title: "Open Ghost Comment",
        arguments: [{ workspaceUri: element.workspaceUri, noteId: element.noteId }],
      };
      return item;
    }
    const { note } = element.discussion;
    const item = new vscode.TreeItem(
      notePreview(note.body),
      note.replies?.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = JSON.stringify(["note", element.workspaceUri, element.noteId]);
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
    if (element.kind === "note") {
      return (element.discussion.note.replies ?? []).map((reply): ReplyNode => ({
        kind: "reply",
        workspaceUri: element.workspaceUri,
        noteId: element.noteId,
        reply,
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
