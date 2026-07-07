---
name: lop-winops
description: Use for Windows local command, file, registry, service, process, port, text, JSON, or archive operations when quotes, backticks, spaces, Chinese, regex, Markdown, shell escaping, path safety, or the most reliable non-shell execution matters; run through C:\Users\lop\.codex\tools\winops\winops.exe UTF-8 job/result files instead of cmd/pwsh/nu/nush parsing.
---

# lop-winops

Use this skill when a Windows operation is likely to fail because the command line would need to preserve literal quotes, backticks, spaces, Chinese text, JSON, Markdown, regex, redirection characters, or shell metacharacters. The goal is to keep complex payloads out of every shell parser.

## Required Workflow

1. Write the operation as a UTF-8 job file, preferably under `C:\Users\lop\.codex\tmp\winops\`.
2. Run `C:\Users\lop\.codex\tools\winops\winops.exe <job.json>`.
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

- Keep `cmd` for short flat external commands and fixed searches.
- Keep `nu` for structure-heavy table or JSON filtering when the input is simple.
- Do not use `pwsh` as the default escape hatch for quote problems.
- Do not add more shell escaping after a quote/encoding failure; move the payload into the job file.
- Treat `run-argv.mjs` as legacy compatibility. New Windows reliability work should use `winops.exe`.
- Reject `.cmd` and `.bat` wrappers by default. Prefer the real `.exe`, `.js`, or tool entrypoint unless an explicit shell wrapper is truly required.

## Verification

- For the tool itself, run `node C:\Users\lop\.codex\tools\winops-src\test-winops.mjs`.
- For a specific job, the minimum proof is `ok:true` in result JSON plus inspection of the returned fields that matter for the task.
- For rules or skill changes, verify trigger text with `rg -n winops` across `AGENTS.md`, `rules\artifact-apk-windows.md`, parent `RULES.md`, and this skill.
