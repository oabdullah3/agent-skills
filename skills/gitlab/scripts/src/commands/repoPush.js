const { CliError } = require("../errors");
const { runGit } = require("../gitRunner");
const { resolveRepoDirFromFlags } = require("../workspaceResolver");
const { issuePreviewToken, verifyFinalize } = require("../mutationWorkflow");
const { hasKey, consumeKey } = require("../idempotencyStore");

function currentBranchName(repoDir) {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).stdout.trim();
}

function defaultBranchName(repoDir) {
  const result = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repoDir, { allowFailure: true });
  if (result.status !== 0) return null;
  const ref = result.stdout.trim();
  const parts = ref.split("/");
  return parts[parts.length - 1] || null;
}

function guardDefaultBranchMutation(repoDir) {
  const current = currentBranchName(repoDir);
  const defaultBranch = defaultBranchName(repoDir);
  if (!defaultBranch || current !== defaultBranch) return;

  throw new CliError("Mutating the default branch is blocked by safety policy.", 2, {
    code: "DEFAULT_BRANCH_MUTATION_BLOCKED",
    category: "safety",
    remediation: "Create a new branch from default and open a merge request back to the default branch.",
    defaultBranch,
    branch: current,
  });
}

function collectPushState(repoDir) {
  const branchLine = runGit(["status", "--porcelain", "--branch"], repoDir).stdout
    .split(/\r?\n/)
    .find((l) => l.startsWith("##"));

  const branch = (branchLine || "").replace(/^##\s*/, "").trim();
  const aheadMatch = branch.match(/ahead\s+(\d+)/i);
  const behindMatch = branch.match(/behind\s+(\d+)/i);

  let upstream = null;
  const upstreamResult = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoDir, {
    allowFailure: true,
  });
  if (upstreamResult.status === 0) upstream = upstreamResult.stdout.trim();

  return {
    branch,
    upstream,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

async function repoPushCommand(flags, output, context) {
  const operationMode = flags["operation-mode"] || "prepare";
  const resolved = resolveRepoDirFromFlags(flags, context.invocationCwd, context.runtimeBaseUrl);
  guardDefaultBranchMutation(resolved.repoDir);
  const state = collectPushState(resolved.repoDir);

  const payload = {
    branch: state.branch,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    remote: flags.remote || "origin",
  };

  if (operationMode === "prepare") {
    output.print({
      mode: "success",
      command: "repo push",
      operationMode,
      result: {
        repoDir: resolved.repoDir,
        planSummary: payload,
      },
      metadata: { gitlabBaseUrl: context.runtimeBaseUrl },
      warnings: state.upstream ? [] : ["No upstream branch is configured."],
      nextSteps: ["Run with --operation-mode show-changes."],
    });
    return;
  }

  if (operationMode === "show-changes") {
    const token = issuePreviewToken({
      command: "repo push",
      repoDir: resolved.repoDir,
      payload,
      invocationCwd: context.invocationCwd,
    });

    output.print({
      mode: "success",
      command: "repo push",
      operationMode,
      result: {
        repoDir: resolved.repoDir,
        changeSummary: payload,
        previewToken: token.previewToken,
        previewTokenExpiresAt: token.previewTokenExpiresAt,
        intentHash: token.intentHash,
      },
      metadata: { gitlabBaseUrl: context.runtimeBaseUrl },
      warnings: state.behind > 0 ? ["Local branch is behind upstream; push may fail until pulled/rebased."] : [],
      nextSteps: ["Request explicit human approval, then run finalize with --preview-token and --human-approval-obtained."],
    });
    return;
  }

  if (operationMode === "finalize") {
    verifyFinalize({
      command: "repo push",
      repoDir: resolved.repoDir,
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

    if (!state.upstream) {
      throw new CliError("Cannot push without upstream tracking branch.", 2, {
        code: "MISSING_UPSTREAM",
        category: "validation",
        remediation: "Set upstream branch or pass explicit push refs in a future supported mode.",
      });
    }

    if (state.behind > 0) {
      throw new CliError("Push blocked: local branch is behind upstream.", 2, {
        code: "PUSH_BLOCKED_BEHIND_UPSTREAM",
        category: "safety",
        remediation: "Pull/rebase and rerun staged push workflow.",
      });
    }

    runGit(["push", flags.remote || "origin"], resolved.repoDir, {
      env: context.gitEnv || {},
    });
    const after = collectPushState(resolved.repoDir);

    consumeKey(idempotencyKey, { command: "repo push", repoDir: resolved.repoDir, after }, context.invocationCwd);

    output.print({
      mode: "success",
      command: "repo push",
      operationMode,
      result: {
        pushed: true,
        repoDir: resolved.repoDir,
        postPushState: after,
      },
      metadata: { gitlabBaseUrl: context.runtimeBaseUrl },
      warnings: [],
      nextSteps: [],
    });
    return;
  }

  throw new CliError(`Unsupported operation mode '${operationMode}' for repo push.`, 2, {
    code: "INVALID_OPERATION_MODE",
    category: "validation",
    remediation: "Use prepare, show-changes, or finalize.",
  });
}

module.exports = {
  repoPushCommand,
};
