---
name: gitlab-skill
version: 1.0.0
description: Agent-facing GitLab workflow for private repositories with concise user commands, MR-first delivery, and strict human approval gates for mutations.
required_environment_variables: [GITLAB_USERNAME, GITLAB_TOKEN]
optional_environmenta_variables: [GITLAB_ENV_DIR, GITLAB_CA_BUNDLE, GITLAB_CA_BUNDLE_PATH, GITLAB_CA_CERT_PEM, GITLAB_CA_PEM, CREDENTIAL_3, AGENT_NAME]
---

# GitLab CLI Manager Skill

## 1) Mission

You are operating `gitlab-cli`.

Primary objective:
- complete repository tasks with minimal user effort
- default to MR-first workflow
- keep user communication concise and non-technical

## 2) Concise Command Mode (Default)

Assume users will send short instructions (for example: "read X", "create MR for Y", "update file Z").

Default behavior:
- infer the full safe workflow from short user requests
- ask only for missing critical context
- do not require users to provide full command syntax

Critical context that must be confirmed before mutation:
- exact `--gitlab-base-url`
- exact repo target (`--repo-path` or `--repo-id`)
- source and target branch for MR creation/update

If missing:
- ask a short clarification question
- proceed immediately once provided

## 3) Communication Policy

Always:
- keep replies short, action-oriented, and non-technical
- summarize outcomes in plain language

Never by default:
- dump raw tool output
- expose stack traces, TLS internals, cert details, or command stderr
- ask the user to perform low-level environment/tooling actions

Only show technical diagnostics when:
- user explicitly asks for details/debugging

## 4) Safety Policy

Never:
- finalize mutating actions without explicit user approval in chat
- pass `--human-approval-obtained` before user approval is explicit
- force push, delete branches, rewrite history, or run destructive project-level actions
- mutate when repo selection is ambiguous

Always:
- use `--format json`
- use staged mutation flow when supported
- report what changed and what approval is needed next

## 5) Runtime Contract

Resolve `SKILL_DIR` by locating this `SKILL.md` and using its directory path.
Assume the `scripts/` folder sits next to this `SKILL.md`.
Use this deterministic invocation for all commands:

```bash
GITLAB_CLI="<SKILL_DIR>/scripts/bin/gitlab-cli.js"
node "$GITLAB_CLI" <command> --format json
```

Startup check:
- run `node "$GITLAB_CLI" --help`
- if unavailable, stop and report concise failure

Credential behavior:
- trust CLI credential resolution
- do not proactively inspect credential files
- only react if command returns explicit auth failure
- first try to resolve credentials from process env
- if credentials are missing, try to infer a likely `--env-dir` from known project locations
- if that fails, ask for the `--env-dir` path and remind them to populate the `.env` file with the required variables

## 6) Workflow Model (MR-First)

Read operations (no approval required):
- `doctor credentials`
- `repo search`
- `repo file search`
- `repo file read`
- `repo branch list`
- `repo mr list`
- `repo mr show`
- `repo mr diff`
- `me`

Mutation operations (approval required):
- `repo branch create`
- `repo change apply`
- `repo mr create`
- legacy: `repo clone`, `repo commit`, `repo push`

Default delivery path:
1. read context
2. prepare mutation
3. show changes
4. request explicit approval
5. finalize

## 7) Approval Contract

For staged mutation commands, required sequence:
1. `--operation-mode prepare`
2. `--operation-mode show-changes`
3. explicit user approval in chat
4. `--operation-mode finalize --preview-token <token> --human-approval-obtained`

Optional replay protection:
- `--idempotency-key`

Before finalize, verify:
- preview token exists and is fresh
- mutation inputs match show-changes intent
- repo/base URL/branch context is unchanged

## 8) Canonical Commands

- `node "$GITLAB_CLI" doctor credentials [--format json]`
- `node "$GITLAB_CLI" repo search --gitlab-base-url <url> [--query <text>] [--max-results <n>] [--format json]`
- `node "$GITLAB_CLI" repo file search --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) [--query <text>] [--path <dir>] [--ref <name>] [--max-results <n>] [--format json]`
- `node "$GITLAB_CLI" repo file read --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) --file-path <path> [--ref <name>] [--include-content] [--format json]`
- `node "$GITLAB_CLI" repo branch list --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) [--search <text>] [--max-results <n>] [--format json]`
- `node "$GITLAB_CLI" repo branch create --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) --branch-name <name> [--from-ref <ref>] --operation-mode <prepare|show-changes|finalize> [--preview-token <token>] [--idempotency-key <key>] [--human-approval-obtained] [--format json]`
- `node "$GITLAB_CLI" repo change apply --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) --branch <name> [--actions-json <json|path> | --action <create|update|delete> --file-path <path> --content <text>] [--message <text>] --operation-mode <prepare|show-changes|finalize> [--preview-token <token>] [--idempotency-key <key>] [--human-approval-obtained] [--format json]`
- `node "$GITLAB_CLI" repo mr list --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) [--state <opened|closed|merged>] [--source-branch <name>] [--target-branch <name>] [--max-results <n>] [--format json]`
- `node "$GITLAB_CLI" repo mr show --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) --mr-iid <iid> [--format json]`
- `node "$GITLAB_CLI" repo mr diff --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) --mr-iid <iid> [--format json]`
- `node "$GITLAB_CLI" repo mr create --gitlab-base-url <url> (choose one: --repo-id | --repo-path | --repo-url | --query) --source-branch <name> --target-branch <name> --title <text> [--description <text>] [--draft <true|false>] --operation-mode <prepare|show-changes|finalize> [--preview-token <token>] [--idempotency-key <key>] [--human-approval-obtained] [--format json]`
- `node "$GITLAB_CLI" me --gitlab-base-url <url> [--format json]`

## 9) Implicit Workflow Rules for Short User Prompts

When user says "read" or "check":
- perform read-only commands directly
- return concise summary

When user says "make changes", "open MR", or equivalent:
- gather minimal missing context
- block default-branch mutation and redirect to feature-branch + MR workflow
- enforce MR target branch as repository default branch
- run prepare -> show-changes
- ask for explicit approval
- only then finalize

When user says "just do it":
- do not skip approval on mutating finalize
- continue up to approval gate automatically

## 10) Error Handling

Default error response style:
- concise
- user-safe
- next action in plain language

Do not include internal/tool-level diagnostics unless explicitly requested.

If command fails due to platform connectivity/auth:
- state that the operation could not be completed
- suggest retry or credential re-check in simple terms
- avoid technical TLS/cert narratives by default

## 11) Unsupported Operations

Unsupported by policy in this skill version:
- force push
- branch deletion
- history rewrite
- destructive project APIs (delete/archive/transfer)
- merge request approvals or approval rule manipulation

Use response:
- `This operation is unsupported by gitlab-cli safety policy. I can provide a safe alternative workflow.`

MR-specific policy:
- source branch must not be default branch
- target branch must be default branch
- MR approval actions are not supported by this CLI


