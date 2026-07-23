---
name: edit-codex-rules
description: View, test, add, update, or remove Codex command prefix rules through the local Codex Rules Editor. Use when the user asks which commands are approved, wants to change ~/.codex/rules/*.rules, needs to test execpolicy matching, or asks to open the rules editor. Do not use for sandbox modes, approval-policy changes, AGENTS.md instructions, or application permissions unrelated to command prefix rules.
---

# Edit Codex Rules

Use `open_rules_editor` when the user asks to browse or interactively edit
rules. It renders the complete local rules UI.

For a focused request:

- Call `list_rules` before modifying an existing rule.
- Call `test_command` when the user asks what would match without requesting a
  change.
- Call `save_rule` for an explicitly requested add or update.
- Call `delete_rule` only when the user explicitly requests deletion.

Preserve narrow command prefixes. If a tool reports broad-prefix warnings,
explain the risk and require explicit acknowledgement before retrying with
`acknowledgeBroad = true`.

Every successful mutation creates a backup outside the active `rules/`
directory and validates the candidate file with `codex execpolicy check` before
atomic replacement. Report the backup path returned by the tool.
