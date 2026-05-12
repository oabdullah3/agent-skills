---
name: openclaw-jira-cli
description: Deterministic Jira operations using openclaw-jira-cli with explicit human approval gates for all create/edit mutations.
---

# Jira CLI Manager Skill

This skill is the canonical operational policy for Jira work through jira-cli.
Use jira-cli only for supported operations.

## 1) Non-Negotiable Safety Rules

Never:
- run create/edit mutations with --human-approval-obtained on first execution.
- guess project IDs, issue type IDs, assignee IDs, transition IDs, field IDs, or issue keys.
- expose secrets (especially JIRA_API_TOKEN).
- use raw Jira REST calls when jira-cli supports the operation.
- perform delete operations through this workflow.

Always:
- use --format json for machine-readable automation output.
- resolve exact targets before mutation.
- show preview changeSummary and obtain explicit human approval before finalize execution.
- verify post-mutation state with read commands.

## 2) Startup Protocol

1. Resolve binary in this order i.e. $JIRA_CLI_BIN equals either of the three below:
- ~/node_modules/.bin/jira-cli (start all commands with this by default)
- ./node_modules/.bin/jira-cli 
- jira-cli
2. Run post-install verification:
- "$JIRA_CLI_BIN" --help
3. If jira-cli is missing and user approves installation, run private-registry install flow.
4. If verification fails, report exact error and stop for human direction.

## 3) Invocation and Environment

Preferred command form:

```bash
"$JIRA_CLI_BIN" <command> --format json
```

Deterministic invocation contract:
1. First attempt: run command with no credential flags.
2. If credential resolution fails: retry same command with --config-path "<path>".
3. If user explicitly requests env-file routing: run with --env-dir "<dir>".
4. Never inspect or print credential values from any source.
5. For retries, keep business flags identical; only add credential-routing flags.

Credential source precedence (runtime behavior):
1. --env-dir "<dir>" => reads <dir>/.env.
2. Otherwise, if process env has JIRA_CLOUD_ID, JIRA_EMAIL, JIRA_API_TOKEN => uses process env.
3. Otherwise => uses OpenClaw config (default ~/.openclaw/openclaw.json, or --config-path override).

Credential error recovery playbook:
1. If error mentions missing JIRA_CLOUD_ID/JIRA_EMAIL/JIRA_API_TOKEN:
- rerun with --config-path when a known config location exists.
- if user asked for env-dir flow, ensure <dir>/.env exists and rerun with --env-dir.
2. If error mentions missing skill entry:
- rerun with correct --config-path and confirm the requested skill entry name.
3. If auth fails (401/403):
- stop and report that credentials/permissions are invalid; do not keep retrying mutations.

Canonical invocation templates:

```bash
"$JIRA_CLI_BIN" issue search --jql "project = ABC ORDER BY updated DESC" --format json
"$JIRA_CLI_BIN" issue search --jql "project = ABC ORDER BY updated DESC" --config-path "$HOME/.openclaw/openclaw.json" --format json
"$JIRA_CLI_BIN" issue search --jql "project = ABC ORDER BY updated DESC" --env-dir "." --format json
```

## 4) Approval Contract

Mutation commands:
- issue create
- issue edit add
- issue edit replace

Required sequence:
1. Run `--operation-mode prepare`.
2. Run `--operation-mode show-changes` and present diff/warnings.
3. Ask: Do you approve these Jira updates?
4. Only after explicit approval, run `--operation-mode finalize` with `--preview-ref` and `--human-approval-obtained`.
5. Optionally pass `--idempotency-key` for replay protection.

Approval matrix:
- create: prepare -> show-changes -> finalize.
- edit add: prepare -> show-changes -> finalize.
- edit replace: prepare -> show-changes -> finalize (explicit overwrite warnings).
- `--dry-run` is removed for mutation commands.

## 5) Command Surface (Canonical)

