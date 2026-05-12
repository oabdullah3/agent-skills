const { CliError } = require("../errors");
const {
  assertRequiredFlag,
  assertExactlyOneOf,
  assertRequiredWith,
} = require("../flagValidator");
const {
  buildActionPlan,
  executeActionPlan,
  summarizeActionPlan,
  truncate,
  mapActionsToPermissionRequirements,
} = require("./issueActions");
const { makeResolution, resolveInstruction } = require("../resolution");
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
const PRESETS = require("../jiraPresetRegistry.json");

const APPROVAL_INSTRUCTION =
  "YOU ARE REQUIRED TO SHARE THESE DETAILS WITH YOUR HUMAN AND ASK THEM IF THEY AGREE WITH THE UPDATES ABOUT TO BE MADE. IF THE HUMAN AGREES, RERUN THE EXACT SAME COMMAND WITH THE --HUMAN-APPROVAL-OBTAINED FLAG APPENDED OTHERWISE DON'T RERUN IT.";

async function issueCreateCommand(client, args, output) {
  const operationMode = String(args["operation-mode"] || "show-changes").toLowerCase();
  const presetResolution = resolvePresetArgs(args);
  const effectiveArgs = presetResolution.args;
  const summary = effectiveArgs.summary;
  const descriptionText = effectiveArgs.description || "";
  const approvalObtained = Boolean(args["human-approval-obtained"] || args.yes);
  const previewRef = effectiveArgs["preview-ref"] ? String(effectiveArgs["preview-ref"]) : null;
  const idempotencyKey = effectiveArgs["idempotency-key"] ? String(effectiveArgs["idempotency-key"]) : null;

  requireNoDryRun(args, "issue create");

  if (!["prepare", "show-changes", "finalize", "resolve"].includes(operationMode)) {
    throw new CliError("Invalid --operation-mode for issue create. Allowed: prepare, show-changes, finalize, resolve", 3);
  }

  assertExactlyOneOf(
    effectiveArgs,
    ["project-id", "project-key", "project-query"],
    "project selector",
    "issue create"
  );
  assertExactlyOneOf(
    effectiveArgs,
    ["issue-type-id", "issue-type-name"],
    "issue type selector",
    "issue create"
  );

  if (operationMode === "resolve") {
    const projectResolution = await resolveProjectForResolution(client, effectiveArgs);
    let issueTypeResolution = makeResolution("no-match", {}, {
      instruction: "Resolve project first, then resolve issue type.",
    });

    if (projectResolution.status === "resolved" && projectResolution.selected?.id) {
      issueTypeResolution = await resolveIssueTypeForResolution(client, projectResolution.selected.id, effectiveArgs);
    }

    const status = deriveOverallResolutionStatus(projectResolution.status, issueTypeResolution.status);

    output({
      mode: "issue-create-resolve",
      resolution: makeResolution(
        status,
        {
          project: {
            "project-id": effectiveArgs["project-id"] || null,
            "project-key": effectiveArgs["project-key"] || null,
            "project-query": effectiveArgs["project-query"] || null,
          },
          issueType: {
            "issue-type-id": effectiveArgs["issue-type-id"] || null,
            "issue-type-name": effectiveArgs["issue-type-name"] || null,
          },
        },
        {
          candidates: {
            projects: projectResolution.candidates || [],
            issueTypes: issueTypeResolution.candidates || [],
          },
          selected:
            status === "resolved"
              ? {
                  project: projectResolution.selected,
                  issueType: issueTypeResolution.selected,
                }
              : null,
          instruction: resolveInstruction("issue create", status),
        }
      ),
    });
    return;
  }

  assertRequiredFlag(effectiveArgs, "summary", "issue create");
  assertRequiredWith(effectiveArgs, "link-type", ["link-issue"], "issue create");
  assertRequiredWith(effectiveArgs, "link-issue", ["link-type"], "issue create");
  if (effectiveArgs["transition-id"]) {
    throw new CliError(
      "Flag --transition-id is not supported for issue create. Use issue edit replace to apply a workflow transition.",
      3
    );
  }

  if (summary.length > 255) {
    throw new CliError("Summary exceeds Jira 255 character limit", 3);
  }

  const project = await resolveProject(client, effectiveArgs);
  if (project.ambiguous) {
    output({
      mode: "issue-create-project-selection-required",
      message:
        "Multiple projects matched your query. Choose one from candidateProjects and rerun issue create with --project-id <id>, or refine --project-query and retry.",
      candidateProjects: project.projects,
    });
    return;
  }

  const issueType = await resolveIssueType(client, project.id, effectiveArgs);

  const fields = {
    project: project.id ? { id: project.id } : { key: project.key },
    summary,
    description: toAdf(descriptionText),
    issuetype: { id: issueType.id },
  };

  const targetKey = String(project.id || project.key || "project");
  const actor = String(client?.email || "unknown-actor");
  const previewActions = buildActionPlan("<created-issue>", effectiveArgs, { disableTransition: true });
  const plannedActions = summarizeActionPlan(previewActions);
  const warnings = buildCreateWarnings(effectiveArgs);
  const destructiveMarkers = [];
  const planHash = buildPlanHash({
    fields,
    plannedActions,
    command: "issue-create",
  });
  const planId = buildPlanId("issue-create", targetKey, planHash);

  const diff = buildDiffSummary({
    before: null,
    plannedOperations: plannedActions,
    afterIntent: {
      project: fields.project,
      issueType: fields.issuetype,
      summary: truncate(fields.summary, 160),
      description: truncate(descriptionText, 160),
      presetApplied: presetResolution.applied,
      presetOverrides: presetResolution.overrides,
    },
    warnings,
    destructiveMarkers,
  });

  const permissionRequirements = mapActionsToPermissionRequirements(previewActions, {
    includeCreateIssue: true,
  });
  const preflightContext = {
    projectKey: project.key || null,
    projectId: project.id || null,
  };
  const preflightIntent = buildPreflightIntent(permissionRequirements, preflightContext);

  if (operationMode === "prepare") {
    output({
      mode: "issue-create-prepare",
      planId,
      presetApplied: presetResolution.applied,
      presetOverrides: presetResolution.overrides,
      previewRefSeed: {
        commandName: "issue-create",
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
      commandName: "issue-create",
      targetKey,
      actor,
      planHash,
    });
    output({
      mode: "issue-create-show-changes",
      planId,
      presetApplied: presetResolution.applied,
      presetOverrides: presetResolution.overrides,
      diff,
      warnings,
      preflightIntent,
      previewRef: ref.previewRef,
      previewRefExpiresAt: ref.previewRefExpiresAt,
      instruction: APPROVAL_INSTRUCTION,
    });
    return;
  }

  if (!approvalObtained) {
    throw new CliError("Finalize requires --human-approval-obtained after explicit approval.", 3);
  }

  verifyFinalizeApproval({
    previewRef,
    expected: {
      commandName: "issue-create",
      targetKey,
      actor,
      planHash,
    },
  });

  const replay = getIdempotentReplay(idempotencyKey, planHash);
  if (replay) {
    output({
      mode: "issue-create-finalize-replayed",
      replayed: true,
      idempotencyKey,
      result: replay,
    });
    return;
  }

  const preflight = await runPermissionPreflight(client, effectiveArgs, {
    commandName: "issue create finalize",
    requirements: permissionRequirements,
    context: preflightContext,
  });

  const userLabels = effectiveArgs.labels ? String(effectiveArgs.labels).split(",").map(s => s.trim()).filter(Boolean) : [];
  userLabels.push("OpenClawed_0");
  fields.labels = userLabels;

  const created = await client.createIssue(fields);
  const targetIssue = created.key || created.id;
  const actions = buildActionPlan(targetIssue, effectiveArgs, { disableTransition: true });
  const actionResult = await executeActionPlan(client, actions, false);

  const verification = await verifyCreateMutation(client, targetIssue);
  const result = {
    mode: "issue-create-finalize",
    created,
    actionResult,
    verification,
    warnings,
    preflight,
    presetApplied: presetResolution.applied,
    presetOverrides: presetResolution.overrides,
  };

  storeIdempotentResult(idempotencyKey, planHash, result);
  output(result);
}

function buildCreateWarnings(args) {
  const warnings = [];
  if (args["project-query"]) {
    warnings.push("Project resolved via query; verify target confidence before finalize.");
  }
  if (args["issue-type-name"] && !args["issue-type-id"]) {
    warnings.push("Issue type resolved by name; verify exact issue type before finalize.");
  }
  if (args["link-type"] || args["link-issue"]) {
    warnings.push("Issue link side-effects requested; verify link target and type before finalize.");
  }
  return warnings;
}

function resolvePresetArgs(args) {
  const presetFlags = [
    "incident-report",
    "bug-triage",
    "change-request",
    "release-blocker",
  ];
  const selected = presetFlags.filter((flag) => Boolean(args[flag]));
  if (selected.length > 1) {
    throw new CliError(
      `Choose only one issue-create preset flag: ${presetFlags.map((f) => `--${f}`).join(", ")}`,
      3
    );
  }

  if (selected.length === 0) {
    return {
      args,
      applied: null,
      overrides: [],
    };
  }

  const presetKey = selected[0];
  const preset = PRESETS[presetKey] || null;
  if (!preset) {
    throw new CliError(`Unknown preset configuration for --${presetKey}.`, 3);
  }

  const next = { ...args };
  const applied = {
    preset: presetKey,
    summaryPrefix: preset.summaryPrefix,
    labelsSeed: preset.labelsSeed,
    issueTypeHint: preset.issueTypeHint,
  };
  const overrides = [];

  if (!next.summary) {
    next.summary = `${preset.summaryPrefix} TBD`;
  } else {
    overrides.push("summary");
  }

  if (!next.description) {
    next.description = preset.descriptionTemplate;
  } else {
    overrides.push("description");
  }

  if (!next.labels) {
    next.labels = preset.labelsSeed.join(",");
  } else {
    overrides.push("labels");
  }

  if (!next["issue-type-id"] && !next["issue-type-name"] && preset.issueTypeHint) {
    next["issue-type-name"] = preset.issueTypeHint;
  } else if (next["issue-type-id"] || next["issue-type-name"]) {
    overrides.push("issue-type");
  }

  return {
    args: next,
    applied,
    overrides: Array.from(new Set(overrides)),
  };
}

async function verifyCreateMutation(client, issueIdOrKey) {
  const checks = [];
  try {
    const issue = await client.getIssue(issueIdOrKey, 3, "summary,status,labels");
    checks.push({ name: "issue-exists", passed: Boolean(issue?.id || issue?.key) });
    checks.push({ name: "label-stamp-present", passed: Array.isArray(issue?.fields?.labels) && issue.fields.labels.some((l) => String(l).startsWith("OpenClawed_")) });
  } catch (err) {
    checks.push({ name: "issue-exists", passed: false, message: err.message });
  }
  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

function deriveOverallResolutionStatus(projectStatus, issueTypeStatus) {
  if (projectStatus === "resolved" && issueTypeStatus === "resolved") {
    return "resolved";
  }
  if (projectStatus === "ambiguous" || issueTypeStatus === "ambiguous") {
    return "ambiguous";
  }
  return "no-match";
}

async function resolveProjectForResolution(client, args) {
  if (args["project-id"]) {
    const projectId = String(args["project-id"]);
    try {
      const result = await client.searchProjects(projectId, 0, 50);
      const projects = result.values || [];
      const match = projects.find((p) => String(p?.id || "") === projectId);
      if (match) {
        return makeResolution("resolved", { "project-id": projectId }, {
          selected: { id: match.id, key: match.key, name: match.name },
        });
      }
    } catch (_) {
      // fall through to no-match
    }

    return makeResolution("no-match", { "project-id": projectId }, {
      instruction: resolveInstruction("issue create project", "no-match"),
    });
  }

  if (args["project-key"]) {
    const query = String(args["project-key"]).toUpperCase();
    const result = await client.searchProjects(query, 0, 50);
    const projects = result.values || [];
    const matches = projects
      .filter((p) => String(p?.key || "").toUpperCase() === query)
      .map((p) => ({ id: p.id, key: p.key, name: p.name }));

    if (matches.length === 1) {
      return makeResolution("resolved", { "project-key": query }, { selected: matches[0] });
    }
    if (matches.length > 1) {
      return makeResolution("ambiguous", { "project-key": query }, {
        candidates: matches,
        instruction: resolveInstruction("issue create project", "ambiguous"),
      });
    }
    return makeResolution("no-match", { "project-key": query }, {
      instruction: resolveInstruction("issue create project", "no-match"),
    });
  }

  const query = String(args["project-query"]);
  const result = await client.searchProjects(query, 0, 25);
  const projects = (result.values || []).map((p) => ({ id: p.id, key: p.key, name: p.name }));
  const exact = projects.filter((p) => {
    const key = String(p.key || "").toLowerCase();
    const name = String(p.name || "").toLowerCase();
    const q = query.toLowerCase();
    return key === q || name === q;
  });

  if (exact.length === 1) {
    return makeResolution("resolved", { "project-query": query }, { selected: exact[0] });
  }
  if (exact.length > 1) {
    return makeResolution("ambiguous", { "project-query": query }, {
      candidates: exact,
      instruction: resolveInstruction("issue create project", "ambiguous"),
    });
  }
  if (projects.length === 1) {
    return makeResolution("resolved", { "project-query": query }, { selected: projects[0] });
  }
  if (projects.length > 1) {
    return makeResolution("ambiguous", { "project-query": query }, {
      candidates: projects,
      instruction: resolveInstruction("issue create project", "ambiguous"),
    });
  }
  return makeResolution("no-match", { "project-query": query }, {
    instruction: resolveInstruction("issue create project", "no-match"),
  });
}

async function resolveIssueTypeForResolution(client, projectId, args) {
  const payload = await client.getIssueTypesForProject(projectId);
  const issueTypes = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.issueTypes)
      ? payload.issueTypes
      : [];
  const normalized = issueTypes.map((item) => ({ id: item.id, name: item.name }));

  if (args["issue-type-id"]) {
    const id = String(args["issue-type-id"]);
    const matches = normalized.filter((item) => String(item.id) === id);
    if (matches.length === 1) {
      return makeResolution("resolved", { "issue-type-id": id }, { selected: matches[0] });
    }
    if (matches.length > 1) {
      return makeResolution("ambiguous", { "issue-type-id": id }, {
        candidates: matches,
        instruction: resolveInstruction("issue create issue-type", "ambiguous"),
      });
    }
    return makeResolution("no-match", { "issue-type-id": id }, {
      instruction: resolveInstruction("issue create issue-type", "no-match"),
    });
  }

  const name = String(args["issue-type-name"]);
  const matches = normalized.filter((item) => String(item.name || "").toLowerCase() === name.toLowerCase());
  if (matches.length === 1) {
    return makeResolution("resolved", { "issue-type-name": name }, { selected: matches[0] });
  }
  if (matches.length > 1) {
    return makeResolution("ambiguous", { "issue-type-name": name }, {
      candidates: matches,
      instruction: resolveInstruction("issue create issue-type", "ambiguous"),
    });
  }
  return makeResolution("no-match", { "issue-type-name": name }, {
    instruction: resolveInstruction("issue create issue-type", "no-match"),
  });
}

async function resolveProject(client, args) {
  if (args["project-id"]) {
    return { id: args["project-id"] };
  }

  if (args["project-key"]) {
    const query = String(args["project-key"]).toUpperCase();
    const result = await client.searchProjects(query, 0, 50);
    const projects = result.values || [];
    const match = projects.find(p => p.key && p.key.toUpperCase() === query);
    
    if (match) {
      return { id: match.id, key: match.key, name: match.name };
    }
    throw new CliError(`Project key '${query}' not found. Please verify the key or use --project-id.`, 5);
  }

  const query = args["project-query"];
  if (!query) {
    throw new CliError(
      "Missing project selector: provide --project-id, --project-key, or --project-query",
      3
    );
  }

  const maxAttempts = 3;
  const pageSize = 25;

  let startAt = 0;
  const candidates = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await client.searchProjects(query, startAt, pageSize);
    const projects = result.values || [];

    for (const project of projects) {
      candidates.push({
        id: project.id,
        key: project.key,
        name: project.name,
      });
    }

    const exactMatches = projects.filter((project) => {
      const key = typeof project.key === "string" ? project.key.toLowerCase() : "";
      const name = typeof project.name === "string" ? project.name.toLowerCase() : "";
      const q = query.toLowerCase();
      return key === q || name === q;
    });

    if (exactMatches.length === 1) {
      return { id: exactMatches[0].id, key: exactMatches[0].key };
    }

    if (projects.length === 1) {
      return { id: projects[0].id, key: projects[0].key };
    }

    startAt += pageSize;
  }

  const uniqueCandidates = Array.from(
    new Map(candidates.map((project) => [project.id, project])).values()
  );

  if (uniqueCandidates.length > 1) {
    return {
      ambiguous: true,
      query,
      attempts: maxAttempts,
      projects: uniqueCandidates,
    };
  }

  if (uniqueCandidates.length === 1) {
    return { id: uniqueCandidates[0].id, key: uniqueCandidates[0].key };
  }

  throw new CliError(
    `Project not found after ${maxAttempts} attempts for query '${query}'. Refine --project-query and retry.`,
    5
  );
}

async function resolveIssueType(client, projectId, args) {
  if (args["issue-type-id"]) {
    return { id: args["issue-type-id"] };
  }

  const issueTypeName = args["issue-type-name"];
  if (!issueTypeName) {
    throw new CliError("Missing issue type: provide --issue-type-id or --issue-type-name", 3);
  }

  if (!projectId) {
    throw new CliError(
      "Issue type lookup by name requires project id resolution first",
      6
    );
  }

  const payload = await client.getIssueTypesForProject(projectId);
  const issueTypes = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.issueTypes)
      ? payload.issueTypes
      : [];

  const matches = issueTypes.filter(
    (item) => item && typeof item.name === "string" && item.name.toLowerCase() === issueTypeName.toLowerCase()
  );

  if (matches.length === 1) {
    return { id: matches[0].id, name: matches[0].name };
  }

  if (matches.length > 1) {
    throw new CliError(
      `Issue type '${issueTypeName}' is ambiguous. Provide --issue-type-id instead`,
      6,
      { matches }
    );
  }

  throw new CliError(`Issue type '${issueTypeName}' not found for project ${projectId}`, 6);
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

function toInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

module.exports = {
  issueCreateCommand,
};
