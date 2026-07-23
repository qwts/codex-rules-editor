import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RuleDecision = "allow" | "prompt" | "forbidden";
export type PatternToken = string | string[];

export interface RuleDefinition {
  pattern: PatternToken[];
  decision: RuleDecision;
  justification: string;
  match: string[];
  notMatch: string[];
}

export interface ParsedRule extends RuleDefinition {
  id: string;
  file: string;
  line: number;
  start: number;
  end: number;
}

export interface RuleSnapshot {
  codexHome: string;
  rulesDirectory: string;
  files: string[];
  rules: ParsedRule[];
  parseErrors: Array<{ file: string; message: string }>;
}

export interface SaveRuleInput extends RuleDefinition {
  file?: string;
  ruleId?: string;
  acknowledgeBroad?: boolean;
}

export interface MutationResult {
  snapshot: RuleSnapshot;
  backupPath?: string;
  savedRuleId?: string;
  warnings: string[];
}

interface CallSpan {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

const RULE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.rules$/;
const DECISIONS = new Set<RuleDecision>(["allow", "prompt", "forbidden"]);

class ValueParser {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parseArguments(): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    this.#skipSpace();
    while (!this.#done()) {
      const name = this.#parseIdentifier();
      this.#skipSpace();
      this.#expect("=");
      this.#skipSpace();
      output[name] = this.#parseValue();
      this.#skipSpace();
      if (this.#done()) break;
      this.#expect(",");
      this.#skipSpace();
    }
    return output;
  }

  #parseValue(): unknown {
    const char = this.#source[this.#index];
    if (char === `"` || char === `'`) return this.#parseString();
    if (char === "[") return this.#parseList();
    throw new Error(`Unsupported value at character ${this.#index + 1}.`);
  }

  #parseList(): unknown[] {
    this.#expect("[");
    this.#skipSpace();
    const values: unknown[] = [];
    while (this.#source[this.#index] !== "]") {
      if (this.#done()) throw new Error("Unterminated list.");
      values.push(this.#parseValue());
      this.#skipSpace();
      if (this.#source[this.#index] === "]") break;
      this.#expect(",");
      this.#skipSpace();
    }
    this.#expect("]");
    return values;
  }

  #parseString(): string {
    const quote = this.#source[this.#index];
    if (quote !== `"` && quote !== `'`) throw new Error("Expected string.");
    this.#index += 1;
    let result = "";
    while (!this.#done()) {
      const char = this.#source[this.#index++];
      if (char === quote) return result;
      if (char !== "\\") {
        result += char;
        continue;
      }
      if (this.#done()) throw new Error("Unterminated escape sequence.");
      const escaped = this.#source[this.#index++];
      const simple: Record<string, string> = {
        "\\": "\\",
        [`"`]: `"`,
        [`'`]: `'`,
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (escaped === "u") {
        const hex = this.#source.slice(this.#index, this.#index + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
          throw new Error("Invalid Unicode escape sequence.");
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.#index += 4;
      } else {
        result += simple[escaped ?? ""] ?? escaped;
      }
    }
    throw new Error("Unterminated string.");
  }

  #parseIdentifier(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(
      this.#source.slice(this.#index),
    );
    if (!match) throw new Error(`Expected field name at ${this.#index + 1}.`);
    this.#index += match[0].length;
    return match[0];
  }

  #skipSpace(): void {
    while (!this.#done()) {
      const char = this.#source[this.#index];
      if (char === "#") {
        while (!this.#done() && this.#source[this.#index] !== "\n") {
          this.#index += 1;
        }
        continue;
      }
      if (char !== undefined && /\s/.test(char)) {
        this.#index += 1;
        continue;
      }
      break;
    }
  }

  #expect(char: string): void {
    if (this.#source[this.#index] !== char) {
      throw new Error(`Expected "${char}" at character ${this.#index + 1}.`);
    }
    this.#index += 1;
  }

  #done(): boolean {
    return this.#index >= this.#source.length;
  }
}