Canonical command families:
- jira-cli doctor credentials [--format json]
- jira-cli project search --query <text> [--operation-mode <search|resolve>] [--with-components] [--max-results <n>] [--start-at <n>] [--explain] [--format json]
- jira-cli issue search --jql <query> [--operation-mode <search|resolve>] [--start-at <n>] [--max-results <n>] [--explain] [--format json]
- jira-cli issue search --issue-key <key> [--operation-mode <search|resolve>] [--with-comments [max,start]] [--with-transitions [max,start]] [--with-assignable [max,start]] [--with-worklogs [max,start]] [--with-attachments [max,start]] [--explain] [--format json]
- jira-cli issue create --summary <text> (choose exactly one: --project-id | --project-key | --project-query) (choose exactly one: --issue-type-id | --issue-type-name) [--incident-report|--bug-triage|--change-request|--release-blocker] [--operation-mode <prepare|show-changes|finalize|resolve>] [--preview-ref] [--idempotency-key] [--skip-permission-preflight] [--priority-id] [--component-ids] [--parent-key|--parent-id] [--environment-value] [--environment-field-id] [--story-points] [--story-points-field-id] [--original-estimate] [action flags] [--format json]
- jira-cli issue edit add --issue <key> [--operation-mode <prepare|show-changes|finalize|resolve>] [--preview-ref] [--idempotency-key] [--skip-permission-preflight] [--comment-body] [--worklog-time-spent] [--attach-file] [--labels] [--link-type/--link-issue] [--get-details] [--format json]
- jira-cli issue edit replace --issue <key> [--operation-mode <prepare|show-changes|finalize|resolve>] [--preview-ref] [--idempotency-key] [--skip-permission-preflight] [--summary] [--description] [--start-date] [--due-date] [--priority-id] [--component-ids] [--parent-key|--parent-id] [--environment-value] [--environment-field-id] [--story-points] [--story-points-field-id] [--original-estimate] [--acceptance-value] [--patch-mode <replace|append|prepend>] [--patch-field <description|acceptance|both|all>] [--transition-id] [--assignee-id] [--labels-add] [--labels-remove] [--get-details] [--format json]
- jira-cli me [--assigned] [--reported] [--watched] [--recent] [--start-at <n>] [--max-results <n>] [--with-comments [max,start]] [--with-transitions [max,start]] [--with-assignable [max,start]] [--with-worklogs [max,start]] [--with-attachments [max,start]] [--explain] [--format json]

Legacy route policy (non-canonical):
- Do not invoke these legacy route families: issue-comment-add, issue-worklog-add, issue-details, issue-dates, issue-acceptance, issue-type-list, or issue-edit-without-mode.
- These routes are intentionally rejected and replaced by canonical flows.
- Use deterministic replacements:
	- issue-comment-add -> issue edit add --comment-body
	- issue-worklog-add -> issue edit add --worklog-time-spent
	- issue-details -> issue search --issue-key
	- issue-dates or issue-acceptance -> issue edit replace
	- issue-type-list -> project search and inspect issueTypes

Critical flags that must stay in docs/help alignment:
--human-approval-obtained, --project-id, --project-key, --project-query, --issue-type-id, --issue-type-name, --issue-key, --jql, --start-at, --max-results, --with-comments, --with-transitions, --with-assignable, --with-worklogs, --with-attachments, --comment-body, --worklog-time-spent, --attach-file, --labels, --labels-add, --labels-remove, --transition-id, --assignee-id, --priority-id, --component-ids, --parent-key, --parent-id, --environment-value, --environment-field-id, --story-points, --story-points-field-id, --original-estimate, --operation-mode, --preview-ref, --idempotency-key, --skip-permission-preflight, --incident-report, --bug-triage, --change-request, --release-blocker, --patch-mode, --patch-field, --env-dir, --config-path, --format, --explain.

Permission preflight contract:
- Finalize runs permission preflight by default and blocks on missing capability categories.
- Treat preflight failures as blocking and actionable; do not continue finalize automatically.
- Only use `--skip-permission-preflight` when the human explicitly approves override.
- show-changes returns `preflightIntent` summary for required capability checks.

