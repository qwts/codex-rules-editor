import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes the rules tools and embedded widget", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-rules-mcp-"));
  const codexHome = path.join(directory, "codex-home");
  const rulesDirectory = path.join(codexHome, "rules");
  const fakeCodex = path.join(directory, "fake-codex");
  await mkdir(rulesDirectory, { recursive: true });
  await writeFile(
    path.join(rulesDirectory, "default.rules"),
    'prefix_rule(pattern=["git", "status"], decision="allow")\n',
  );
  await writeFile(
    fakeCodex,
    '#!/bin/sh\nprintf \'{"matchedRules":[],"decision":"allow"}\\n\'\n',
  );
  await chmod(fakeCodex, 0o755);

  const client = new Client({
    name: "codex-rules-editor-test",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_BIN: fakeCodex,
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "delete_rule",
        "list_rules",
        "open_rules_editor",
        "save_rule",
        "test_command",
      ],
    );

    const opened = await client.callTool({
      name: "open_rules_editor",
      arguments: {},
    });
    const structured = opened.structuredContent as {
      snapshot?: { rules?: unknown[] };
    };
    assert.equal(structured.snapshot?.rules?.length, 1);

    const resource = await client.readResource({
      uri: "ui://codex-rules-editor/rules.html",
    });
    const html = resource.contents[0];
    assert.equal(html?.mimeType, "text/html;profile=mcp-app");
    assert.match("text" in (html ?? {}) ? String(html?.text) : "", /Command rules/);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
