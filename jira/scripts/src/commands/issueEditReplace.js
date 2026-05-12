const { CliError } = require("../errors");
const {
  buildActionPlan,
  executeActionPlan,
  summarizeActionPlan,
  truncate,
  mapActionsToPermissionRequirements,
} = require("./issueActions");
const {
  assertRequiredFlag,
  assertForbiddenFlags,
} = require("../flagValidator");
const { makeResolution, resolveInstruction, classifyIssueLookupError } = require("../resolution");
const {
  buildPlanHash,
  buildPlanId,
  issuePreviewRef,
  verifyFinalizeApproval,
  buildDiffSummary,
  requireNoDryRun,
} = require("../mutationWorkflow");
const {
  getIdempotentReplay,
  storeIdempotentResult,
} = require("../idempotencyStore");
const {
  buildPreflightIntent,
  runPermissionPreflight,
} = require("../permissionPreflight");

const REPLACE_APPROVAL_INSTRUCTION =
  "YOU ARE REQUIRED TO SHARE THESE REPLACE DETAILS WITH YOUR HUMAN. WARNING: APPROVAL MEANS THE EXISTING CONTENT OF THE LISTED REPLACE FIELDS WILL BE COMPLETELY OVERWRITTEN BY THE PAYLOAD SHOWN ABOVE. ASK FOR EXPLICIT CONFIRMATION. IF APPROVED, RERUN THE EXACT SAME COMMAND WITH --HUMAN-APPROVAL-OBTAINED. IF NOT APPROVED, STOP. IF THE HUMAN WANTS PARTIAL CHANGES (APPEND/PREPEND/INSERT), FIRST FETCH ISSUE DETAILS, COMPOSE THE FULL NEW FIELD VALUE PRESERVING THE UNCHANGED CONTENT, THEN USE ISSUE EDIT REPLACE WITH THAT COMPOSED VALUE.";

const FORBIDDEN_REPLACE_FLAGS = [
  "comment-body",
  "worklog-time-spent",
  "worklog-comment",
  "worklog-started",
  "attach-file",
  "link-type",
  "link-issue",
  "labels"
];

const REPLACE_ACTION_KINDS = new Set([
  "dates",
  "priority",
  "components",
  "parent",
  "environment",
  "story-points",
  "timetracking-estimate",
  "acceptance",
  "assignee",
  "transition",
  "labels",
]);

