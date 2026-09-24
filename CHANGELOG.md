# Changelog

All notable changes to Ghost Comments are documented in this file.

## Unreleased

- Rename shared discussion storage to `.gc/comments.json` and migrate existing `.gc/notes.json` files on first open.

## 1.0.0 - 2026-09-23

- Attach durable Markdown discussions to selected code or a complete line.
- Store repository-shared discussions in `.gc/notes.json` with passive backups.
- Follow moved code and provide an explicit reattachment flow for detached notes.
- Add replies that appear in both native comment threads and the Tagged Comments sidebar.
- Categorize discussions with configurable colored tags, including tag creation from the picker.
- Browse discussions by tag and file and open them from the Activity Bar.
