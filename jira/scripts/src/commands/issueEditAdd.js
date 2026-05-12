const { CliError } = require("../errors");
const {
  buildActionPlan,
  executeActionPlan,
  summarizeActionPlan,
  mapActionsToPermissionRequirements,
} = require("./issueActions");
const {
  assertRequiredFlag,
  assertForbiddenFlags,
  assertRequiredWith,
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

const ADD_APPROVAL_INSTRUCTION =
  "YOU ARE REQUIRED TO SHARE THESE ADD-ONLY ACTIONS WITH YOUR HUMAN AND ASK THEM IF THEY AGREE WITH THE UPDATES ABOUT TO BE MADE. IF THE HUMAN AGREES, RERUN THE EXACT SAME COMMAND WITH THE --HUMAN-APPROVAL-OBTAINED FLAG APPENDED OTHERWISE DON'T RERUN IT.";

const FORBIDDEN_ADD_FLAGS = [
  "summary",
  "description",
  "start-date",
  "due-date",
  "priority-id",
  "component-ids",
  "parent-key",
  "parent-id",
  "environment-value",
  "environment-field-id",
  "story-points",
  "story-points-field-id",
  "original-estimate",
  "acceptance-value",
  "acceptance-field-id",
  "assignee-id",
  "transition-id",
  "labels-add",
  "labels-remove"
];

const MUTATING_ADD_KINDS = new Set(["comment", "worklog", "attachment", "labels", "link"]);

async function issueEditAddCommand(client, args, output) {
  const operationMode = String(args["operation-mode"] || "show-changes").toLowerCase();
  const issueIdOrKey = args.issue;
  const approvalObtained = Boolean(args["human-approval-obtained"] || args.yes);
  const previewRef = args["preview-ref"] ? String(args["preview-ref"]) : null;
  const idempotencyKey = args["idempotency-key"] ? String(args["idempotency-key"]) : null;

  requireNoDryRun(args, "issue edit add");

  if (!["prepare", "show-changes", "finalize", "resolve"].includes(operationMode)) {
    throw new CliError("Invalid --operation-mode for issue edit add. Allowed: prepare, show-changes, finalize, resolve", 3);
  }

  assertRequiredFlag(args, "issue", "issue edit add");

  if (operationMode === "resolve") {
    try {
      const issue = await client.getIssue(issueIdOrKey, 3, "summary");
      output({
        mode: "issue-edit-add-resolve",
        resolution: makeResolution("resolved", { issue: issueIdOrKey }, {
          selected: {
            id: issue?.id,
            key: issue?.key || issueIdOrKey,
            summary: issue?.fields?.summary || null,
          },
          instruction: resolveInstruction("issue edit add", "resolved"),
        }),
      });
      return;
    } catch (err) {
      if (classifyIssueLookupError(err) === "no-match") {
        output({
          mode: "issue-edit-add-resolve",
          resolution: makeResolution("no-match", { issue: issueIdOrKey }, {
            instruction: resolveInstruction("issue edit add", "no-match"),
          }),
        });
        return;
      }
      throw err;
    }
  }

  assertForbiddenFlags(args, FORBIDDEN_ADD_FLAGS, "issue edit add");
  assertRequiredWith(args, "link-type", ["link-issue"], "issue edit add");
  assertRequiredWith(args, "link-issue", ["link-type"], "issue edit add");

  const actions = buildActionPlan(issueIdOrKey, args);
  if (actions.length === 0) {
    throw new CliError(
      "No add operation supplied. Use --comment-body, --worklog-time-spent, --attach-file, and/or --get-details",
      3
    );
  }

  const hasMutation = actions.some((action) => MUTATING_ADD_KINDS.has(action.kind));
  const plannedActions = summarizeActionPlan(actions);
  const warnings = buildAddWarnings(actions);
  const destructiveMarkers = [];
  const actor = String(client?.email || "unknown-actor");
  const targetKey = String(issueIdOrKey);
  const planHash = buildPlanHash({
    command: "issue-edit-add",
    issue: targetKey,
    plannedActions,
  });
  const planId = buildPlanId("issue-edit-add", targetKey, planHash);

  const before = await loadIssueBeforeSnapshot(client, issueIdOrKey);
  const diff = buildDiffSummary({
    before,
    plannedOperations: plannedActions,
    afterIntent: {
      issue: issueIdOrKey,
      actionKinds: plannedActions.map((a) => a.kind),
    },
    warnings,
    destructiveMarkers,
  });

  const permissionRequirements = mapActionsToPermissionRequirements(actions, {
    includeEditFields: false,
  });
  const preflightContext = {
    issueKey: issueIdOrKey,
  };
  const preflightIntent = buildPreflightIntent(permissionRequirements, preflightContext);

  if (operationMode === "prepare") {
    output({
      mode: "issue-edit-add-prepare",
      issue: issueIdOrKey,
      planId,
      previewRefSeed: {
        commandName: "issue-edit-add",
        targetKey,
        actor,
        planHash,
      },
      warnings,
    });
    return;
  }

  if (operationMode === "show-changes") {
    const ref = issuePreviewRef({
      planId,
      commandName: "issue-edit-add",
      targetKey,
      actor,
      planHash,
    });
    output({
      mode: "issue-edit-add-show-changes",
      issue: issueIdOrKey,
      planId,
      diff,
      warnings,
      preflightIntent,
      previewRef: ref.previewRef,
      previewRefExpiresAt: ref.previewRefExpiresAt,
      instruction: ADD_APPROVAL_INSTRUCTION,
    });
    return;
  }

  if (hasMutation && !approvalObtained) {
    throw new CliError("Finalize requires --human-approval-obtained after explicit approval.", 3);
  }

  verifyFinalizeApproval({
    previewRef,
    expected: {
      commandName: "issue-edit-add",
      targetKey,
      actor,
      planHash,
    },
  });

  const replay = getIdempotentReplay(idempotencyKey, planHash);
  if (replay) {
    output({
      mode: "issue-edit-add-finalize-replayed",
      replayed: true,
      idempotencyKey,
      result: replay,
    });
    return;
  }

  const preflight = await runPermissionPreflight(client, args, {
    commandName: "issue edit add finalize",
    requirements: permissionRequirements,
    context: preflightContext,
  });

  const actionResult = await executeActionPlan(client, actions, false);
  const verification = await verifyMutationIssueExists(client, issueIdOrKey);

  const result = {
    mode: "issue-edit-add-finalize",
    issue: issueIdOrKey,
    updated: hasMutation,
    actionResult,
    verification,
    warnings,
    preflight,
  };
  storeIdempotentResult(idempotencyKey, planHash, result);

  output(result);
}

function buildAddWarnings(actions) {
  const warnings = [];
  if (actions.some((a) => a.kind === "link")) {
    warnings.push("Issue link side-effects requested; verify link target and type before finalize.");
  }
  return warnings;
}

async function loadIssueBeforeSnapshot(client, issueIdOrKey) {
  try {
    const issue = await client.getIssue(issueIdOrKey, 3, "summary,status,assignee,labels");
    return {
      key: issue?.key || issueIdOrKey,
      summary: issue?.fields?.summary || null,
      status: issue?.fields?.status?.name || null,
      assignee: issue?.fields?.assignee?.displayName || null,
      labels: issue?.fields?.labels || [],
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

module.exports = {
  issueEditAddCommand,
};