Pagination contract:
- Top-level reads use `--start-at` and `--max-results`.
- Nested enrichments use tuple syntax `[max,start]` or `max,start`.
- Tuple flags accepted on `issue search --issue-key` and `me`:
	- `--with-comments`, `--with-transitions`, `--with-assignable`, `--with-worklogs`, `--with-attachments`
- JSON responses include `pagination` metadata; nested enrichments include `enrichmentPagination` with deterministic `strategy` (`server` or `client`).

Unified date contract:
- `--start-date` resolves via `editmeta` field-name mapping (`Start date`) at runtime.
- `--due-date` maps to Jira standard `duedate` field.
- Do not assume or hardcode `customfield_*` IDs for start-date updates.
- Date validation is deterministic (`YYYY-MM-DD`) across create and edit flows.

Read explain mode:
- Use `--explain` on read commands (`project search`, `issue search`, `me`) when agent needs deterministic query/enrichment transparency.
- Explain output includes `selectors`, `queryPlan`, `fieldsRequested`, `enrichmentPlan`, `paginationPlan`, and `fallbackBehavior`.
- Explain must never include credential material.

Resolve/ambiguity contract:
- Use `--operation-mode resolve` when selector ambiguity diagnostics are needed before staged mutation.
- Resolve payloads return a deterministic `resolution` envelope:
	- status: `no-match | ambiguous | resolved`
	- selector: normalized selector input
	- candidates: ambiguity list when multiple matches exist
	- selected: exact target when resolved
	- instruction: deterministic next command guidance
- Never auto-select from ambiguous resolution results.

Credential diagnostics workflow:
- Use `jira-cli doctor credentials --format json` for non-mutating credential troubleshooting.
- Do not print or infer raw token/email/cloud-id values from any source.
- Use returned selectedSource, attempts, and missingKeys to decide the next remediation step.

## 6) Deterministic Workflows

Project discovery:

```bash
"$JIRA_CLI_BIN" project search --query "<project text>" --with-components --max-results 20 --explain --format json
```

Issue discovery:

```bash
"$JIRA_CLI_BIN" issue search --jql "project = ABC AND statusCategory != Done" --start-at 0 --max-results 20 --explain --format json
"$JIRA_CLI_BIN" issue search --issue-key ABC-123 --with-comments [20,0] --with-transitions [20,0] --with-assignable [20,0] --with-worklogs [20,0] --with-attachments [20,0] --explain --format json
```

Profile discovery with pagination parity:

```bash
"$JIRA_CLI_BIN" me --assigned --recent --start-at 0 --max-results 10 --with-comments [5,0] --with-worklogs [5,0] --explain --format json
```

Create preview and execute (multi-action example):

```bash
"$JIRA_CLI_BIN" issue create --operation-mode prepare --summary "Investigate login regression" --project-id 10024 --issue-type-name "Task" --comment-body "triage started" --labels "urgent,openclaw" --worklog-time-spent "15m" --format json
"$JIRA_CLI_BIN" issue create --operation-mode show-changes --summary "Investigate login regression" --project-id 10024 --issue-type-name "Task" --comment-body "triage started" --labels "urgent,openclaw" --worklog-time-spent "15m" --format json
"$JIRA_CLI_BIN" issue create --operation-mode finalize --preview-ref "<ref>" --idempotency-key "create-<key>" --summary "Investigate login regression" --project-id 10024 --issue-type-name "Task" --comment-body "triage started" --labels "urgent,openclaw" --worklog-time-spent "15m" --format json --human-approval-obtained
```

Edit add preview and execute:

```bash
"$JIRA_CLI_BIN" issue edit add --operation-mode show-changes --issue ABC-123 --comment-body "Progress update" --labels "next-step" --format json
"$JIRA_CLI_BIN" issue edit add --operation-mode finalize --preview-ref "<ref>" --idempotency-key "add-<key>" --issue ABC-123 --comment-body "Progress update" --labels "next-step" --format json --human-approval-obtained
```

