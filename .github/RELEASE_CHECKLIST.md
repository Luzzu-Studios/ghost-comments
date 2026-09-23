# Marketplace Release Checklist

## Before packaging

- [ ] Replace `assets/marketplace/overview.png` with a polished overview showing the editor, a native discussion, and the Tagged Comments sidebar.
- [ ] Replace the static placeholder `assets/marketplace/create-and-tag.gif` with a short recording of selecting code, writing a note, choosing a tag, and seeing the sidebar update.
- [ ] Confirm the media contains no private source, local paths, personal information, or test text.
- [ ] Confirm the `LuzzuStudios` Marketplace publisher exists and the release owner can manage it.
- [ ] Run `npm run check`, `npm run test:unit`, `npm run test:integration`, and `npm run build`.
- [ ] Run integration tests with `--code-version 1.138.0` and current Stable.
- [ ] Run `npm run package` and inspect the package with `vsce ls`.
- [ ] Install the final VSIX in a clean VS Code profile and complete the smoke test.

## Public repository gate

- [ ] Make the GitHub repository public and enable Issues.
- [ ] Verify the README images and development guide load without authentication.
- [ ] Verify the repository, homepage, support, issue, and license links.
- [ ] Add the repository description and the `vscode-extension`, `code-comments`, `annotations`, and `developer-tools` topics.

## Release

- [ ] Merge the release commit to `main` and tag that exact commit as `v1.0.0`.
- [ ] Upload the inspected VSIX manually through Marketplace publisher management.
- [ ] Create the matching GitHub release and attach the exact published VSIX.
- [ ] Verify the installed Marketplace version and its public listing.
