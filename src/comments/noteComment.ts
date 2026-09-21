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
    this.body = safeMarkdown(body);
    this.savedBody = body;
    this.author = { name: author };
    this.timestamp = new Date(updatedAt);
    this.contextValue = stale ? "stale" : "active";
    this.label = stale ? "code location missing" : undefined;
  }

  update(body: string, author: string, updatedAt: string, stale: boolean): boolean {
    const contextValue = stale ? "stale" : "active";
    const timestamp = new Date(updatedAt);
    if (this.savedBody === body && this.author.name === author
      && this.timestamp.getTime() === timestamp.getTime() && this.contextValue === contextValue) {
      return false;
    }
    this.savedBody = body;
    this.author = { name: author };
    this.timestamp = timestamp;
    this.contextValue = contextValue;
    this.label = stale ? "code location missing" : undefined;
    // Updating another message or receiving a file change must not discard a draft.
    if (this.mode !== vscode.CommentMode.Editing) {
      this.body = safeMarkdown(body);
    }
    return true;
  }

  restore(): void {
    this.body = safeMarkdown(this.savedBody);
    this.mode = vscode.CommentMode.Preview;
  }
}

export function commentBodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
