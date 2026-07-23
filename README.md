# Codex Rules Editor

A local Codex plugin for viewing, testing, and safely editing command prefix
rules from an embedded MCP App.

The editor reads `~/.codex/rules/*.rules`, presents parsed `prefix_rule`
entries in a searchable interface, validates changes through
`codex execpolicy check`, creates timestamped backups, and atomically replaces
the active file. It never executes commands entered in the policy tester.

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

## Installing locally

Add the repository through a local Codex plugin marketplace, install
`codex-rules-editor`, then start a new Codex task. Invoke
`$edit-codex-rules` or ask Codex to open the command rules editor.
