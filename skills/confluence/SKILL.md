---
name: confluence-skill
version: 1.0.0
description: Deterministic Confluence operations using mindlayer-confluence-cli only, with strict human approval gates for all mutations
required_environment_variables: [CONFLUENCE_CLOUD_ID, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, CONFLUENCE_PIPE_DIR]
optional_environmenta_variables: [CONFLUENCE_ENV_DIR, AGENT_NAME]
---

# Confluence Manager Skill

This skill is the only allowed path for Confluence work in this environment.
Use `mindlayer-confluence-cli` commands only. Do not build direct API requests.

## 1) Non-Negotiable Safety Rules

Never:
- read or print credential values.
- call Confluence with raw `curl` or custom HTTP scripts.
- skip `prepare -> show-changes -> approval -> finalize` for mutating workflows.
- pass `--human-approval-obtained` without explicit user approval in this chat.

Always:
- use `mindlayer-confluence-cli` only.
- prefer `--format json`.
- resolve exact targets before mutating.
- explicitly report unsupported features instead of approximating with unsafe workarounds.

## 2) Startup Protocol

Before handling Confluence requests:
1. Tell user you are validating config and approval gates.
2. Confirm you will not read or print credentials.
3. If credentials are missing, ask for an `--env-dir` path so the CLI can load `<env-dir>/.env`.
4. Verify Confluence routing trigger exists in `AGENT.md`; if missing, ask approval before editing.
5. Confirm `mindlayer-confluence-cli` is available by running `mindlayer-confluence-cli --help`.
6. If the CLI is not found or fails to run, ask the user to install it and stop. Do not install it yourself.

## 3) Invocation and Environment

Use the installed CLI directly for all commands:

```bash
mindlayer-confluence-cli <command> --format json
```

Notes:
- First try to resolve credentials from process env.
- If credentials are missing, try to infer a likely `--env-dir` from known project locations.
- If that fails, ask the user for the `--env-dir` path and remind them to populate the `.env` file with the required variables.
- Do not pass `--pipe-dir` by default. Use `--pipe-dir` only when automatic pipe resolution fails.

## 4) Approval Contract

Mutating commands:
- `page create`
- `page edit content`
- `page edit details`

Required sequence:
1. `prepare`
2. edit/plan content
3. `show-changes` (create/content workflows)
4. explicit user approval
5. `finalize --human-approval-obtained`

Required flags:
- `page create --operation-mode show-changes` requires `--pipe-changed`.
- `page edit content --operation-mode show-changes` requires `--pipe-changed`.
- all mutating finalize calls require `--human-approval-obtained`.

Legacy alias note:
- `--pipe-file-written-to` may still be accepted for backward compatibility in content show-changes, but agents should use `--pipe-changed`.

## 5) Command Surface (Canonical)

Top-level commands:
- `space search`
- `page search`
- `page create`
- `page edit content`
- `page edit details`
- `me`

Global flags:
- `--format json|text`
- `--env-dir <path>`

### 5.1 `page search` flags and pagination

Selectors (choose one primary selector):
- `--page-id`
- `--query`
- `--title`
- `--cql`

Search scope note:
- `--space-key` is optional narrowing, not mandatory. Query/title/CQL can search broadly when no space is provided.

Structured filters:
- `--space-key` (strongly recommended to narrow results; required with `--ancestor-path`)
- `--label` (repeatable, AND semantics)
- `--ancestor-id` or `--ancestor-path` (use one)
- `--created-from`, `--created-to`
- `--updated-from`, `--updated-to`

Enrichment flags:
- `--with-content` with optional `--body-format` (`storage|atlas_doc_format|view`)
- `--with-labels [limit,start]`
- `--with-version-history [limit,start]` (currently returns `history.lastUpdated` summary)
- `--with-ancestors [limit,start]`
- `--with-children [limit,start]`
- `--with-attachments [limit,start]`
- `--with-comments [limit,start]`
- `--with-restrictions`

