---
name: commit-helper
description: Write a commit message from the staged diff. Use when the user asks to commit or wants a message for their changes.
---

# commit-helper

Read `git diff --staged`. Summarize the change in one line under 72 characters,
in the imperative mood. Add a body only when the reason is not obvious from
the diff. Never include unrelated files.