async function issueEditReplaceCommand(client, args, output) {
  const operationMode = String(args["operation-mode"] || "show-changes").toLowerCase();
  const issueIdOrKey = args.issue;
  const patchConfig = resolvePatchConfig(args);
  const patchPrepared = await preparePatchValues(client, issueIdOrKey, args, patchConfig);
  const effectiveArgs = patchPrepared.args;
  const summary = effectiveArgs.summary;
  const description = effectiveArgs.description;
  const approvalObtained = Boolean(args["human-approval-obtained"] || args.yes);
  const previewRef = effectiveArgs["preview-ref"] ? String(effectiveArgs["preview-ref"]) : null;
  const idempotencyKey = effectiveArgs["idempotency-key"] ? String(effectiveArgs["idempotency-key"]) : null;

  requireNoDryRun(args, "issue edit replace");

  if (!["prepare", "show-changes", "finalize", "resolve"].includes(operationMode)) {
    throw new CliError("Invalid --operation-mode for issue edit replace. Allowed: prepare, show-changes, finalize, resolve", 3);
  }

  assertRequiredFlag(effectiveArgs, "issue", "issue edit replace");

  if (operationMode === "resolve") {
    try {
      const issue = await client.getIssue(issueIdOrKey, 3, "summary");
      output({
        mode: "issue-edit-replace-resolve",
        resolution: makeResolution("resolved", { issue: issueIdOrKey }, {
          selected: {
            id: issue?.id,
            key: issue?.key || issueIdOrKey,
            summary: issue?.fields?.summary || null,
          },
          instruction: resolveInstruction("issue edit replace", "resolved"),
        }),
      });
      return;
    } catch (err) {
      if (classifyIssueLookupError(err) === "no-match") {
        output({
          mode: "issue-edit-replace-resolve",
          resolution: makeResolution("no-match", { issue: issueIdOrKey }, {
            instruction: resolveInstruction("issue edit replace", "no-match"),
          }),
        });
        return;
      }
      throw err;
    }
  }

  assertForbiddenFlags(effectiveArgs, FORBIDDEN_REPLACE_FLAGS, "issue edit replace");

  if (summary && summary.length > 255) {
    throw new CliError("Summary exceeds Jira 255 character limit", 3);
  }

  let primaryResult = null;
  let primaryExecutionPlan = null;

  if (summary || description) {
    const issue = patchPrepared.issue || (await client.getIssue(issueIdOrKey, 3, "summary,description,version"));
    const versionNumber = extractVersionNumber(issue);

    const update = {};
    if (summary) {
      update.summary = [{ set: summary }];
    }

    if (description) {
      update.description = [{ set: toAdf(description) }];
    }

    const payload = { update };
    if (Number.isInteger(versionNumber)) {
      payload.version = { number: versionNumber };
    }

    primaryExecutionPlan = { version: 3, payload };
    primaryResult = { dryRun: true, version: 3, payload };
  }

  const actions = buildActionPlan(issueIdOrKey, effectiveArgs);
  const hasReplaceAction = actions.some((action) => REPLACE_ACTION_KINDS.has(action.kind));
  const hasMutation = Boolean(primaryExecutionPlan || hasReplaceAction);

  if (!hasMutation && !effectiveArgs["get-details"]) {
    throw new CliError(
      "No replace operation supplied. Use --summary, --description, --start-date, --due-date, --priority-id, --component-ids, --parent-key/--parent-id, --environment-value, --story-points, --original-estimate, --acceptance-value, and/or --get-details",
      3
    );
  }

  const plannedActions = summarizeActionPlan(actions);
  const warnings = buildReplaceWarnings(effectiveArgs, actions, patchPrepared);
  const destructiveMarkers = resolveOverwrittenFields(effectiveArgs, actions, patchPrepared);
  const actor = String(client?.email || "unknown-actor");
  const targetKey = String(issueIdOrKey);
  const planHash = buildPlanHash({
    command: "issue-edit-replace",
    issue: targetKey,
    primaryPayload: primaryResult?.payload || null,
    plannedActions,
  });
  const planId = buildPlanId("issue-edit-replace", targetKey, planHash);

  const before = await loadIssueBeforeSnapshot(client, issueIdOrKey);
  const diff = buildDiffSummary({
    before,
    plannedOperations: [
      ...(primaryResult ? [{ kind: "primary-replace", payload: primaryResult.payload }] : []),
      ...plannedActions,
    ],
    afterIntent: {
      issue: issueIdOrKey,
      overwrittenFields: destructiveMarkers,
      summary: truncate(summary, 160),
      description: truncate(description, 160),
      patchMode: patchConfig.mode,
      patchFields: patchConfig.fields,
      patchApplied: patchPrepared.applied,
    },
    warnings,
    destructiveMarkers,
  });

  const permissionRequirements = mapActionsToPermissionRequirements(actions, {
    includeEditFields: Boolean(primaryExecutionPlan),
  });
  const preflightContext = {
    issueKey: issueIdOrKey,
  };
  const preflightIntent = buildPreflightIntent(permissionRequirements, preflightContext);

  if (operationMode === "prepare") {
    output({
      mode: "issue-edit-replace-prepare",
      issue: issueIdOrKey,
      planId,
      previewRefSeed: {
        commandName: "issue-edit-replace",
        targetKey,
        actor,
        planHash,
      },
      warnings,
      patchMode: patchConfig.mode,
      patchFields: patchConfig.fields,
      patchApplied: patchPrepared.applied,
    });
    return;
  }

  if (operationMode === "show-changes") {
    const ref = issuePreviewRef({
      planId,
      commandName: "issue-edit-replace",
      targetKey,
      actor,
      planHash,
    });
    output({
      mode: "issue-edit-replace-show-changes",
      issue: issueIdOrKey,
      planId,
      diff,
      warnings,
      patchMode: patchConfig.mode,
      patchFields: patchConfig.fields,
      patchApplied: patchPrepared.applied,
      preflightIntent,
      previewRef: ref.previewRef,
      previewRefExpiresAt: ref.previewRefExpiresAt,
      instruction: REPLACE_APPROVAL_INSTRUCTION,
    });
    return;
  }

  if (hasMutation && !approvalObtained) {
    throw new CliError("Finalize requires --human-approval-obtained after explicit approval.", 3);
  }

  verifyFinalizeApproval({
    previewRef,
    expected: {
      commandName: "issue-edit-replace",
      targetKey,
      actor,
      planHash,
    },
  });

  const replay = getIdempotentReplay(idempotencyKey, planHash);
  if (replay) {
    output({
      mode: "issue-edit-replace-finalize-replayed",
      replayed: true,
      idempotencyKey,
      result: replay,
    });
    return;
  }

  const preflight = await runPermissionPreflight(client, effectiveArgs, {
    commandName: "issue edit replace finalize",
    requirements: permissionRequirements,
    context: preflightContext,
  });

  if (primaryExecutionPlan) {
    await client.editIssue(issueIdOrKey, primaryExecutionPlan.payload, primaryExecutionPlan.version);
    primaryResult = {
      dryRun: false,
      version: primaryExecutionPlan.version,
      updated: true,
    };
  }

  const actionResult = await executeActionPlan(client, actions, false);
  const verification = await verifyMutationIssueExists(client, issueIdOrKey);

  const result = {
    mode: "issue-edit-replace-finalize",
    issue: issueIdOrKey,
    version: primaryResult?.version,
    updated: Boolean((primaryResult && primaryResult.updated) || hasReplaceAction),
    primaryResult,
    actionResult,
    verification,
    warnings,
    preflight,
    patchMode: patchConfig.mode,
    patchFields: patchConfig.fields,
    patchApplied: patchPrepared.applied,
  };

  storeIdempotentResult(idempotencyKey, planHash, result);

  output(result);
}

