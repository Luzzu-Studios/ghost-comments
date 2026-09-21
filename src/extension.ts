import type * as vscode from "vscode";
import { NoteController } from "./comments/noteController";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new NoteController(context.workspaceState);
  context.subscriptions.push(controller);
  await controller.initialize();
}

export function deactivate(): void {}