Pagination rules:
- top-level page result pagination uses `--limit` and `--start`.
- subresource pagination uses tuple syntax `[limit,start]` on each `--with-*` flag.

Rule:
- `--cql` is a full override of structured filter composition.
- raw CQL is supported and passed through via `--cql`.

Result-shape behavior:
- if search returns exactly one page and it has an id, command auto-augments that page with requested `--with-*` details.
- if search returns multiple pages, detail flags are ignored and command asks to narrow with `--page-id`.
- if `--page-id` is provided, detail flags are applied directly to that exact page.
- `--with-version-history` currently maps to `lastUpdated` metadata (not a full historical version list payload).

### 5.2 `page create` template presets

Built-in template preset selector flags:
- `--incident-report`
- `--meeting-notes`
- `--gap-analysis`
- `--risk-register`
- `--impact-analysis`
- `--change-request-form`
- `--release-notes`

Preset behavior:
- These flags select deterministic template source + optional preset destination.
- Prepare preloads `.confluence-pipe` with template content from deterministic preset source.
- Destination resolution is deterministic with this precedence:
  1. template flag + `--space-key`/`--space-name` + `--page-location`: create at provided location.
  2. template flag + `--space-key`/`--space-name` only: create at provided space root.
  3. template flag only: create at preset destination if configured.
  4. if no preset destination exists: fallback to current user's personal space root.

Incident report default destination:
- Space key: `ECBP`
- Path segments:
  - `03. Operations & BAU`
  - `Incident & Problem Log`
  - `6 - Incident Management / Troubleshooting`

Preset destination override note:
- Incident report destination is a default, not hardcoded-only behavior.
- You can override by passing `--space-key`/`--space-name`, and optionally `--page-location`.

Preset registry:
- `src/locationPresets.json`

### 5.3 `page edit content` patch behavior

Default mode is patch-first:
- CLI auto-detects changed heading sections.
- Untouched sections preserve original ADF subtree.
- unchanged markdown preserves original ADF.
- if safe heading mapping cannot be inferred for changed content, CLI falls back to full rewrite with warning metadata.

Explicit scoped patch flags:
- `--patch-scope heading|section`
- `--target-heading` (repeatable)
- `--patch-mode replace|append|prepend`

Override flag:
- `--full-rewrite` to force whole-document rewrite.

Mutual exclusion:
- do not combine `--full-rewrite` with scoped patch flags.

### 5.4 `page edit details`

Supported detail updates:
- `--new-title` (title-only rename)
- `--comment`
- `--label`
- `--attachment-path`

Two-turn workflow:
- `prepare`
- `finalize --human-approval-obtained`

### 5.5 Implicit workflows embedded in commands

Use these built-in capabilities first before adding extra discovery steps:
- `page edit content` supports lookup without `--page-id` via `--page-title` / `--query` / `--cql` + optional space narrowing.
- `page edit content --operation-mode resolve` returns exact page resolution or ambiguity candidates.
- `page edit content` and `page create` auto-promote `prepare -> show-changes` when `--pipe-changed` is present.
- `page create` supports `--space-name` resolution (exact/unique match logic in-command).
- `page create --page-location` resolves hierarchy path in-command (no manual parent lookup needed).
- `page create` template flags preload pipe content and can resolve destination automatically from preset/fallback rules.
- `page search --page-id` can be used as a single-command detail fetch with `--with-*` flags.
- `me` provides user-centric discovery (`--recent-edits`, `--drafts`, `--saved`) with `--limit/--start`.
- `space search` auto-augments details when exact `--space-key` is used, or when query yields a single match.
- `space search` ignores detail flags on multiple query matches and asks to narrow with `--space-key`.

Resolve ambiguity rule:
- `resolve` does not auto-select from multiple matches; it returns candidates and requires explicit rerun with exact `--page-id`.

### 5.6 Detail pagination semantics

Use two pagination layers correctly:
- top-level search lists use `--limit` + `--start`.
- detail expansions use `[limit,start]` tuple syntax on specific `--with-*` flags.

