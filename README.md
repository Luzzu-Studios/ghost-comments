# Ghost Comments

Ghost Comments attaches durable, repository-shared notes to code without placing comment text in source files.

## Use

1. Select code, or leave the cursor on a line to annotate the full line.
2. Press `Cmd+Alt+N` on macOS or `Ctrl+Alt+N` on Windows and Linux.
3. Enter a multiline Markdown note in the native VS Code comment editor and choose **Save Note**.

The first note prompts for an author name. Change it later with the `Ghost Comments: Author Name` setting. Existing notes retain their original author.

Saved notes use VS Code's native gutter indicator and Comments panel. Open a note to read it, use its edit action to change it, or use its delete action to remove it from the shared file.

### Change the shortcut

If the default shortcut does nothing or conflicts with macOS or another extension:

1. Run **Preferences: Open Keyboard Shortcuts** from the Command Palette.
2. Search for **Ghost Comments: Create Note** or `ghostComments.createNote`.
3. Select the edit icon, choose **Change Keybinding**, and press the shortcut you want.
4. Press Enter to save it.

For example, `Shift+Option+N` is a working macOS alternative. User keybindings override Ghost Comments's packaged default.

## Shared Storage

Each workspace folder stores notes in:

```text
.gc/notes.json
```

Commit this file to Git when notes should be shared with the repository team. Ghost Comments watches it for changes, including changes produced by Git operations, and updates visible threads without polling.

The file contains a `schemaVersion` and deterministic note records. Each record stores a workspace-relative path, range, contextual anchor, Markdown body, author, timestamps, and anchor status. Do not edit the schema version manually. Invalid files are reported and never overwrite the last valid in-memory state.

## Moving Code

Ghost Comments stores both the original range and nearby text. When a document opens, it checks the original range and then searches for a unique contextual match if lines moved.

If no safe match exists, the note becomes **stale**. A stale note remains in the Comments panel without a misleading editor marker. Open the intended file, select its new anchor, and choose **Reattach Note** from the stale thread.

File renames within the same workspace folder update note paths automatically. Moving a file between workspace folders is not automatic because each folder owns a separate notes file.

## Scope

The MVP supports one durable note per anchor with create, edit, delete, and reattach actions. It deliberately does not include replies, resolved state, cloud synchronization, authentication, a custom sidebar, or a webview.

VS Code does not expose a general-purpose IntelliSense-style popup API for arbitrary extension input. Ghost Comments uses the supported native Comments API, which provides editor-anchored multiline input, theme integration, gutter indicators, and the Comments panel with minimal extension overhead.

## Development

Requirements: Node.js 20 or later and VS Code 1.100 or later.

See the [development guide](https://github.com/Luzzu-Studios/ghost-comments/blob/main/docs/README.md) (`docs/README.md` in this checkout) for the entry points, architecture, runtime flow, storage model, re-anchoring algorithm, build pipeline, and test structure.

```bash
npm install
npm run check
npm run test:unit
npm run test:integration
npm run build
```

### Manual sandbox

Run `npm run sandbox` to build the extension and open `sample.ts` in a separate VS Code window. The script downloads or reuses the same VS Code runtime as the integration tests, but runs no tests and stays open until you close the window. Sandbox settings and extensions are isolated under `.vscode-test/`; notes persist in `test/fixtures/workspace/.gc/notes.json`.

The **Run Ghost Comments (Sandbox)** launch profile opens `test/fixtures/workspace` in a separate Extension Development Host with other extensions disabled.

On macOS, the physical `F5` key can be assigned to Dictation. If macOS asks to enable Dictation, dismiss it and use one of these instead:

- Press `Fn+F5`.
- Open **Run and Debug**, select **Run Ghost Comments (Sandbox)**, and choose the start button.
- Run **Debug: Start Debugging** from the Command Palette.

In the Extension Development Host:

1. Open `sample.ts`.
2. Select `const message = ...` and press `Cmd+Option+N`.
3. Enter an author name when prompted, write a multiline note, and choose **Save Note**.
4. Confirm the native comment marker appears and `.gc/notes.json` is created.
5. Put the cursor on another line without selecting text and create another note. It should anchor to the full line.
6. Open a saved note and verify its edit and delete actions.
7. Run **Developer: Reload Window** and confirm the notes return.
8. To test re-anchoring, insert lines above a note and save. Close and reopen the file; the note should follow its original code.
9. To test stale handling, close the annotated file, change or remove its anchored text outside the Extension Development Host, then reopen it. The note should remain in the Comments panel as stale without a gutter marker.
10. Select a new location and choose **Reattach Note** from the stale thread.

Delete `test/fixtures/workspace/.gc` after manual testing if you do not want to keep the sandbox notes.

Run `npm run test:integration` to execute the automated integration suite in a clean Extension Host.

Create a VSIX with:

```bash
npm run package
```

The extension is event-driven: it activates for the create command or an existing `.gc/notes.json`, watches only note files, and validates source anchors when relevant documents open or save.
