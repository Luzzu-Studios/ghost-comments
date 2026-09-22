import * as vscode from "vscode";
import { NoteController } from "./comments/noteController";
import { TagTreeProvider } from "./tags/tagTree";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new NoteController(context.workspaceState, context.extensionUri);
  context.subscriptions.push(controller);
  const tagTree = new TagTreeProvider(controller);
  context.subscriptions.push(
    tagTree,
    vscode.window.registerTreeDataProvider("ghostComments.tags", tagTree),
    vscode.commands.registerCommand(
      "ghostComments.revealDiscussion",
      (reference) => controller.revealDiscussion(reference),
    ),
  );
  await controller.initialize();
}

export function deactivate(): void {}