function buildReplaceWarnings(args, actions, patchPrepared) {
  const warnings = [];
  if (args.description !== undefined && patchPrepared.description.mode === "replace") {
    warnings.push("Description replacement is a full overwrite; embedded semantics may be lost.");
  } else if (patchPrepared.description.mode !== "replace" && args.description !== undefined) {
    warnings.push(`Description patch mode '${patchPrepared.description.mode}' composes with existing content before replace.`);
  }
  if (actions.some((a) => a.kind === "acceptance") && patchPrepared.acceptance.mode === "replace") {
    warnings.push("Acceptance criteria replacement is destructive for the target field.");
  } else if (actions.some((a) => a.kind === "acceptance") && patchPrepared.acceptance.mode !== "replace") {
    warnings.push(`Acceptance criteria patch mode '${patchPrepared.acceptance.mode}' composes with existing content before replace.`);
  }
  if (actions.some((a) => a.kind === "labels")) {
    warnings.push("Label replacement actions may remove existing labels.");
  }
  if (actions.some((a) => a.kind === "components")) {
    warnings.push("Array field replacement actions overwrite existing values for the targeted field.");
  }
  return warnings;
}

async function loadIssueBeforeSnapshot(client, issueIdOrKey) {
  try {
    const issue = await client.getIssue(issueIdOrKey, 3, "summary,description,status,assignee,labels,duedate");
    return {
      key: issue?.key || issueIdOrKey,
      summary: issue?.fields?.summary || null,
      description: truncate(issue?.fields?.description ? JSON.stringify(issue.fields.description) : null, 200),
      status: issue?.fields?.status?.name || null,
      assignee: issue?.fields?.assignee?.displayName || null,
      labels: issue?.fields?.labels || [],
      dueDate: issue?.fields?.duedate || null,
    };
  } catch (err) {
    return { key: issueIdOrKey, error: err.message };
  }
}

