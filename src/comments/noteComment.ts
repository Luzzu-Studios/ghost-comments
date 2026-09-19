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
  readonly author: vscode.CommentAuthorInformation;
  readonly timestamp: Date;
  readonly contextValue: "stale" | "active";
  readonly label: string | undefined;
  savedBody: string;

  constructor(
    readonly noteId: string,
    body: string,
    author: string,
    readonly parent: vscode.CommentThread,
    updatedAt: string,
    stale: boolean,
  ) {
    this.body = safeMarkdown(body);
    this.savedBody = body;
    this.author = { name: author };
    this.timestamp = new Date(updatedAt);
    this.contextValue = stale ? "stale" : "active";
    this.label = stale ? "stale anchor" : undefined;
  }

  restore(): void {
    this.body = safeMarkdown(this.savedBody);
    this.mode = vscode.CommentMode.Preview;
  }
}

export function commentBodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}
