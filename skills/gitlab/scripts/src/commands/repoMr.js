const { requireFlag } = require("../flagValidator");
const { issuePreviewToken, verifyFinalize } = require("../mutationWorkflow");
const { hasKey, consumeKey } = require("../idempotencyStore");
const { CliError } = require("../errors");
const { requireResolvedRepo, repoContextKey } = require("./repoResolve");

const DEFAULT_MR_DIFF_MAX_FILES = 30;
const DEFAULT_MR_DIFF_MAX_CHARS = 4000;

function limitText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n...<truncated>`,
    truncated: true,
  };
}

async function buildMrChangeSummary(client, repo, payload, flags) {
  const compare = await client.compareBranches({
    projectId: repo.id,
    from: payload.targetBranch,
    to: payload.sourceBranch,
    straight: true,
  });

  const maxFiles = Number(flags["diff-max-files"] || DEFAULT_MR_DIFF_MAX_FILES);
  const maxChars = Number(flags["diff-max-chars"] || DEFAULT_MR_DIFF_MAX_CHARS);
  const diffs = Array.isArray(compare?.diffs) ? compare.diffs : [];

  return {
    commitsCount: Array.isArray(compare?.commits) ? compare.commits.length : 0,
    fileCount: diffs.length,
    files: diffs.slice(0, maxFiles).map((d) => {
      const capped = limitText(d.diff || "", maxChars);
      return {
        old_path: d.old_path,
        new_path: d.new_path,
        new_file: Boolean(d.new_file),
        deleted_file: Boolean(d.deleted_file),
        renamed_file: Boolean(d.renamed_file),
        too_large: Boolean(d.too_large),
        diff: capped.text,
        diffTruncated: capped.truncated,
      };
    }),
    filesTruncated: diffs.length > maxFiles,
    compareTimeout: Boolean(compare?.compare_timeout),
    compareSameRef: Boolean(compare?.compare_same_ref),
  };
}

function summarizeMr(mr) {
  return {
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    draft: Boolean(mr.draft),
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    web_url: mr.web_url,
    created_at: mr.created_at,
    updated_at: mr.updated_at,
    merge_status: mr.merge_status,
    detailed_merge_status: mr.detailed_merge_status,
    has_conflicts: Boolean(mr.has_conflicts),
    author: mr.author
      ? {
          id: mr.author.id,
          username: mr.author.username,
          name: mr.author.name,
        }
      : null,
  };
}

async function repoMrListCommand(client, flags, output) {
  const repo = await requireResolvedRepo(client, flags, output, "repo mr list", "list");
  if (!repo) return;

  const mrs = await client.listMergeRequests({
    projectId: repo.id,
    state: flags.state || "opened",
    sourceBranch: flags["source-branch"],
    targetBranch: flags["target-branch"],
    perPage: flags["max-results"] || 20,
    page: flags.page || 1,
  });

  output.print({
    mode: "success",
    command: "repo mr list",
    operationMode: "list",
    result: {
      repo: {
        id: repo.id,
        path_with_namespace: repo.path_with_namespace,
      },
      count: mrs.length,
      mergeRequests: mrs.map(summarizeMr),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
      state: flags.state || "opened",
    },
    warnings: [],
    nextSteps: [],
  });
}

async function repoMrShowCommand(client, flags, output) {
  requireFlag(flags, "mr-iid", "Missing --mr-iid for repo mr show.");
  const repo = await requireResolvedRepo(client, flags, output, "repo mr show", "read");
  if (!repo) return;

  const mr = await client.getMergeRequest({
    projectId: repo.id,
    iid: flags["mr-iid"],
  });

  output.print({
    mode: "success",
    command: "repo mr show",
    operationMode: "read",
    result: {
      repo: {
        id: repo.id,
        path_with_namespace: repo.path_with_namespace,
      },
      mergeRequest: summarizeMr(mr),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
    },
    warnings: [],
    nextSteps: [],
  });
}

async function repoMrDiffCommand(client, flags, output) {
  requireFlag(flags, "mr-iid", "Missing --mr-iid for repo mr diff.");
  const repo = await requireResolvedRepo(client, flags, output, "repo mr diff", "read");
  if (!repo) return;

  const diffs = await client.getMergeRequestDiffs({
    projectId: repo.id,
    iid: flags["mr-iid"],
  });

  output.print({
    mode: "success",
    command: "repo mr diff",
    operationMode: "read",
    result: {
      repo: {
        id: repo.id,
        path_with_namespace: repo.path_with_namespace,
      },
      count: Array.isArray(diffs) ? diffs.length : 0,
      diffs: (Array.isArray(diffs) ? diffs : []).map((d) => ({
        old_path: d.old_path,
        new_path: d.new_path,
        new_file: Boolean(d.new_file),
        deleted_file: Boolean(d.deleted_file),
        renamed_file: Boolean(d.renamed_file),
        too_large: Boolean(d.too_large),
        diff: d.diff,
      })),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
    },
    warnings: [],
    nextSteps: [],
  });
}

async function repoMrCreateCommand(client, flags, output, context) {
  const operationMode = flags["operation-mode"] || "prepare";
  requireFlag(flags, "source-branch", "Missing --source-branch for repo mr create.");
  requireFlag(flags, "title", "Missing --title for repo mr create.");

  const repo = await requireResolvedRepo(client, flags, output, "repo mr create", operationMode);
  if (!repo) return;

  if (flags.approve || flags["approve-mr"] || flags["approval-action"]) {
    throw new CliError("Merge request approval actions are unsupported by this CLI.", 2, {
      code: "MR_APPROVAL_UNSUPPORTED",
      category: "policy",
      remediation: "Use your normal review/approval process in GitLab after MR creation.",
    });
  }

  const defaultBranch = repo.default_branch || "main";
  const sourceBranch = String(flags["source-branch"]);
  const targetBranch = String(flags["target-branch"] || defaultBranch);

  if (sourceBranch === defaultBranch) {
    throw new CliError("Source branch cannot be the default branch for MR creation.", 2, {
      code: "SOURCE_DEFAULT_BRANCH_BLOCKED",
      category: "safety",
      remediation: "Create a new feature branch from default, apply changes there, then open the MR into default.",
    });
  }

  if (targetBranch !== defaultBranch) {
    throw new CliError("Target branch must be the repository default branch for MR creation.", 2, {
      code: "TARGET_BRANCH_NOT_DEFAULT",
      category: "safety",
      remediation: `Use --target-branch ${defaultBranch} and open feature-branch changes into default.`,
      defaultBranch,
      targetBranch,
    });
  }

  const payload = {
    repoId: repo.id,
    repoPath: repo.path_with_namespace,
    sourceBranch,
    targetBranch,
    defaultBranch,
    title: flags.title,
    description: flags.description || "",
    draft: flags.draft !== undefined ? Boolean(flags.draft) : true,
  };
  const contextKey = repoContextKey(client, repo);

  if (operationMode === "prepare") {
    output.print({
      mode: "success",
      command: "repo mr create",
      operationMode,
      result: {
        planSummary: payload,
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
    const diffSummary = await buildMrChangeSummary(client, repo, payload, flags);
    const token = issuePreviewToken({
      command: "repo mr create",
      repoDir: contextKey,
      payload,
      invocationCwd: context.invocationCwd,
    });

    output.print({
      mode: "success",
      command: "repo mr create",
      operationMode,
      result: {
        changeSummary: {
          ...payload,
          diffSummary,
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
      command: "repo mr create",
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

    const mr = await client.createMergeRequest({
      projectId: repo.id,
      sourceBranch: payload.sourceBranch,
      targetBranch: payload.targetBranch,
      title: payload.title,
      description: payload.description,
      draft: payload.draft,
    });

    consumeKey(
      idempotencyKey,
      {
        command: "repo mr create",
        repo: repo.path_with_namespace,
        mrIid: mr.iid,
      },
      context.invocationCwd
    );

    output.print({
      mode: "success",
      command: "repo mr create",
      operationMode,
      result: {
        created: true,
        repo: {
          id: repo.id,
          path_with_namespace: repo.path_with_namespace,
        },
        mergeRequest: summarizeMr(mr),
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
      },
      warnings: [],
      nextSteps: ["Share the merge request with reviewers for approval and merge."],
    });
    return;
  }

  throw new CliError(`Unsupported operation mode '${operationMode}' for repo mr create.`, 2, {
    code: "INVALID_OPERATION_MODE",
    category: "validation",
    remediation: "Use prepare, show-changes, or finalize.",
  });
}

module.exports = {
  repoMrListCommand,
  repoMrShowCommand,
  repoMrDiffCommand,
  repoMrCreateCommand,
};