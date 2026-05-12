const fs = require("fs");
const { requireFlag } = require("../flagValidator");
const { issuePreviewToken, verifyFinalize } = require("../mutationWorkflow");
const { hasKey, consumeKey } = require("../idempotencyStore");
const { CliError } = require("../errors");
const { requireResolvedRepo, repoContextKey } = require("./repoResolve");

const SUPPORTED_ACTIONS = new Set(["create", "update", "delete"]);
const DEFAULT_DIFF_MAX_CHARS = 2000;
const DEFAULT_DIFF_MAX_LINES = 80;

function decodeBase64(value) {
  if (!value) return "";
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch (_) {
    return "";
  }
}

function limitText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n...<truncated>`,
    truncated: true,
  };
}

function toLines(value) {
  return String(value || "").split(/\r?\n/);
}

function renderDiffPreview({ oldText, newText, maxChars, maxLines }) {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  const removed = oldLines.slice(0, maxLines).map((line) => `- ${line}`);
  const added = newLines.slice(0, maxLines).map((line) => `+ ${line}`);
  const header = ["--- previous", "+++ proposed"];
  const body = [...removed, ...added].join("\n");
  const capped = limitText(`${header.join("\n")}\n${body}`, maxChars);
  const lineTruncated = oldLines.length > maxLines || newLines.length > maxLines;
  return {
    text: capped.text,
    truncated: Boolean(capped.truncated || lineTruncated),
    previousLineCount: oldLines.length,
    proposedLineCount: newLines.length,
  };
}

function parseActionsFromJson(actionsJsonValue) {
  const raw = String(actionsJsonValue || "").trim();
  if (!raw) return [];

  const jsonText = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw;
  const parsed = JSON.parse(jsonText);
  const actions = Array.isArray(parsed) ? parsed : parsed.actions;
  if (!Array.isArray(actions)) {
    throw new CliError("Invalid --actions-json payload. Expected array or object with actions array.", 2, {
      code: "INVALID_ACTIONS_JSON",
      category: "validation",
      remediation: "Pass --actions-json as JSON array or a path to a JSON file.",
    });
  }
  return actions;
}

function parseSingleAction(flags) {
  if (!flags.action) return null;
  requireFlag(flags, "file-path", "Missing --file-path for --action workflow.");
  const action = String(flags.action).toLowerCase();
  if (!SUPPORTED_ACTIONS.has(action)) {
    throw new CliError(`Unsupported --action '${flags.action}'.`, 2, {
      code: "INVALID_ACTION",
      category: "validation",
      remediation: "Use --action create|update|delete.",
    });
  }

  const item = {
    action,
    file_path: flags["file-path"],
  };

  if (action !== "delete") {
    requireFlag(flags, "content", "Missing --content for create/update action.");
    item.content = String(flags.content);
  }

  return item;
}

function normalizeAction(action, index) {
  const kind = String(action.action || "").toLowerCase();
  if (!SUPPORTED_ACTIONS.has(kind)) {
    throw new CliError(`Invalid action at index ${index}: '${action.action}'.`, 2, {
      code: "INVALID_ACTION",
      category: "validation",
      remediation: "Use action values create|update|delete.",
    });
  }

  const filePath = action.file_path || action.filePath;
  if (!filePath) {
    throw new CliError(`Missing file_path at action index ${index}.`, 2, {
      code: "MISSING_FILE_PATH",
      category: "validation",
      remediation: "Provide file_path for each action.",
    });
  }

  const normalized = {
    action: kind,
    file_path: String(filePath),
  };

  if (kind !== "delete") {
    if (action.content === undefined || action.content === null) {
      throw new CliError(`Missing content at action index ${index} for ${kind}.`, 2, {
        code: "MISSING_CONTENT",
        category: "validation",
        remediation: "Provide content for create/update actions.",
      });
    }
    normalized.content = String(action.content);
  }

  return normalized;
}

function collectActions(flags) {
  const fromJson = flags["actions-json"] ? parseActionsFromJson(flags["actions-json"]) : [];
  const fromSingle = parseSingleAction(flags);
  const merged = [...fromJson, ...(fromSingle ? [fromSingle] : [])];

  if (merged.length === 0) {
    throw new CliError("No actions provided. Use --actions-json or --action with required flags.", 2, {
      code: "MISSING_ACTIONS",
      category: "validation",
      remediation: "Provide --actions-json or --action/--file-path/--content.",
    });
  }

  return merged.map((action, index) => normalizeAction(action, index));
}

async function summarizeActions(client, repo, branch, actions, options = {}) {
  const maxChars = Number(options.maxChars || DEFAULT_DIFF_MAX_CHARS);
  const maxLines = Number(options.maxLines || DEFAULT_DIFF_MAX_LINES);
  const summary = [];

  for (const action of actions) {
    const item = {
      action: action.action,
      file_path: action.file_path,
    };

    try {
      const existing = await client.getFile({
        projectId: repo.id,
        filePath: action.file_path,
        ref: branch,
      });
      item.existsOnBranch = true;
      item.previousSize = existing.size;
      item.previousLastCommitId = existing.last_commit_id;
      item.previousContent = decodeBase64(existing.content);
    } catch (err) {
      if (err instanceof CliError && err.details?.status === 404) {
        item.existsOnBranch = false;
        item.previousContent = "";
      } else {
        throw err;
      }
    }

    if (action.action !== "delete") {
      item.newSize = action.content.length;
      item.proposedContent = action.content;
    }

    const oldText = item.previousContent || "";
    const newText = action.action === "delete" ? "" : String(item.proposedContent || "");
    const preview = renderDiffPreview({ oldText, newText, maxChars, maxLines });
    item.diffPreview = preview;

    delete item.previousContent;
    delete item.proposedContent;

    summary.push(item);
  }

  return summary;
}

function guardDefaultBranchMutation(branch, defaultBranch) {
  if (String(branch) !== String(defaultBranch)) return;
  throw new CliError("Mutating the default branch is blocked by safety policy.", 2, {
    code: "DEFAULT_BRANCH_MUTATION_BLOCKED",
    category: "safety",
    remediation: "Create a new branch from default and open a merge request back to the default branch.",
    defaultBranch,
    branch,
  });
}

async function repoChangeApplyCommand(client, flags, output, context) {
  const operationMode = flags["operation-mode"] || "prepare";
  const repo = await requireResolvedRepo(client, flags, output, "repo change apply", operationMode);
  if (!repo) return;

  const branch = flags.branch || flags["source-branch"];
  requireFlag({ branch }, "branch", "Missing --branch for repo change apply.");

  const defaultBranch = repo.default_branch || "main";
  guardDefaultBranchMutation(branch, defaultBranch);

  const actions = collectActions(flags);
  const commitMessage = String(flags.message || flags["commit-message"] || "Apply repository changes");
  const actionSummary = await summarizeActions(client, repo, branch, actions, {
    maxChars: flags["diff-max-chars"],
    maxLines: flags["diff-max-lines"],
  });

  const payload = {
    repoId: repo.id,
    repoPath: repo.path_with_namespace,
    branch,
    defaultBranch,
    commitMessage,
    actions,
  };
  const contextKey = repoContextKey(client, repo);

  if (operationMode === "prepare") {
    output.print({
      mode: "success",
      command: "repo change apply",
      operationMode,
      result: {
        planSummary: {
          branch,
          defaultBranch,
          commitMessage,
          actionCount: actions.length,
          actions: actionSummary.map((item) => ({
            action: item.action,
            file_path: item.file_path,
            existsOnBranch: item.existsOnBranch,
            previousSize: item.previousSize,
            newSize: item.newSize,
          })),
        },
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
      },
      warnings: [],
      nextSteps: ["Run with --operation-mode show-changes."],
    });
    return;
  }

  if (operationMode === "show-changes") {
    const token = issuePreviewToken({
      command: "repo change apply",
      repoDir: contextKey,
      payload,
      invocationCwd: context.invocationCwd,
    });

    output.print({
      mode: "success",
      command: "repo change apply",
      operationMode,
      result: {
        changeSummary: {
          branch,
          defaultBranch,
          commitMessage,
          actionCount: actions.length,
          actions: actionSummary,
        },
        previewToken: token.previewToken,
        previewTokenExpiresAt: token.previewTokenExpiresAt,
        intentHash: token.intentHash,
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
      },
      warnings: [],
      nextSteps: ["Request explicit human approval, then run finalize with --preview-token and --human-approval-obtained."],
    });
    return;
  }

  if (operationMode === "finalize") {
    verifyFinalize({
      command: "repo change apply",
      repoDir: contextKey,
      payload,
      previewToken: flags["preview-token"],
      humanApprovalObtained: Boolean(flags["human-approval-obtained"]),
      invocationCwd: context.invocationCwd,
    });

    const idempotencyKey = flags["idempotency-key"];
    if (idempotencyKey && hasKey(idempotencyKey, context.invocationCwd)) {
      throw new CliError("Idempotency key already consumed.", 3, {
        code: "IDEMPOTENCY_KEY_REUSED",
        category: "approval",
        remediation: "Use a new --idempotency-key or inspect prior finalize result.",
      });
    }

    const commit = await client.createCommit({
      projectId: repo.id,
      branch,
      commitMessage,
      actions,
    });

    consumeKey(
      idempotencyKey,
      {
        command: "repo change apply",
        repo: repo.path_with_namespace,
        branch,
        commitId: commit.id,
      },
      context.invocationCwd
    );

    output.print({
      mode: "success",
      command: "repo change apply",
      operationMode,
      result: {
        committed: true,
        repo: {
          id: repo.id,
          path_with_namespace: repo.path_with_namespace,
        },
        branch,
        defaultBranch,
        commit: {
          id: commit.id,
          short_id: commit.short_id,
          title: commit.title,
          message: commit.message,
          web_url: commit.web_url,
          created_at: commit.created_at,
        },
        actions: actionSummary,
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
      },
      warnings: [],
      nextSteps: ["Create a merge request from this branch into the default branch."],
    });
    return;
  }

  throw new CliError(`Unsupported operation mode '${operationMode}' for repo change apply.`, 2, {
    code: "INVALID_OPERATION_MODE",
    category: "validation",
    remediation: "Use prepare, show-changes, or finalize.",
  });
}

module.exports = {
  repoChangeApplyCommand,
};