Edit replace preview and execute:

```bash
"$JIRA_CLI_BIN" issue edit replace --operation-mode show-changes --issue ABC-123 --summary "Clarified acceptance" --description "Full replacement text" --labels-add "validated" --labels-remove "stale" --format json
"$JIRA_CLI_BIN" issue edit replace --operation-mode finalize --preview-ref "<ref>" --idempotency-key "replace-<key>" --issue ABC-123 --summary "Clarified acceptance" --description "Full replacement text" --labels-add "validated" --labels-remove "stale" --format json --human-approval-obtained
```

Giant reference templates (all major flags, with mutually-exclusive groups shown inline):

```bash
# Giant issue search template (choose exactly one primary selector)
"$JIRA_CLI_BIN" issue search \
	--operation-mode search \
	--jql "project = ABC ORDER BY updated DESC" \
	# OR: --issue-key ABC-123 \
	--start-at 0 \
	--max-results 50 \
	--with-comments [20,0] \
	--with-transitions [20,0] \
	--with-assignable [20,0] \
	--with-worklogs [20,0] \
	--with-attachments [20,0] \
	--explain \
	--env-dir "." \
	# OR: --config-path "$HOME/.openclaw/openclaw.json" \
	--format json

# Giant project search template
"$JIRA_CLI_BIN" project search \
	--query "OpenClaw" \
	--operation-mode search \
	# OR: --operation-mode resolve \
	--with-components \
	--start-at 0 \
	--max-results 50 \
	--explain \
	--env-dir "." \
	# OR: --config-path "$HOME/.openclaw/openclaw.json" \
	--format json

# Giant issue create template (mutually-exclusive groups called out)
"$JIRA_CLI_BIN" issue create \
	--operation-mode show-changes \
	# OR: --operation-mode prepare | --operation-mode finalize | --operation-mode resolve \
	--summary "Investigate login regression" \
	--description "Comprehensive create payload" \
	--project-id 10024 \
	# OR: --project-key ABC \
	# OR: --project-query "OpenClaw" \
	--issue-type-name "Task" \
	# OR: --issue-type-id 10001 \
	--incident-report \
	# OR: --bug-triage | --change-request | --release-blocker \
	--preview-ref "<ref-from-show-changes-for-finalize-only>" \
	--idempotency-key "create-<key>" \
	--skip-permission-preflight \
	--comment-body "triage started" \
	--labels "urgent,openclaw" \
	--worklog-time-spent "15m" \
	--worklog-comment "triage worklog" \
	--worklog-started "2026-04-13T10:00:00.000+0000" \
	--start-date 2026-04-13 \
	--due-date 2026-04-20 \
	--priority-id 3 \
	--component-ids "10000,10001" \
	--parent-key ABC-1 \
	# OR: --parent-id 12345 \
	--environment-value "staging" \
	--environment-field-id customfield_12345 \
	--story-points 5 \
	--story-points-field-id customfield_10016 \
	--original-estimate "1h" \
	--acceptance-value "* AC 1\n* AC 2" \
	--assignee-id "<account-id>" \
	--link-type "Relates" \
	--link-issue ABC-123 \
	--attach-file ./tmp/create-proof.txt \
	--get-details \
	--human-approval-obtained \
	--env-dir "." \
	# OR: --config-path "$HOME/.openclaw/openclaw.json" \
	--format json

# Giant issue edit add template
"$JIRA_CLI_BIN" issue edit add \
	--operation-mode show-changes \
	# OR: --operation-mode prepare | --operation-mode finalize | --operation-mode resolve \
	--issue ABC-123 \
	--preview-ref "<ref-from-show-changes-for-finalize-only>" \
	--idempotency-key "add-<key>" \
	--skip-permission-preflight \
	--comment-body "Progress update" \
	--labels "next-step,triaged" \
	--worklog-time-spent "20m" \
	--worklog-comment "investigation" \
	--worklog-started "2026-04-13T11:00:00.000+0000" \
	--attach-file ./tmp/add-proof.txt \
	--link-type "Relates" \
	--link-issue ABC-456 \
	--get-details \
	--human-approval-obtained \
	--env-dir "." \
	# OR: --config-path "$HOME/.openclaw/openclaw.json" \
	--format json

# Giant issue edit replace template
"$JIRA_CLI_BIN" issue edit replace \
	--operation-mode show-changes \
	# OR: --operation-mode prepare | --operation-mode finalize | --operation-mode resolve \
	--issue ABC-123 \
	--preview-ref "<ref-from-show-changes-for-finalize-only>" \
	--idempotency-key "replace-<key>" \
	--skip-permission-preflight \
	--summary "Clarified acceptance" \
	--description "Full replacement text" \
	--patch-mode append \
	# OR: --patch-mode replace | --patch-mode prepend \
	--patch-field both \
	# OR: --patch-field description | --patch-field acceptance | --patch-field all \
	--labels-add "validated,priority" \
	--labels-remove "stale" \
	--start-date 2026-04-13 \
	--due-date 2026-04-25 \
	--priority-id 2 \
	--component-ids "10000,10001" \
	--parent-key ABC-1 \
	# OR: --parent-id 12345 \
	--environment-value "production" \
	--environment-field-id customfield_12345 \
	--story-points 8 \
	--story-points-field-id customfield_10016 \
	--original-estimate "2h" \
	--acceptance-value "* AC replace 1\n* AC replace 2" \
	--assignee-id "<account-id>" \
	--transition-id 31 \
	--get-details \
	--human-approval-obtained \
	--env-dir "." \
	# OR: --config-path "$HOME/.openclaw/openclaw.json" \
	--format json
```