function findCalls(source: string): CallSpan[] {
  const spans: CallSpan[] = [];
  let index = 0;
  let quote: string | undefined;
  let escaped = false;
  let comment = false;

  while (index < source.length) {
    const char = source[index];
    if (comment) {
      if (char === "\n") comment = false;
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (char === "#") {
      comment = true;
      index += 1;
      continue;
    }
    if (char === `"` || char === `'`) {
      quote = char;
      index += 1;
      continue;
    }

    if (
      source.startsWith("prefix_rule", index) &&
      !/[A-Za-z0-9_]/.test(source[index - 1] ?? "") &&
      !/[A-Za-z0-9_]/.test(source[index + "prefix_rule".length] ?? "")
    ) {
      let open = index + "prefix_rule".length;
      while (/\s/.test(source[open] ?? "")) open += 1;
      if (source[open] !== "(") {
        index += "prefix_rule".length;
        continue;
      }
      let cursor = open + 1;
      let depth = 1;
      let innerQuote: string | undefined;
      let innerEscaped = false;
      let innerComment = false;
      while (cursor < source.length && depth > 0) {
        const current = source[cursor];
        if (innerComment) {
          if (current === "\n") innerComment = false;
        } else if (innerQuote !== undefined) {
          if (innerEscaped) innerEscaped = false;
          else if (current === "\\") innerEscaped = true;
          else if (current === innerQuote) innerQuote = undefined;
        } else if (current === "#") {
          innerComment = true;
        } else if (current === `"` || current === `'`) {
          innerQuote = current;
        } else if (current === "(") {
          depth += 1;
        } else if (current === ")") {
          depth -= 1;
        }
        cursor += 1;
      }
      if (depth !== 0) throw new Error("Unterminated prefix_rule call.");
      spans.push({
        start: index,
        end: cursor,
        bodyStart: open + 1,
        bodyEnd: cursor - 1,
      });
      index = cursor;
      continue;
    }
    index += 1;
  }
  return spans;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${name} must be a list of strings.`);
  }
  return value;
}

function patternValue(value: unknown): PatternToken[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("pattern must be a non-empty list.");
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
      `pattern[${index}] must be a string or non-empty list of strings.`,
    );
  });
}

function definitionFromArguments(argumentsValue: Record<string, unknown>): RuleDefinition {
  const unknownFields = Object.keys(argumentsValue).filter(
    (key) =>
      !["pattern", "decision", "justification", "match", "not_match"].includes(
        key,
      ),
  );
  if (unknownFields.length > 0) {
    throw new Error(`Unsupported fields: ${unknownFields.join(", ")}.`);
  }
  const decisionValue = argumentsValue.decision ?? "allow";
  if (typeof decisionValue !== "string" || !DECISIONS.has(decisionValue as RuleDecision)) {
    throw new Error("decision must be allow, prompt, or forbidden.");
  }
  const justificationValue = argumentsValue.justification ?? "";
  if (typeof justificationValue !== "string") {
    throw new Error("justification must be a string.");
  }
  return {
    pattern: patternValue(argumentsValue.pattern),
    decision: decisionValue as RuleDecision,
    justification: justificationValue,
    match: stringArray(argumentsValue.match, "match"),
    notMatch: stringArray(argumentsValue.not_match, "not_match"),
  };
}

export function parseRules(source: string, file: string): ParsedRule[] {
  return findCalls(source).map((span) => {
    const body = source.slice(span.bodyStart, span.bodyEnd);
    const definition = definitionFromArguments(
      new ValueParser(body).parseArguments(),
    );
    const callSource = source.slice(span.start, span.end);
    return {
      ...definition,
      id: createHash("sha256")
        .update(`${file}\0${span.start}\0${callSource}`)
        .digest("hex")
        .slice(0, 16),
      file,
      line: source.slice(0, span.start).split("\n").length,
      start: span.start,
      end: span.end,
    };
  });
}

function renderString(value: string): string {
  return JSON.stringify(value);
}

function renderList(values: string[], indent = 4): string {
  if (values.length === 0) return "[]";
  const padding = " ".repeat(indent);
  return `[\n${values.map((value) => `${padding}${renderString(value)},`).join("\n")}\n]`;
}

export function renderRule(rule: RuleDefinition): string {
  const pattern = rule.pattern
    .map((token) =>
      Array.isArray(token)
        ? `[${token.map(renderString).join(", ")}]`
        : renderString(token),
    )
    .join(", ");
  const lines = [
    "prefix_rule(",
    `    pattern = [${pattern}],`,
    `    decision = ${renderString(rule.decision)},`,
  ];
  if (rule.justification.trim() !== "") {
    lines.push(`    justification = ${renderString(rule.justification.trim())},`);
  }
  if (rule.match.length > 0) {
    lines.push(`    match = ${renderList(rule.match, 8).replace(/\n/g, "\n    ")},`);
  }
  if (rule.notMatch.length > 0) {
    lines.push(
      `    not_match = ${renderList(rule.notMatch, 8).replace(/\n/g, "\n    ")},`,
    );
  }
  lines.push(")");
  return lines.join("\n");
}

export function broadRuleWarnings(pattern: PatternToken[]): string[] {
  const first = pattern[0];
  const firstValues: string[] =
    first === undefined ? [] : Array.isArray(first) ? first : [first];
  const warnings: string[] = [];
  if (pattern.length === 1) {
    warnings.push("This rule allows or blocks every invocation of the command.");
  }
  if (
    firstValues.some((value) =>
      ["bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"].includes(value),
    )
  ) {
    warnings.push("Shell entry-point rules can authorize hidden compound commands.");
  }
  if (
    firstValues.some((value) =>
      ["python", "python3", "node", "ruby", "perl", "osascript"].includes(value),
    ) &&
    pattern.length < 2
  ) {
    warnings.push("Interpreter-wide rules can execute arbitrary code.");
  }
  if (
    firstValues.some((value) => ["rm", "sudo", "dd", "mkfs"].includes(value))
  ) {
    warnings.push("This command commonly performs destructive or privileged actions.");
  }
  return [...new Set(warnings)];
}

function normalizedDefinition(input: RuleDefinition): RuleDefinition {
  return {
    pattern: patternValue(input.pattern),
    decision: input.decision,
    justification: input.justification.trim(),
    match: input.match.map((value) => value.trim()).filter(Boolean),
    notMatch: input.notMatch.map((value) => value.trim()).filter(Boolean),
  };
}

export class RulesManager {
  readonly codexHome: string;
  readonly rulesDirectory: string;
  readonly backupsDirectory: string;
  readonly codexBinary: string;

  constructor(options: { codexHome?: string; codexBinary?: string } = {}) {
    this.codexHome =
      options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    this.rulesDirectory = path.join(this.codexHome, "rules");
    this.backupsDirectory = path.join(this.codexHome, "rule-backups");
    this.codexBinary = options.codexBinary ?? process.env.CODEX_BIN ?? "codex";
  }

  async snapshot(): Promise<RuleSnapshot> {
    await mkdir(this.rulesDirectory, { recursive: true });
    const entries = await readdir(this.rulesDirectory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && RULE_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const rules: ParsedRule[] = [];
    const parseErrors: Array<{ file: string; message: string }> = [];
    for (const file of files) {
      try {
        const source = await readFile(path.join(this.rulesDirectory, file), "utf8");
        rules.push(...parseRules(source, file));
      } catch (error) {
        parseErrors.push({
          file,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      codexHome: this.codexHome,
      rulesDirectory: this.rulesDirectory,
      files,
      rules,
      parseErrors,
    };
  }

  async save(input: SaveRuleInput): Promise<MutationResult> {
    const definition = normalizedDefinition(input);
    const warnings = broadRuleWarnings(definition.pattern);
    if (warnings.length > 0 && input.acknowledgeBroad !== true) {
      throw new Error(
        `Broad rule acknowledgement required:\n- ${warnings.join("\n- ")}`,
      );
    }
    const snapshot = await this.snapshot();
    let file = this.#safeFileName(input.file ?? "default.rules");
    let existing: ParsedRule | undefined;
    if (input.ruleId !== undefined) {
      existing = snapshot.rules.find((rule) => rule.id === input.ruleId);
      if (existing === undefined) {
        throw new Error("The selected rule changed or no longer exists. Refresh and retry.");
      }
      file = existing.file;
    }
    const filePath = path.join(this.rulesDirectory, file);
    let original = "";
    try {
      original = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rendered = renderRule(definition);
    let candidate: string;
    let savedRuleStart: number;
    if (existing === undefined) {
      const prefix =
        original.trimEnd() === "" ? "" : `${original.trimEnd()}\n\n`;
      savedRuleStart = prefix.length;
      candidate = `${prefix}${rendered}\n`;
    } else {
      savedRuleStart = existing.start;
      candidate = `${original.slice(0, existing.start)}${rendered}${original.slice(existing.end)}`;
    }
    await this.#validateCandidate(candidate);
    const backupPath = await this.#atomicReplace(filePath, original, candidate);
    const updated = await this.snapshot();
    const savedRule = updated.rules.find(
      (rule) => rule.file === file && rule.start === savedRuleStart,
    );
    return {
      snapshot: updated,
      ...(backupPath === undefined ? {} : { backupPath }),
      ...(savedRule === undefined ? {} : { savedRuleId: savedRule.id }),
      warnings,
    };
  }

  async delete(ruleId: string): Promise<MutationResult> {
    const snapshot = await this.snapshot();
    const existing = snapshot.rules.find((rule) => rule.id === ruleId);
    if (existing === undefined) {
      throw new Error("The selected rule changed or no longer exists. Refresh and retry.");
    }
    const filePath = path.join(this.rulesDirectory, existing.file);
    const original = await readFile(filePath, "utf8");
    let start = existing.start;
    let end = existing.end;
    while (end < original.length && (original[end] === "\n" || original[end] === "\r")) {
      end += 1;
      if (original.slice(existing.end, end).includes("\n\n")) break;
    }
    if (start > 0 && original[start - 1] === "\n" && original.slice(start, end).endsWith("\n\n")) {
      start -= 1;
    }
    const candidate = `${original.slice(0, start)}${original.slice(end)}`;
    await this.#validateCandidate(candidate);
    const backupPath = await this.#atomicReplace(filePath, original, candidate);
    return {
      snapshot: await this.snapshot(),
      ...(backupPath === undefined ? {} : { backupPath }),
      warnings: [],
    };
  }

  async testCommand(argv: string[]): Promise<unknown> {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.length > 128 ||
      argv.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      throw new Error("argv must contain 1 to 128 non-empty strings.");
    }
    const snapshot = await this.snapshot();
    const args = ["execpolicy", "check", "--pretty"];
    for (const file of snapshot.files) {
      args.push("--rules", path.join(this.rulesDirectory, file));
    }
    args.push("--", ...argv);
    const { stdout } = await execFileAsync(this.codexBinary, args, {
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  #safeFileName(file: string): string {
    if (!RULE_FILE_RE.test(file) || path.basename(file) !== file) {
      throw new Error("Rule file must be a simple name ending in .rules.");
    }
    return file;
  }

  async #validateCandidate(candidate: string): Promise<void> {
    await mkdir(this.rulesDirectory, { recursive: true });
    const temporaryPath = path.join(
      this.rulesDirectory,
      `.codex-rules-editor-${randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, candidate, { encoding: "utf8", mode: 0o600 });
    try {
      await execFileAsync(
        this.codexBinary,
        [
          "execpolicy",
          "check",
          "--rules",
          temporaryPath,
          "--",
          "true",
        ],
        { maxBuffer: 1024 * 1024 },
      );
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`Codex rejected the rule file.${stderr ? `\n${stderr}` : ""}`);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #atomicReplace(
    filePath: string,
    original: string,
    candidate: string,
  ): Promise<string | undefined> {
    let current = "";
    try {
      current = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== original) {
      throw new Error("The rule file changed during editing. Refresh and retry.");
    }

    let backupPath: string | undefined;
    if (original !== "") {
      await mkdir(this.backupsDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(
        this.backupsDirectory,
        `${path.basename(filePath)}.${timestamp}.bak`,
      );
      await copyFile(filePath, backupPath);
    }

    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, candidate, { encoding: "utf8", mode: 0o600 });
    try {
      const existingStat = await stat(filePath).catch(() => undefined);
      if (existingStat !== undefined) {
        await writeFile(temporaryPath, candidate, {
          encoding: "utf8",
          mode: existingStat.mode,
        });
      }
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return backupPath;
  }
}