Important behavior:
- Confluence expand endpoints do not honor tuple pagination server-side for many detail expansions.
- CLI fetches expanded arrays and applies tuple pagination client-side.

Examples:
- `page search --page-id 123 --with-comments [10,20]`
- `space search --space-key CH1 --with-permissions [10,0]`

### 5.7 Command-specific constraints that agents must remember

- `page edit details` requires exact `--page-id`; it does not support implicit resolve by title/query.
- `page edit details` operations are additive/update by field type (add comment/labels/attachments, rename title), not a blanket overwrite command.
- `--label` in details is add-only; remove/replace label semantics are not implemented.
- `page edit content` resolve-by-query/title requires either explicit `--space-key/--space-name` narrowing or raw `--cql`.
- `page search --ancestor-path` requires `--space-key` and path must start with `./`.
- `space search` requires one of `--space-key` or `--query`.
- `page create` requires `--title` and destination context: explicit space (`--space-key|--space-name`) or a template preset flag.

### 5.8 Interpretation guardrails (do not infer beyond this)

- `page search` can run without `--space-key`; this is broad search, not an error.
- `--cql` is a direct query override; do not combine it mentally with structured filter composition.
- `resolve` mode returns one of: no-match, ambiguous candidates, or a single resolved page; it never auto-selects from ambiguous results.
- Incident preset destination is defaulted, not fixed. Explicit `--space-key/--space-name` (and optional `--page-location`) override preset destination.
- `--with-version-history` currently returns `lastUpdated` metadata only, not a full version list payload.
- Content edit updates page body (patch-first or full rewrite). Details edit updates selected fields only.
- Labels are add-only in details flow; remove/replace is unsupported.
- Legacy `--pipe-file-written-to` may parse, but canonical show-changes signal is `--pipe-changed`.

Explicit non-goals (unsupported by this CLI):
- delete page/comment/attachment
- move existing page between parents/spaces
- remove/replace labels
- bulk multi-page mutations
- permission-management workflows

## 6) Deterministic Workflows

Execution guidance for one-shot success:
- If target is ambiguous, run discovery first (`space search` / `page search`) and then continue with exact IDs/space keys.
- For all mutating flows, enforce stage order and required stage flags exactly.
- Before finalize, always provide natural-language summary of intended changes and obtain explicit approval.
- If user asks for unsupported behavior, say it is not implemented and offer the closest supported flow.

### 6.1 Read/discovery

```bash
mindlayer-confluence-cli space search --query "Engineering" --limit 20 --start 0 --format json
mindlayer-confluence-cli page search --title "Release Plan" --space-key ENG --limit 20 --start 0 --format json
mindlayer-confluence-cli page search --page-id 12345 --with-content --body-format atlas_doc_format --format json
mindlayer-confluence-cli page search --space-key ENG --label "release" --label "approved" --updated-from "2026-01-01" --updated-to "2026-12-31" --format json
mindlayer-confluence-cli page search --page-id 12345 --with-comments [10,0] --with-attachments [10,0] --with-children [10,0] --format json
mindlayer-confluence-cli space search --space-key ENG --with-description --with-homepage --with-permissions [10,0] --with-labels [10,0] --format json
```

### 6.1b Profile discovery (`me`)

```bash
mindlayer-confluence-cli me --recent-edits --drafts --saved --limit 10 --start 0 --format json
```

### 6.2 Create page (non-template)

```bash
mindlayer-confluence-cli page create --space-key CH1 --title "Q2 Plan" --page-location "./Programs/Planning/" --operation-mode prepare --format json
# edit .confluence-pipe
mindlayer-confluence-cli page create --space-key CH1 --title "Q2 Plan" --page-location "./Programs/Planning/" --operation-mode show-changes --pipe-changed --format json
mindlayer-confluence-cli page create --space-key CH1 --title "Q2 Plan" --page-location "./Programs/Planning/" --operation-mode finalize --human-approval-obtained --format json
```

### 6.3 Create page (template preset)

