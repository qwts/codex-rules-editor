import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  broadRuleWarnings,
  parseRules,
  renderRule,
  RulesManager,
} from "../src/server/rules.ts";

test("parses multiline rules, comments, alternatives, and examples", () => {
  const source = `# Read-only operations
prefix_rule(
    pattern = ["git", ["status", "diff"]],
    decision = "allow",
    justification = "Inspect the repository",
    match = [
        "git status --short",
    ],
    not_match = ["git push"],
)
`;
  const rules = parseRules(source, "default.rules");
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]?.pattern, ["git", ["status", "diff"]]);
  assert.equal(rules[0]?.decision, "allow");
  assert.equal(rules[0]?.justification, "Inspect the repository");
  assert.deepEqual(rules[0]?.match, ["git status --short"]);
  assert.deepEqual(rules[0]?.notMatch, ["git push"]);
  assert.equal(rules[0]?.line, 2);
});

test("renders a rule that parses back to the same definition", () => {
  const definition = {
    pattern: ["npm", "run", ["test", "ci"]],
    decision: "prompt" as const,
    justification: "Run project verification",
    match: ["npm run test -- unit"],
    notMatch: ["npm install"],
  };
  const rendered = renderRule(definition);
  const [parsed] = parseRules(`${rendered}\n`, "default.rules");
  assert.deepEqual(
    {
      pattern: parsed?.pattern,
      decision: parsed?.decision,
      justification: parsed?.justification,
      match: parsed?.match,
      notMatch: parsed?.notMatch,
    },
    definition,
  );
});

test("warns about broad shells and interpreters", () => {
  assert.ok(broadRuleWarnings(["/bin/zsh", "-lc"]).length > 0);
  assert.ok(broadRuleWarnings(["python3"]).length > 0);
  assert.deepEqual(broadRuleWarnings(["cargo", "test"]), []);
});

test("manager adds, updates, tests, backs up, and deletes rules atomically", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-rules-editor-"));
  try {
    const codexBinary = path.join(directory, "fake-codex");
    await writeFile(
      codexBinary,
      '#!/bin/sh\nprintf \'{"matchedRules":[],"decision":"allow"}\\n\'\n',
    );
    await chmod(codexBinary, 0o755);
    const manager = new RulesManager({
      codexHome: path.join(directory, "codex-home"),
      codexBinary,
    });

    const added = await manager.save({
      file: "default.rules",
      pattern: ["git", "status"],
      decision: "allow",
      justification: "Inspect status",
      match: [],
      notMatch: [],
    });
    assert.equal(added.snapshot.rules.length, 1);
    assert.equal(added.backupPath, undefined);
    assert.ok(added.savedRuleId);

    const updated = await manager.save({
      ruleId: added.savedRuleId,
      file: "ignored.rules",
      pattern: ["git", "status"],
      decision: "prompt",
      justification: "Confirm status",
      match: ["git status --short"],
      notMatch: [],
    });
    assert.equal(updated.snapshot.rules[0]?.decision, "prompt");
    assert.ok(updated.backupPath);
    assert.match(await readFile(updated.backupPath!, "utf8"), /Inspect status/);

    const policy = await manager.testCommand(["git", "status"]);
    assert.deepEqual(policy, { matchedRules: [], decision: "allow" });

    const deleted = await manager.delete(updated.savedRuleId!);
    assert.equal(deleted.snapshot.rules.length, 0);
    assert.ok(deleted.backupPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manager requires acknowledgement for a broad prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-rules-editor-"));
  try {
    const manager = new RulesManager({
      codexHome: path.join(directory, "codex-home"),
      codexBinary: "/usr/bin/true",
    });
    await assert.rejects(
      manager.save({
        pattern: ["python3"],
        decision: "allow",
        justification: "",
        match: [],
        notMatch: [],
      }),
      /acknowledgement required/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manager returns the id of the newly appended duplicate-shaped rule", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-rules-editor-"));
  try {
    const manager = new RulesManager({
      codexHome: path.join(directory, "codex-home"),
      codexBinary: "/usr/bin/true",
    });
    const first = await manager.save({
      pattern: ["git", "status"],
      decision: "allow",
      justification: "Inspect status",
      match: ["git status"],
      notMatch: [],
    });
    const second = await manager.save({
      pattern: ["git", "status"],
      decision: "allow",
      justification: "Inspect status",
      match: ["git status --short"],
      notMatch: ["git status --porcelain=v2"],
    });

    assert.notEqual(first.savedRuleId, second.savedRuleId);
    const saved = second.snapshot.rules.find(
      (rule) => rule.id === second.savedRuleId,
    );
    assert.deepEqual(saved?.match, ["git status --short"]);
    assert.deepEqual(saved?.notMatch, ["git status --porcelain=v2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
