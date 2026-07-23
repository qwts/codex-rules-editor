import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  RulesManager,
  type PatternToken,
  type RuleDecision,
  type RuleSnapshot,
} from "./rules.js";

const SERVER_NAME = "Codex Rules Editor";
const SERVER_VERSION = "0.1.0";
const WIDGET_URI = "ui://codex-rules-editor/rules.html";
const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manager = new RulesManager();

const patternTokenSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

const ruleFields = {
  pattern: z.array(patternTokenSchema).min(1),
  decision: z.enum(["allow", "prompt", "forbidden"]),
  justification: z.string().default(""),
  match: z.array(z.string()).default([]),
  notMatch: z.array(z.string()).default([]),
};

function summary(snapshot: RuleSnapshot): string {
  const errorSuffix =
    snapshot.parseErrors.length === 0
      ? ""
      : ` ${snapshot.parseErrors.length} file(s) could not be parsed.`;
  return `Found ${snapshot.rules.length} rules across ${snapshot.files.length} files.${errorSuffix}`;
}

function textResult(
  text: string,
  structuredContent: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
    _meta: metadata,
  };
}

async function widgetHtml(): Promise<string> {
  const [javascript, css] = await Promise.all([
    readFile(path.join(rootDirectory, "dist/widget/app.js"), "utf8"),
    readFile(path.join(rootDirectory, "dist/widget/app.css"), "utf8"),
  ]);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${javascript}</script>
  </body>
</html>`;
}

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Use open_rules_editor for interactive browsing and editing. Call list_rules before direct updates. save_rule and delete_rule modify local Codex configuration, validate with execpolicy, create backups, and fail closed on broad prefixes unless the user explicitly acknowledges the warning.",
  },
);

registerAppResource(
  server,
  "codex-rules-editor-widget",
  WIDGET_URI,
  {},
  async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await widgetHtml(),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
          "openai/widgetDescription":
            "Interactive editor for local Codex command prefix rules.",
          "openai/widgetPrefersBorder": true,
        },
      },
    ],
  }),
);

registerAppTool(
  server,
  "open_rules_editor",
  {
    title: "Open Codex Rules Editor",
    description:
      "Open the interactive local Codex command-rules editor. Use when the user asks to view, browse, add, edit, delete, or test rules.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": WIDGET_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Loading command rules…",
      "openai/toolInvocation/invoked": "Command rules ready",
    },
  },
  async () => {
    const snapshot = await manager.snapshot();
    return textResult(summary(snapshot), { snapshot });
  },
);

registerAppTool(
  server,
  "list_rules",
  {
    title: "List Codex command rules",
    description:
      "Read all user-level .rules files and return parsed prefix rules and parse errors without opening the editor.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      ui: { visibility: ["model", "app"] },
      "openai/toolInvocation/invoking": "Reading command rules…",
      "openai/toolInvocation/invoked": "Command rules read",
    },
  },
  async () => {
    const snapshot = await manager.snapshot();
    return textResult(summary(snapshot), { snapshot });
  },
);

registerAppTool(
  server,
  "save_rule",
  {
    title: "Save a Codex command rule",
    description:
      "Add a rule or update an existing rule by ruleId. Broad command, shell, interpreter, privileged, or destructive prefixes require acknowledgeBroad=true after explicit user acknowledgement.",
    inputSchema: {
      ruleId: z.string().optional(),
      file: z.string().default("default.rules"),
      ...ruleFields,
      acknowledgeBroad: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      ui: { visibility: ["model", "app"] },
      "openai/toolInvocation/invoking": "Validating and saving rule…",
      "openai/toolInvocation/invoked": "Rule saved",
    },
  },
  async ({
    ruleId,
    file,
    pattern,
    decision,
    justification,
    match,
    notMatch,
    acknowledgeBroad,
  }) => {
    const result = await manager.save({
      ...(ruleId === undefined ? {} : { ruleId }),
      file,
      pattern: pattern as PatternToken[],
      decision: decision as RuleDecision,
      justification,
      match,
      notMatch,
      acknowledgeBroad,
    });
    return textResult(
      `Saved rule.${result.backupPath ? ` Backup: ${result.backupPath}` : ""}`,
      result as unknown as Record<string, unknown>,
    );
  },
);

registerAppTool(
  server,
  "delete_rule",
  {
    title: "Delete a Codex command rule",
    description:
      "Delete one existing prefix rule by its current ruleId. The operation validates the remaining file and creates a backup first.",
    inputSchema: {
      ruleId: z.string().min(1),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    _meta: {
      ui: { visibility: ["model", "app"] },
      "openai/toolInvocation/invoking": "Deleting rule…",
      "openai/toolInvocation/invoked": "Rule deleted",
    },
  },
  async ({ ruleId }) => {
    const result = await manager.delete(ruleId);
    return textResult(
      `Deleted rule. Backup: ${result.backupPath ?? "not needed"}`,
      result as unknown as Record<string, unknown>,
    );
  },
);

registerAppTool(
  server,
  "test_command",
  {
    title: "Test a command against Codex rules",
    description:
      "Run codex execpolicy check with an argv array and return the effective matching rule decision. This never executes the tested command.",
    inputSchema: {
      argv: z.array(z.string().min(1)).min(1).max(128),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    _meta: {
      ui: { visibility: ["model", "app"] },
      "openai/toolInvocation/invoking": "Testing command policy…",
      "openai/toolInvocation/invoked": "Command policy tested",
    },
  },
  async ({ argv }) => {
    const result = await manager.testCommand(argv);
    return textResult(
      "Tested the command without executing it.",
      { result },
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
