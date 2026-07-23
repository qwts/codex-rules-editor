import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Decision = "allow" | "prompt" | "forbidden";
type PatternToken = string | string[];

interface Rule {
  id: string;
  file: string;
  line: number;
  pattern: PatternToken[];
  decision: Decision;
  justification: string;
  match: string[];
  notMatch: string[];
}

interface Snapshot {
  codexHome: string;
  rulesDirectory: string;
  files: string[];
  rules: Rule[];
  parseErrors: Array<{ file: string; message: string }>;
}

interface ToolResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface OpenAIWindow {
  toolOutput?: Record<string, unknown>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  setWidgetState?: (state: unknown) => void;
}

declare global {
  interface Window {
    openai?: OpenAIWindow;
  }
}

let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve: (value: ToolResult) => void; reject: (reason: Error) => void }
>();

function bridgeCall(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (window.openai?.callTool) return window.openai.callTool(name, args);
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      "*",
    );
  });
}

function toolError(result: ToolResult): string | undefined {
  if (!result.isError) return undefined;
  return (
    result.content?.find((item) => item.type === "text")?.text ??
    "The tool call failed."
  );
}

function snapshotFrom(result: ToolResult): Snapshot | undefined {
  return result.structuredContent?.snapshot as Snapshot | undefined;
}

function formatPattern(pattern: PatternToken[]): string {
  return pattern
    .map((token) =>
      Array.isArray(token) ? `{${token.join(" | ")}}` : shellQuote(token),
    )
    .join(" ");
}

function shellQuote(token: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(token)
    ? token
    : JSON.stringify(token);
}

function riskWarnings(pattern: PatternToken[]): string[] {
  const first = pattern[0];
  const values = Array.isArray(first) ? first : [first];
  const warnings: string[] = [];
  if (pattern.length === 1) {
    warnings.push("Matches every invocation of this command.");
  }
  if (
    values.some((value) =>
      ["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"].includes(value),
    )
  ) {
    warnings.push("Shell entry points may hide compound commands.");
  }
  if (
    values.some((value) =>
      ["python", "python3", "node", "ruby", "perl", "osascript"].includes(value),
    ) &&
    pattern.length < 2
  ) {
    warnings.push("Interpreter-wide rules can execute arbitrary code.");
  }
  if (values.some((value) => ["rm", "sudo", "dd", "mkfs"].includes(value))) {
    warnings.push("This command commonly performs destructive or privileged actions.");
  }
  return [...new Set(warnings)];
}

interface Draft {
  id?: string;
  file: string;
  patternText: string;
  decision: Decision;
  justification: string;
  matchText: string;
  notMatchText: string;
  acknowledgeBroad: boolean;
}

function draftFor(rule?: Rule): Draft {
  return {
    ...(rule ? { id: rule.id } : {}),
    file: rule?.file ?? "default.rules",
    patternText: JSON.stringify(rule?.pattern ?? ["git", "status"]),
    decision: rule?.decision ?? "allow",
    justification: rule?.justification ?? "",
    matchText: rule?.match?.join("\n") ?? "",
    notMatchText: rule?.notMatch?.join("\n") ?? "",
    acknowledgeBroad: false,
  };
}

