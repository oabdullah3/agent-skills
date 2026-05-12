const { requireFlag } = require("../flagValidator");
const { issuePreviewToken, verifyFinalize } = require("../mutationWorkflow");
const { hasKey, consumeKey } = require("../idempotencyStore");
const { CliError } = require("../errors");
const { requireResolvedRepo, repoContextKey } = require("./repoResolve");

async function repoBranchListCommand(client, flags, output) {
  const repo = await requireResolvedRepo(client, flags, output, "repo branch list", "list");
  if (!repo) return;

  const branches = await client.listBranches({
    projectId: repo.id,
    search: flags.search,
    perPage: flags["max-results"] || 20,
    page: flags.page || 1,
  });

  output.print({
    mode: "success",
    command: "repo branch list",
    operationMode: "list",
    result: {
      repo: {
        id: repo.id,
        path_with_namespace: repo.path_with_namespace,
      },
      count: branches.length,
      branches: branches.map((b) => ({
        name: b.name,
        merged: Boolean(b.merged),
        protected: Boolean(b.protected),
        default: Boolean(b.default),
        can_push: Boolean(b.can_push),
        web_url: b.web_url,
      })),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
      search: flags.search || "",
    },
    warnings: [],
    nextSteps: [],
  });
}

async function repoBranchCreateCommand(client, flags, output, context) {
  const operationMode = flags["operation-mode"] || "prepare";
  requireFlag(flags, "branch-name", "Missing --branch-name for repo branch create.");

  const repo = await requireResolvedRepo(client, flags, output, "repo branch create", operationMode);
  if (!repo) return;

  const fromRef = flags.ref || flags["from-ref"] || repo.default_branch || "main";
  const payload = {
    repoId: repo.id,
    repoPath: repo.path_with_namespace,
    branchName: flags["branch-name"],
    fromRef,
  };
  const contextKey = repoContextKey(client, repo);

  if (operationMode === "prepare" || operationMode === "show-changes") {
    const token = issuePreviewToken({
      command: "repo branch create",
      repoDir: contextKey,
      payload,
      invocationCwd: context.invocationCwd,
    });

    output.print({
      mode: "success",
      command: "repo branch create",
      operationMode: "prepare",
      result: {
        planSummary: payload,
        previewToken: token.previewToken,
        previewTokenExpiresAt: token.previewTokenExpiresAt,
        intentHash: token.intentHash,
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
      },
      warnings: operationMode === "show-changes" ? ["Branch create uses 2-step flow; show-changes is treated as prepare."] : [],
      nextSteps: ["Request explicit human approval, then run finalize with --preview-token and --human-approval-obtained."],
    });
    return;
  }

  if (operationMode === "finalize") {
    verifyFinalize({
      command: "repo branch create",
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

    const created = await client.createBranch({
      projectId: repo.id,
      branch: flags["branch-name"],
      ref: fromRef,
    });

    consumeKey(
      idempotencyKey,
      {
        command: "repo branch create",
        repo: repo.path_with_namespace,
        branch: created.name,
      },
      context.invocationCwd
    );

    output.print({
      mode: "success",
      command: "repo branch create",
      operationMode,
      result: {
        created: true,
        repo: {
          id: repo.id,
          path_with_namespace: repo.path_with_namespace,
        },
        branch: {
          name: created.name,
          default: Boolean(created.default),
          protected: Boolean(created.protected),
          can_push: Boolean(created.can_push),
          web_url: created.web_url,
        },
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
      },
      warnings: [],
      nextSteps: ["Use repo mr create to open a merge request from this branch."],
    });
    return;
  }

  throw new CliError(`Unsupported operation mode '${operationMode}' for repo branch create.`, 2, {
    code: "INVALID_OPERATION_MODE",
    category: "validation",
    remediation: "Use prepare, show-changes, or finalize.",
  });
}

module.exports = {
  repoBranchListCommand,
  repoBranchCreateCommand,
};