---
name: lop-winops
description: 'Use by default for Windows local OS operations, including command execution, file handling, ShellExecute/open, registry, service, process, port, text, JSON, archive, quote-sensitive, Chinese, regex, Markdown, path safety, or any case where cmd/pwsh/nu/nush should be avoided; run through C:\Users\lop\.codex\tools\winops\winops.exe UTF-8 job/result files.'
---

# lop-winops

Use this skill by default for Windows local OS work. The goal is to keep business input and mutable operations out of every shell parser; `cmd`, `pwsh`, `nu`, and `nush` are legacy fallback surfaces, not the normal execution plan.

## Required Workflow

1. Write the operation as a UTF-8 job file, preferably under `C:\Users\lop\.codex\tmp\winops\`.
2. Run `C:\Users\lop\.codex\tools\winops\winops.exe <job.json>`. If the current Codex executor needs a shell to start the exe, treat that shell as bootstrap only; do not put business payloads in it.
3. Read the result JSON path printed by stdout, then inspect `ok`, `data`, `stdout`, `stderr`, and `error`.
4. If the job mutates files, processes, services, or registry state, use a read-only query or dry-run first when feasible.
5. For destructive operations, do not execute until the absolute target path or object has been verified. Actual destructive execution must set both `dryRun:false` and `confirm:true`.

## Operation Coverage

Prefer winops for:

- `exec`: direct executable plus argv array, no shell body.
- `fs`: read, write, copy, move, delete, list, hash, path checks.
- `open`: ShellExecute-style file, directory, or URL opening.
- `registry`: query, set, delete, and enumerate registry values or keys.
- `service`: query, start, stop, and status checks.
- `proc`: process list, command-line inspection, dry-run or confirmed kill.
- `net`: port and listener inspection.
- `text`: literal/regex search, replace, line slicing, encoding-sensitive reads.
- `json`: parse, select, and write JSON without inline shell quoting.
- `archive`: zip, list, and unzip.

## Routing Rules

- Use winops first even for simple reads, searches, copies, port checks, process checks, and external executable argv when the operation is part of a Windows local task.
- Allow `cmd`, `pwsh`, `nu`, or `nush` only for bootstrap, uncovered OS objects/APIs, or explicit shell reproduction requested by the user.
- Do not add more shell escaping after a quote/encoding failure; move the payload into the job file.
- Treat `run-argv.mjs` as legacy compatibility. New Windows reliability work must use `winops.exe`.
- Reject `.cmd` and `.bat` wrappers by default. Prefer the real `.exe`, `.js`, or tool entrypoint unless an explicit shell wrapper is truly required.

## Verification

- For the tool itself, run `node C:\Users\lop\.codex\tools\winops-src\test-winops.mjs`.
- For a specific job, the minimum proof is `ok:true` in result JSON plus inspection of the returned fields that matter for the task.
- For rules or skill changes, verify trigger text with `rg -n winops` across `AGENTS.md`, `rules\artifact-apk-windows.md`, parent `RULES.md`, and this skill.