function parsePattern(text: string): PatternToken[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Pattern must be a non-empty JSON array.");
  }
  return value.map((token, index) => {
    if (typeof token === "string" && token.length > 0) return token;
    if (
      Array.isArray(token) &&
      token.length > 0 &&
      token.every((alternative) => typeof alternative === "string" && alternative.length > 0)
    ) {
      return token as string[];
    }
    throw new Error(
      `Pattern item ${index + 1} must be a string or non-empty string array.`,
    );
  });
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function initialSnapshot(): Snapshot | undefined {
  const output = window.openai?.toolOutput;
  if (output?.snapshot) return output.snapshot as Snapshot;

  if (import.meta.env.DEV) {
    return {
      codexHome: "/Users/example/.codex",
      rulesDirectory: "/Users/example/.codex/rules",
      files: ["default.rules"],
      rules: [
        {
          id: "default.rules:0",
          file: "default.rules",
          line: 1,
          pattern: ["git", "status"],
          decision: "allow",
          justification: "Inspect repository state without prompting.",
          match: ["git status", "git status --short"],
          notMatch: ["git push"],
        },
        {
          id: "default.rules:1",
          file: "default.rules",
          line: 8,
          pattern: ["npm", "test"],
          decision: "allow",
          justification: "Run the project test suite.",
          match: ["npm test"],
          notMatch: ["npm publish"],
        },
        {
          id: "default.rules:2",
          file: "default.rules",
          line: 15,
          pattern: ["git", "push"],
          decision: "prompt",
          justification: "Keep remote writes visible.",
          match: ["git push origin feature"],
          notMatch: ["git status"],
        },
      ],
      parseErrors: [],
    };
  }

  return undefined;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(initialSnapshot);
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<Decision | "all">("all");
  const [draft, setDraft] = useState<Draft | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [deletePending, setDeletePending] = useState(false);
  const [testText, setTestText] = useState(`["git", "status", "--short"]`);
  const [testResult, setTestResult] = useState<unknown>();

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const message = event.data as {
        jsonrpc?: string;
        id?: number;
        result?: ToolResult;
        error?: { message?: string };
        method?: string;
        params?: ToolResult;
      };
      if (message?.jsonrpc !== "2.0") return;
      if (typeof message.id === "number" && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(message.error.message ?? "Tool call failed."));
        } else {
          waiter.resolve(message.result ?? {});
        }
      }
      if (message.method === "ui/notifications/tool-result") {
        const next = snapshotFrom(message.params ?? {});
        if (next) setSnapshot(next);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  useEffect(() => {
    if (snapshot !== undefined) return;
    void refresh();
  }, [snapshot]);

  const filteredRules = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (snapshot?.rules ?? []).filter((rule) => {
      if (decisionFilter !== "all" && rule.decision !== decisionFilter) return false;
      if (!needle) return true;
      return [
        formatPattern(rule.pattern),
        rule.justification,
        rule.file,
        rule.decision,
      ]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [snapshot, search, decisionFilter]);

  const parsedDraftPattern = useMemo(() => {
    if (!draft) return undefined;
    try {
      return parsePattern(draft.patternText);
    } catch {
      return undefined;
    }
  }, [draft]);

  const warnings = parsedDraftPattern ? riskWarnings(parsedDraftPattern) : [];

  async function refresh() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridgeCall("list_rules", {});
      const failure = toolError(result);
      if (failure) throw new Error(failure);
      const next = snapshotFrom(result);
      if (!next) throw new Error("The rules server returned no snapshot.");
      setSnapshot(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const pattern = parsePattern(draft.patternText);
      const result = await bridgeCall("save_rule", {
        ...(draft.id ? { ruleId: draft.id } : {}),
        file: draft.file,
        pattern,
        decision: draft.decision,
        justification: draft.justification,
        match: lines(draft.matchText),
        notMatch: lines(draft.notMatchText),
        acknowledgeBroad: draft.acknowledgeBroad,
      });
      const failure = toolError(result);
      if (failure) throw new Error(failure);
      const next = snapshotFrom(result);
      if (next) setSnapshot(next);
      const backupPath = result.structuredContent?.backupPath;
      setNotice(
        typeof backupPath === "string"
          ? `Saved. Backup: ${backupPath}`
          : "Rule saved.",
      );
      setDraft(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft?.id) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridgeCall("delete_rule", { ruleId: draft.id });
      const failure = toolError(result);
      if (failure) throw new Error(failure);
      const next = snapshotFrom(result);
      if (next) setSnapshot(next);
      const backupPath = result.structuredContent?.backupPath;
      setNotice(
        `Rule deleted.${typeof backupPath === "string" ? ` Backup: ${backupPath}` : ""}`,
      );
      setDraft(undefined);
      setDeletePending(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function testCommand() {
    setBusy(true);
    setError(undefined);
    setTestResult(undefined);
    try {
      const argv: unknown = JSON.parse(testText);
      if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.some((value) => typeof value !== "string" || value.length === 0)
      ) {
        throw new Error("Command must be a non-empty JSON string array.");
      }
      const result = await bridgeCall("test_command", { argv });
      const failure = toolError(result);
      if (failure) throw new Error(failure);
      setTestResult(result.structuredContent?.result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">CODING · PERMISSIONS</p>
          <h1>Command rules</h1>
          <p className="path">{snapshot?.rulesDirectory ?? "Loading local rules…"}</p>
        </div>
        <div className="topbar-actions">
          <button className="secondary" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
          <button className="primary" onClick={() => setDraft(draftFor())}>
            Add rule
          </button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}
      {(snapshot?.parseErrors.length ?? 0) > 0 && (
        <div className="banner warning">
          {snapshot!.parseErrors.map((item) => (
            <div key={item.file}>
              <strong>{item.file}</strong>: {item.message}
            </div>
          ))}
        </div>
      )}

      <section className="toolbar">
        <input
          aria-label="Search rules"
          placeholder="Search commands, files, or explanations"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Filter by decision"
          value={decisionFilter}
          onChange={(event) =>
            setDecisionFilter(event.target.value as Decision | "all")
          }
        >
          <option value="all">All decisions</option>
          <option value="allow">Allow</option>
          <option value="prompt">Prompt</option>
          <option value="forbidden">Forbidden</option>
        </select>
      </section>

      <section className="summary">
        <span>{snapshot?.rules.length ?? 0} rules</span>
        <span>{snapshot?.files.length ?? 0} files</span>
        <span>{filteredRules.length} shown</span>
      </section>

      <section className="rule-list" aria-busy={busy}>
        {filteredRules.map((rule) => (
          <button
            className="rule-row"
            key={rule.id}
            onClick={() => setDraft(draftFor(rule))}
          >
            <span className={`decision ${rule.decision}`}>{rule.decision}</span>
            <span className="rule-main">
              <code>{formatPattern(rule.pattern)}</code>
              <span>{rule.justification || "No explanation provided"}</span>
            </span>
            <span className="rule-location">
              {rule.file}:{rule.line}
            </span>
            <span className="chevron">›</span>
          </button>
        ))}
        {!busy && filteredRules.length === 0 && (
          <div className="empty">
            <strong>No rules match this view.</strong>
            <span>Clear the filters or add a command rule.</span>
          </div>
        )}
      </section>

      <section className="tester">
        <div>
          <h2>Test a command</h2>
          <p>Checks user-level rules without executing the command.</p>
        </div>
        <div className="tester-controls">
          <input
            aria-label="Command argv JSON"
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
          />
          <button className="secondary" onClick={() => void testCommand()} disabled={busy}>
            Test
          </button>
        </div>
        {testResult !== undefined && (
          <pre>{JSON.stringify(testResult, null, 2)}</pre>
        )}
      </section>

      {draft && (
        <div className="scrim" role="presentation">
          <section className="editor" role="dialog" aria-modal="true">
            <div className="editor-header">
              <div>
                <p className="eyebrow">{draft.id ? "EDIT RULE" : "NEW RULE"}</p>
                <h2>{draft.id ? "Update command rule" : "Add command rule"}</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close editor"
                onClick={() => {
                  setDraft(undefined);
                  setDeletePending(false);
                }}
              >
                ×
              </button>
            </div>

            <label>
              Rule file
              <input
                value={draft.file}
                disabled={Boolean(draft.id)}
                onChange={(event) =>
                  setDraft({ ...draft, file: event.target.value })
                }
              />
            </label>

            <label>
              Command prefix pattern
              <textarea
                className="code-input"
                rows={3}
                spellCheck={false}
                value={draft.patternText}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    patternText: event.target.value,
                    acknowledgeBroad: false,
                  })
                }
              />
              <small>
                JSON array; use a nested array for alternatives, such as
                ["npm", "run", ["test", "ci"]].
              </small>
            </label>

            <label>
              Decision
              <select
                value={draft.decision}
                onChange={(event) =>
                  setDraft({ ...draft, decision: event.target.value as Decision })
                }
              >
                <option value="allow">Allow without prompting</option>
                <option value="prompt">Always prompt</option>
                <option value="forbidden">Always block</option>
              </select>
            </label>

            <label>
              Explanation
              <textarea
                rows={2}
                value={draft.justification}
                onChange={(event) =>
                  setDraft({ ...draft, justification: event.target.value })
                }
                placeholder="Why this prefix is appropriate"
              />
            </label>

            <div className="two-column">
              <label>
                Match examples
                <textarea
                  rows={3}
                  value={draft.matchText}
                  onChange={(event) =>
                    setDraft({ ...draft, matchText: event.target.value })
                  }
                  placeholder="One command per line"
                />
              </label>
              <label>
                Non-match examples
                <textarea
                  rows={3}
                  value={draft.notMatchText}
                  onChange={(event) =>
                    setDraft({ ...draft, notMatchText: event.target.value })
                  }
                  placeholder="One command per line"
                />
              </label>
            </div>

            {warnings.length > 0 && (
              <div className="risk-box">
                <strong>Broad permission warning</strong>
                <ul>
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={draft.acknowledgeBroad}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        acknowledgeBroad: event.target.checked,
                      })
                    }
                  />
                  I understand and want this broad prefix.
                </label>
              </div>
            )}

            <div className="editor-actions">
              {draft.id && !deletePending && (
                <button className="danger-ghost" onClick={() => setDeletePending(true)}>
                  Delete
                </button>
              )}
              {deletePending ? (
                <div className="delete-confirm">
                  <span>Delete this rule?</span>
                  <button className="danger" onClick={() => void remove()} disabled={busy}>
                    Confirm delete
                  </button>
                  <button className="secondary" onClick={() => setDeletePending(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="spacer" />
                  <button className="secondary" onClick={() => setDraft(undefined)}>
                    Cancel
                  </button>
                  <button
                    className="primary"
                    onClick={() => void save()}
                    disabled={
                      busy ||
                      !parsedDraftPattern ||
                      (warnings.length > 0 && !draft.acknowledgeBroad)
                    }
                  >
                    Validate and save
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
