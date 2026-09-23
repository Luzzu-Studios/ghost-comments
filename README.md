# Ghost Comments

Ghost Comments attaches durable, repository-shared notes to code without placing comment text in source files.

## Use

1. Select code, or leave the cursor on a line to annotate the full line.
2. Press `Cmd+Alt+N` on macOS or `Ctrl+Alt+N` on Windows and Linux.
3. Enter a multiline Markdown note in the native VS Code comment editor and choose **Save Note**.

The first note prompts for an author name. Change it later with the `Ghost Comments: Author Name` setting. Existing notes retain their original author.

Saved notes use VS Code's native gutter indicator and Comments panel. Open a note to read it, use its edit action to change it, or use its delete action to remove it from the shared file.

## Tags and Tagged Comments

When saving a new note, choose an optional category tag. **Untagged** is the first and default choice, so pressing Enter in the tag picker saves the note without a tag. Choose **Create New Tag…** at the end of the picker to enter a name and select one of seven colors; the new tag is added to workspace settings and applied to the note immediately. Cancelling the name or color step returns to the tag picker. Closing the tag picker keeps a new note as an unsaved draft. Use **Set Tag…** on an existing discussion to change its tag, create one, or choose **Untagged** to clear its assignment. The **Ghost Comments: Mark as Untagged** command remains available for existing shortcuts. Tags categorize the entire discussion, including its replies.

Open the Ghost Comments icon in the Activity Bar to browse discussions grouped by **tag → file → note → replies**, including an **Untagged** group. Expand a note to see its replies in order; selecting a note or reply opens its code and expands the native discussion. Stale notes open their file without pointing at an unsafe range. The sidebar and tag picker use the extension's consistently colored tag icons. Tagged native discussions show the tag name in the heading and a colored tag icon on the **Set Tag** action.

The default tags are To Do, Question, Important, and Done. New tags created in the picker are saved in the workspace's `ghostComments.tags` setting. To rename, recolor, reorder, or remove tag definitions, use **Preferences: Open Settings (JSON)**:

```json
"ghostComments.tags": [
  { "id": "todo", "label": "To Do", "color": "orange" },
  { "id": "review", "label": "Needs Review", "color": "purple" },
  { "id": "done", "label": "Done", "color": "green" }
]
```

Supported colors are `red`, `orange`, `yellow`, `green`, `blue`, `purple`, and `gray`. Keep an ID unchanged when renaming or recoloring a tag because the ID is stored in `notes.json`. Removing a definition does not discard assignments; affected notes appear under a gray `Unknown: <id>` group.

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

Ghost Comments also maintains a passive recovery snapshot at `.gc/notes-backup.json`. The first successful note change creates it, and by default every 10 later changes update it. Creates, edits, replies, deletions, reattachments, anchor changes, and file-path updates all count. An unchanged source-file save performs no notes-file write and does not advance the interval; one save that adjusts several anchors counts once. Set **Ghost Comments: Backup Interval** to another non-negative number, or to `0` to disable automatic backups. The interval is tracked separately for each workspace folder and continues across VS Code restarts.

The backup can trail `notes.json` by up to the configured interval and is never restored automatically. If `notes.json` is deleted or corrupted, preserve or remove the damaged file, copy or rename `notes-backup.json` to `notes.json`, and run **Developer: Reload Window**. The backup uses the same validated schema as the primary file, so no conversion is required. Restoring a backup discards changes made after that snapshot.

The file contains a `schemaVersion` and deterministic note records. Each record stores a workspace-relative path, range, contextual anchor, Markdown body, optional tag ID, author, timestamps, and anchor status. Do not edit the schema version manually. Invalid files are reported and never overwrite the last valid in-memory state.

## Moving Code

Ghost Comments stores both the original range and nearby text. When a document opens, it checks the original range and then searches for a unique contextual match if lines moved.

If no safe match exists, the note becomes **detached** (stored as `stale`). The Comments panel heading shows **Needs reattachment**, followed by the tag name when tagged, without a misleading editor marker. Detached notes remain detached even after undo, restoring matching code, saving, or reopening the file.

When code is deleted or missing anchors are discovered, a grouped prompt offers **Reattach…** or **Later**. Dismissing it preserves every comment and reply. Deletion remains a separate explicit action on the comment.

Choose **Reattach Note** from the detached thread or Command Palette, then select code or place the cursor on a line in a file in the same workspace folder. Click **Attach here** in the reattachment notification to confirm the destination, or **Cancel** to leave the note detached. The status bar, editor context menu, and Command Palette also provide **Attach here**. A selection attaches exactly that range; a cursor attaches the entire current line. The comment opens at its new location. **Cancel Reattachment** leaves it detached, and errors preserve it for retry.

File renames within the same workspace folder update note paths automatically. Moving a file between workspace folders is not automatic because each folder owns a separate notes file.

## Scope

Each anchored note supports Markdown replies, including replies to your own notes. Replies are stored with the note in `.gc/notes.json` and can be edited or deleted individually. Deleting the initial note deletes the entire discussion. All collaborators should use a reply-capable version of Ghost Comments before editing shared notes; older versions do not preserve replies.

The MVP supports create, edit, delete, reply, tagging, browsing by tag, and reattach actions. It deliberately does not include resolved state, cloud synchronization, authentication, or a webview.

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

Run `npm run sandbox` to build the extension and open `sample.ts` in a separate VS Code window. The script downloads or reuses the same VS Code runtime as the integration tests, but runs no tests and stays open until you close the window. Edit `test/fixtures/workspace/.vscode/settings.json` to customize `ghostComments.tags` in the sandbox; changes apply without editing the extension's `package.json`. The sandbox user profile and extensions are isolated under `.vscode-test/`, while notes persist in `test/fixtures/workspace/.gc/notes.json`.

The **Run Ghost Comments (Sandbox)** launch profile opens `test/fixtures/workspace` in a separate Extension Development Host with other extensions disabled.

On macOS, the physical `F5` key can be assigned to Dictation. If macOS asks to enable Dictation, dismiss it and use one of these instead:

- Press `Fn+F5`.
- Open **Run and Debug**, select **Run Ghost Comments (Sandbox)**, and choose the start button.
- Run **Debug: Start Debugging** from the Command Palette.

In the Extension Development Host:

1. Open `sample.ts`.
2. Select `const message = ...` and press `Cmd+Option+N`.
3. Enter an author name when prompted, write a multiline note, choose **Save Note**, and select a tag.
4. Confirm the native comment marker appears and `.gc/notes.json` is created.
5. Put the cursor on another line without selecting text and create another note. It should anchor to the full line.
6. Open a saved note and verify its edit and delete actions.
7. Run **Developer: Reload Window** and confirm the notes return.
8. To test re-anchoring, insert lines above a note and save. Close and reopen the file; the note should follow its original code.
9. To test stale handling, close the annotated file, change or remove its anchored text outside the Extension Development Host, then reopen it. The note should remain in the Comments panel as stale without a gutter marker.
10. Open the Ghost Comments Activity Bar view, verify tag grouping, change and clear a tag, and select a note to navigate to it.
11. Choose **Reattach Note**, select a new location, then choose **Attach here**. Repeat with only a cursor to verify whole-line attachment; cancel once to verify the note stays detached.

Delete `test/fixtures/workspace/.gc` after manual testing if you do not want to keep the sandbox notes.

Run `npm run test:integration` to execute the automated integration suite in a clean Extension Host.

Create a VSIX with:

```bash
npm run package
```

The extension is event-driven: it activates for its commands, the Ghost Comments view, or an existing `.gc/notes.json`, watches only note files, and validates source anchors when relevant documents open or save.
