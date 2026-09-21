import * as vscode from "vscode";

function safeMarkdown(body: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(body);
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  return markdown;
}

export class NoteComment implements vscode.Comment {
  body: vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  timestamp: Date;
  contextValue: "stale" | "active";
  label: string | undefined;
  savedBody: string;

  constructor(
    readonly noteId: string,
    body: string,
    author: string,
    readonly parent: vscode.CommentThread,
    updatedAt: string,
    stale: boolean,
    readonly replyId?: string,
  ) {
    this.body = this.previewBody(body, stale);
    this.savedBody = body;
    this.author = { name: author };
    this.timestamp = new Date(updatedAt);
    this.contextValue = stale ? "stale" : "active";
    this.label = undefined;
  }

  update(
    body: string,
    author: string,
    updatedAt: string,
    stale: boolean,
  ): boolean {
    const contextValue = stale ? "stale" : "active";
    const timestamp = new Date(updatedAt);
    if (
      this.savedBody === body &&
      this.author.name === author &&
      this.timestamp.getTime() === timestamp.getTime() &&
      this.contextValue === contextValue
    ) {
      return false;
    }
    this.savedBody = body;
    this.author = { name: author };
    this.timestamp = timestamp;
    this.contextValue = contextValue;
    this.label = undefined;
    // Updating another message or receiving a file change must not discard a draft.
    if (this.mode !== vscode.CommentMode.Editing) {
      this.body = this.previewBody(body, stale);
    }
    return true;
  }

  private previewBody(body: string, stale: boolean): vscode.MarkdownString {
    // VS Code owns the row's line-number metadata. Mark the first preview line
    // instead, without adding the marker to stored text or editable drafts.
    if (!stale || this.replyId) { return safeMarkdown(body); }
    const newline = body.indexOf("\n");
    const end = newline === -1 ? body.length : newline;
    return safeMarkdown(`${body.slice(0, end)} ⚠️${body.slice(end)}`);
  }

  restore(): void {
    this.body = this.previewBody(this.savedBody, this.contextValue === "stale");
    this.mode = vscode.CommentMode.Preview;
  }
}

export function commentBodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
