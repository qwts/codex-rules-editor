# Codex Rules Editor

A local Codex plugin for viewing, testing, and safely editing command prefix
rules from an embedded MCP App.

The editor reads `~/.codex/rules/*.rules`, presents parsed `prefix_rule`
entries in a searchable interface, validates changes through
`codex execpolicy check`, creates timestamped backups, and atomically replaces
the active file. It never executes commands entered in the policy tester.

## Features

- Browse and search rules across every user-level `*.rules` file.
- Add, update, and delete structured `prefix_rule` entries.
- Test an argument vector against the effective policy without executing it.
- Require explicit acknowledgement for broad or risky command prefixes.
- Validate every mutation with Codex before replacing the active file.
- Preserve the previous file under `~/.codex/rule-backups`.

## Use

After installing the plugin, start a new Codex task and ask:

```text
Open my Codex command rules editor.
```

You can also invoke `$edit-codex-rules` directly, ask which rule matches a
command, or request a narrow allow, prompt, or forbidden rule. Interactive
requests open the full editor; focused requests use the plugin's structured
tools to list, test, save, or delete rules.

This plugin manages command prefix rules only. It does not change Codex sandbox
modes, approval policy, `AGENTS.md` instructions, or application permissions.

## Install locally

Add this repository to a local Codex plugin marketplace, install
`codex-rules-editor`, and start a new Codex task so the skill and MCP server are
loaded.

## Development

Requires Node.js 24 or newer.

```sh
npm install
npm run validate
```

The plugin entry point is `.codex-plugin/plugin.json`. Its local stdio MCP
server runs `dist/server/index.js`, while the React widget is compiled into
`dist/widget` and embedded into the MCP UI resource at runtime.

## Safety model

- Rules are parsed as data; Starlark files are never evaluated.
- Only simple top-level `*.rules` filenames under the active Codex rules
  directory can be written.
- Broad shell, interpreter, privileged, and single-token prefixes require an
  explicit acknowledgement.
- Candidate files must pass `codex execpolicy check` before installation.
- Existing files are backed up under `~/.codex/rule-backups`.
- Writes use a same-directory temporary file followed by atomic rename.