## 7) Description/ADF Risk Guardrail

- Description replacement is full overwrite for the description field when provided.
- Embedded image semantics in description are not preserved by this flow.
- Before description replacement, warn explicitly if embedded media semantics may be lost.
- Manage binary assets as attachments using --attach-file.
- Replace flow only overwrites fields provided in the command; unspecified fields remain unchanged.

## 8) Mutation Audit/Verification

- CLI mutation flows increment OpenClawed_X label trail for audit history.
- Post-mutation verification is mandatory.
- Run follow-up searches and validate changed fields.

Verification examples:

```bash
"$JIRA_CLI_BIN" issue search --issue-key ABC-123 --format json
"$JIRA_CLI_BIN" issue search --jql "key = ABC-123" --format json
```

Verify:
- summary/description values
- labels, assignee, status/transition outcomes
- comments/worklogs/attachments if those actions were requested

## 9) Unsupported Feature Policy

Unsupported operation response:

This SKILL does not currently support this feature. If you would like to see it implemented, contact Master Omi.

Legacy command response:

Command '<legacy command>' is legacy and not supported. Use the canonical replacement command suggested by jira-cli.

Delete request response:

DELETE operations are not supported by this SKILL workflow. Please perform delete actions manually for greater control.

## 10) Error Handling Quick Rules

- On non-zero exit, inspect ERROR output and fix inputs before retry.
- Do not blindly retry mutation commands.
- For 429/rate-limit behavior, retry later and re-verify state before rerunning mutation.
- For permission failures, report required Jira scope/permission gaps.
- For attachment failures, verify file readability/path correctness.
- In --format json mode, parse structured error payload fields:
	- error.code, error.category, error.message, error.retryable, error.remediation, error.details
- If diagnostics is present, use retriesAttempted/retryDelayMs/lastHttpStatus/requestId for troubleshooting.
- Treat flag conflicts/dependencies as hard validation failures; correct flags before retry.

Quick exit-code shorthand:
- 0: success
- non-zero: command failed or blocked; inspect ERROR output for remediation

## 11) Mutation Checklist

Before any approved mutation execution:
1. Exact project/issue target confirmed.
2. Preview response reviewed (changeSummary present).
3. Explicit human approval received in current chat context.
4. --human-approval-obtained present on rerun.
5. Post-mutation verification completed and confirmed.