async function verifyMutationIssueExists(client, issueIdOrKey) {
  const checks = [];
  try {
    const issue = await client.getIssue(issueIdOrKey, 3, "summary");
    checks.push({ name: "issue-exists", passed: Boolean(issue?.id || issue?.key) });
  } catch (err) {
    checks.push({ name: "issue-exists", passed: false, message: err.message });
  }
  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

function resolveOverwrittenFields(args, actions, patchPrepared) {
  const fields = [];

  if (args.summary !== undefined) fields.push("summary");
  if (args.description !== undefined && patchPrepared.description.mode === "replace") fields.push("description");

  for (const action of actions) {
    if (action.kind === "dates") {
      if (action.startDate !== undefined) fields.push("start-date");
      if (action.dueDate !== undefined) fields.push("due-date");
    }
    if (action.kind === "priority") fields.push("priority");
    if (action.kind === "components") fields.push("components");
    if (action.kind === "parent") fields.push("parent");
    if (action.kind === "environment") fields.push("environment");
    if (action.kind === "story-points") fields.push("story-points");
    if (action.kind === "timetracking-estimate") fields.push("original-estimate");
    if (action.kind === "acceptance" && patchPrepared.acceptance.mode === "replace") fields.push("acceptance-criteria");
    if (action.kind === "assignee") fields.push("assignee");
    if (action.kind === "transition") fields.push("transition");
    if (action.kind === "labels") fields.push("labels");
  }
  return Array.from(new Set(fields));
}

function extractVersionNumber(issue) {
  const candidates = [
    issue?.fields?.version,
    issue?.fields?.version?.number,
    issue?.version,
    issue?.version?.number,
  ];

  for (const candidate of candidates) {
    if (Number.isInteger(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toAdf(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: text
          ? [
              {
                type: "text",
                text,
              },
            ]
          : [],
      },
    ],
  };
}

function resolvePatchConfig(args) {
  const modeRaw = args["patch-mode"] ? String(args["patch-mode"]).toLowerCase() : "replace";
  const mode = normalizePatchMode(modeRaw);

  const supported = ["description", "acceptance"];
  const fieldsRaw = args["patch-field"] ? String(args["patch-field"]).toLowerCase() : "description,acceptance";
  const tokens = fieldsRaw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  const expanded = [];
  for (const token of tokens) {
    if (token === "all" || token === "both") {
      expanded.push("description", "acceptance");
      continue;
    }
    expanded.push(token);
  }

  const unique = Array.from(new Set(expanded));
  if (unique.length === 0 || unique.some((name) => !supported.includes(name))) {
    throw new CliError("Invalid --patch-field. Allowed: description, acceptance, both, all (comma-separated supported).", 3);
  }

  return {
    mode,
    fields: unique,
  };
}

function normalizePatchMode(mode) {
  if (["replace", "append", "prepend"].includes(mode)) {
    return mode;
  }
  throw new CliError("Invalid --patch-mode. Allowed: replace, append, prepend.", 3);
}

async function preparePatchValues(client, issueIdOrKey, args, patchConfig) {
  const next = { ...args };
  const hasDescription = next.description !== undefined;
  const hasAcceptance = next["acceptance-value"] !== undefined;
  const descMode = hasDescription && patchConfig.fields.includes("description") ? patchConfig.mode : "replace";
  const acceptanceMode = hasAcceptance && patchConfig.fields.includes("acceptance") ? patchConfig.mode : "replace";
  const needsPatchData = descMode !== "replace" || acceptanceMode !== "replace";

  if (patchConfig.mode !== "replace" && !hasDescription && !hasAcceptance) {
    throw new CliError("--patch-mode append/prepend requires --description and/or --acceptance-value.", 3);
  }

  if (!needsPatchData) {
    return {
      args: next,
      issue: null,
      applied: [],
      description: { mode: descMode },
      acceptance: { mode: acceptanceMode },
    };
  }

  const issue = await client.getIssue(issueIdOrKey, 3, "*all");
  const applied = [];

  if (descMode !== "replace") {
    const currentDescription = normalizeIssueText(issue?.fields?.description);
    const incomingDescription = String(next.description || "");
    next.description = composePatchedText(currentDescription, incomingDescription, descMode);
    applied.push({ field: "description", mode: descMode });
  }

  if (acceptanceMode !== "replace") {
    const acceptanceFieldId =
      next["acceptance-field-id"] || (await resolveAcceptanceFieldId(client, issueIdOrKey));
    const currentAcceptance = normalizeIssueText(issue?.fields?.[acceptanceFieldId]);
    const incomingAcceptance = String(next["acceptance-value"] || "");
    next["acceptance-value"] = composePatchedText(currentAcceptance, incomingAcceptance, acceptanceMode);
    next["acceptance-field-id"] = acceptanceFieldId;
    applied.push({ field: "acceptance", mode: acceptanceMode, fieldId: acceptanceFieldId });
  }

  return {
    args: next,
    issue,
    applied,
    description: { mode: descMode },
    acceptance: { mode: acceptanceMode },
  };
}

function composePatchedText(existingValue, incomingValue, mode) {
  if (mode === "replace") return incomingValue;
  if (!existingValue) return incomingValue;
  if (!incomingValue) return existingValue;
  if (mode === "append") return `${existingValue}\n\n${incomingValue}`;
  return `${incomingValue}\n\n${existingValue}`;
}

function normalizeIssueText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.type === "doc" && Array.isArray(value.content)) {
    const chunks = [];
    collectAdfText(value.content, chunks);
    return chunks.join("\n").trim();
  }
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function collectAdfText(nodes, sink) {
  for (const node of nodes || []) {
    if (!node) continue;
    if (node.type === "text" && typeof node.text === "string") {
      sink.push(node.text);
    }
    if (Array.isArray(node.content)) {
      collectAdfText(node.content, sink);
      if (node.type === "paragraph") {
        sink.push("\n");
      }
    }
  }
}

async function resolveAcceptanceFieldId(client, issueIdOrKey) {
  const editmeta = await client.getIssueEditMeta(issueIdOrKey, 2);
  const fields = editmeta?.fields || {};
  for (const [fieldId, fieldSpec] of Object.entries(fields)) {
    if (String(fieldSpec?.name || "").toLowerCase() === "acceptance criteria") {
      return fieldId;
    }
  }
  throw new CliError("Unable to auto-resolve Acceptance Criteria field for --patch-mode.", 3);
}

module.exports = {
  issueEditReplaceCommand,
};
