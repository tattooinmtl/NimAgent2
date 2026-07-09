---
name: changelog
command: /changelog
description: Generate or update CHANGELOG.md from recent git history.
---

# Changelog

## Purpose
Produce or update a `CHANGELOG.md` in the current project from git history, in
the Keep a Changelog style.

## Steps
1. Run `git log --oneline -30` (and `git tag --sort=-creatordate` if tags exist)
   to see recent work and the last released version.
2. If `CHANGELOG.md` exists, read it to learn the format and the latest entry so
   you only add what's new. If it doesn't, create one with a `# Changelog`
   header and a Keep a Changelog intro line.
3. Group changes under an `## [Unreleased]` section using these subsections, in
   order, omitting empty ones: **Added**, **Changed**, **Fixed**, **Removed**.
4. Write concise, user-facing bullet points — describe the effect, not the
   commit message. Collapse noisy/WIP commits.
5. Show the resulting diff and stop. Do not commit or tag unless asked.

## Notes
- Never invent changes that aren't in the history.
- If the working tree is not a git repo, say so and ask how to proceed.
