# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per
[ENG-0006](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md).
Vendor-specific files (Copilot instructions, Cursor rules, and similar) are
thin adapters onto this file — they never restate what is here.

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the
[shared agent skills](https://github.com/qwts/playbook-engineering/blob/main/skills/README.md)
index. Reuse a shared skill when it fits; only a skill genuinely specific
to this repository belongs in its local context.
This repository is governed by
[playbook-engineering](https://github.com/qwts/playbook-engineering) — its
[shared SOPs](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

## What is specific to this repository

Seeded by the governance reconciler; extend this section with the repo's own
build, test, and review specifics as they take shape. Until then, the shared
conventions above are the whole contract.
