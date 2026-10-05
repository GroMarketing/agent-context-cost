# Personal preferences

- Prefer small, reviewable commits with a one-line summary and a short body.
- Run the test suite before saying a change works. Paste the failing output if it fails.
- Use the project's existing formatter and lint settings. Do not reformat unrelated code.
- Ask before adding a new runtime dependency. Prefer the standard library.
- When a task is ambiguous, state the assumption you are making and continue.
- Keep explanations short. Lead with the answer, then the detail.
- Never commit secrets, .env files or credentials. Use environment variables.
- For shell scripts, use `set -euo pipefail` and quote every variable.
- For SQL, write migrations that can be rolled back.
- Mention `@not-an-import.md` in backticks so it stays literal.

## Writing

@~/.claude/notes/writing-style.md

## Reviews

When reviewing a diff, check error handling, input validation, and tests first.
List findings by severity. Point to the exact line.