```bash
mindlayer-confluence-cli page create --incident-report --title "INC-2026-0042" --operation-mode prepare --format json
# pipe preloaded from template
mindlayer-confluence-cli page create --incident-report --title "INC-2026-0042" --operation-mode show-changes --pipe-changed --format json
mindlayer-confluence-cli page create --incident-report --title "INC-2026-0042" --operation-mode finalize --human-approval-obtained --format json
```

Preset with destination override examples:

```bash
mindlayer-confluence-cli page create --meeting-notes --space-key CH1 --title "Meeting Notes 2026-04-09" --operation-mode prepare --format json
mindlayer-confluence-cli page create --meeting-notes --space-key CH1 --page-location "./Ops/Meetings/" --title "Meeting Notes 2026-04-09" --operation-mode prepare --format json
```

### 6.4 Edit content (default patch-first)

```bash
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode prepare --format json
# edit only intended sections
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode show-changes --pipe-changed --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode finalize --human-approval-obtained --format json
```

### 6.4b Edit content (resolve then mutate without upfront page-id)

```bash
mindlayer-confluence-cli page edit content --query "Release Plan" --space-key CH1 --operation-mode resolve --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode prepare --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode show-changes --pipe-changed --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode finalize --human-approval-obtained --format json
```

### 6.5 Edit content (direct heading patch)

```bash
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode prepare --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode show-changes --pipe-changed --patch-scope heading --target-heading "Target Section" --patch-mode replace --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode finalize --human-approval-obtained --patch-scope heading --target-heading "Target Section" --patch-mode replace --format json
```

### 6.6 Edit content (full rewrite override)

```bash
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode prepare --format json
# edit .confluence-pipe
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode show-changes --pipe-changed --full-rewrite --format json
mindlayer-confluence-cli page edit content --page-id 12345 --operation-mode finalize --human-approval-obtained --full-rewrite --format json
```

### 6.7 Edit details

```bash
mindlayer-confluence-cli page edit details --page-id 12345 --new-title "Release Plan v2" --operation-mode prepare --format json
mindlayer-confluence-cli page edit details --page-id 12345 --new-title "Release Plan v2" --operation-mode finalize --human-approval-obtained --format json
```

```bash
mindlayer-confluence-cli page edit details --page-id 12345 --comment "Looks good" --label "release-approved" --operation-mode prepare --format json
mindlayer-confluence-cli page edit details --page-id 12345 --comment "Looks good" --label "release-approved" --operation-mode finalize --human-approval-obtained --format json
```

## 7) ADF Conversion Risk Guardrail

For `page edit content`, conversion can be ADF -> Markdown -> ADF.
If unsupported/risky node types are present, include explicit warning before approval.

Required warning meaning:
- this page contains content not explicitly supported for safe roundtrip and edits may break content.

Do not hide this risk.

## 8) Automatic Audit Stamp

On successful finalize for:
- `page create`
- `page edit content`
- `page edit details`

CLI posts a best-effort audit comment (change type + UTC time + actor email).
If audit-stamp creation fails but mutation succeeds, report mutation success and stamp failure separately.

## 9) Unsupported Feature Policy

If a feature is not implemented:
- clearly say it is not implemented by this CLI.
- offer supported alternatives only.
- do not attempt raw API fallback.

Fallback response pattern:
- `This is not currently supported by mindlayer-confluence-cli. I can do <supported option A> or <supported option B>.`

## 10) Error Handling Quick Rules

- Missing/ambiguous page or space: run discovery, present candidates, ask user to choose exact target.
- Missing approval: do not finalize.
- Pipe resolution failure: pass `--pipe-dir`.
- Credential lookup failure: pass `--env-dir`.
- Patch/full-rewrite conflict: remove either `--full-rewrite` or scoped patch flags.

## 11) Mutation Checklist

Before any finalize, ensure all are true:
- exact target resolved
- prepare completed
- show-changes reviewed (when required)
- user provided explicit approval
- finalize includes `--human-approval-obtained`
- post-finalize verification executed
