# Changesets

This folder contains **pending release notes**. Each `.md` file describes one user-facing fix or feature that should appear in the next generated changelog, including private websites and apps.

## What to put here

- Add one descriptive kebab-case `.md` file per logical change, for example `fix-auth-token-refresh.md`.
- Use `patch` for fixes and `minor` for new features.
- Include private user-facing packages in the frontmatter so they keep a CHANGELOG.
- Write in present tense, focused on what users see.
- Check GitHub issues first. If the change fixes one, include `Fixes #123` on its own line.

## What not to put here

- Do not skip a website or app just because it is `"private": true`.
- Do not add changesets for packages without a `version` field.
- Do not edit `CHANGELOG.md` directly.
- Do not run the interactive changeset CLI.
- Do not add vague entries like "misc improvements" or "update internals".
