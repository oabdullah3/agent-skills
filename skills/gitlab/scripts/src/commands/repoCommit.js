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

function collectCommitState(repoDir) {
  const status = runGit(["status", "--porcelain"], repoDir).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  const staged = status.filter((l) => l[0] !== " " && l[0] !== "?");
  const unstaged = status.filter((l) => l[1] !== " " || l.startsWith("??"));
  return { status, staged, unstaged };
}

async function repoCommitCommand(flags, output, context) {
  const operationMode = flags["operation-mode"] || "prepare";
  const resolved = resolveRepoDirFromFlags(flags, context.invocationCwd, context.runtimeBaseUrl);
  guardDefaultBranchMutation(resolved.repoDir);

  if (!flags.message) {
    throw new CliError("Missing --message for repo commit.", 2, {
      code: "MISSING_COMMIT_MESSAGE",
      category: "validation",
      remediation: "Provide commit message with --message.",
    });
  }

  const state = collectCommitState(resolved.repoDir);
  const payload = {
    message: flags.message,
    stageAll: Boolean(flags["stage-all"]),
    stagedCount: state.staged.length,
    unstagedCount: state.unstaged.length,
  };

  if (operationMode === "prepare") {
    output.print({
      mode: "success",
      command: "repo commit",
      operationMode,
      result: {
        repoDir: resolved.repoDir,
        planSummary: {
          message: flags.message,
          stageAll: Boolean(flags["stage-all"]),
          stagedCount: state.staged.length,
          unstagedCount: state.unstaged.length,
        },
      },
      metadata: { gitlabBaseUrl: context.runtimeBaseUrl },
      warnings: state.status.length === 0 ? ["No local changes detected."] : [],
      nextSteps: ["Run with --operation-mode show-changes."],
    });
    return;
  }

  if (operationMode === "show-changes") {
    const token = issuePreviewToken({
      command: "repo commit",
      repoDir: resolved.repoDir,
      payload,
      invocationCwd: context.invocationCwd,
    });

    output.print({
      mode: "success",
      command: "repo commit",
      operationMode,
      result: {
        repoDir: resolved.repoDir,
        changeSummary: {
          message: flags.message,
          staged: state.staged,
          unstaged: state.unstaged,
        },
        previewToken: token.previewToken,
        previewTokenExpiresAt: token.previewTokenExpiresAt,
        intentHash: token.intentHash,
      },
      metadata: { gitlabBaseUrl: context.runtimeBaseUrl },
      warnings: [],
      nextSteps: ["Request explicit human approval, then run finalize with --preview-token and --human-approval-obtained."],
    });
    return;
  }

  if (operationMode === "finalize") {
    verifyFinalize({
      command: "repo commit",
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

    if (flags["stage-all"]) {
      runGit(["add", "-A"], resolved.repoDir);
    }

    const refreshed = collectCommitState(resolved.repoDir);
    if (refreshed.staged.length === 0) {
      throw new CliError("No staged changes to commit. Use --stage-all or stage files manually.", 2, {
        code: "NO_STAGED_CHANGES",
        category: "validation",
        remediation: "Stage changes and rerun finalize.",
      });
    }

    runGit(["commit", "-m", flags.message], resolved.repoDir);
    const head = runGit(["rev-parse", "HEAD"], resolved.repoDir).stdout.trim();

    consumeKey(idempotencyKey, { command: "repo commit", repoDir: resolved.repoDir, head }, context.invocationCwd);

    output.print({
      mode: "success",
      command: "repo commit",
      operationMode,
      result: {
        committed: true,
        repoDir: resolved.repoDir,
        head,
      },
      metadata: { gitlabBaseUrl: context.runtimeBaseUrl },
      warnings: [],
      nextSteps: ["Run repo push workflow to publish this commit."],
    });
    return;
  }

  throw new CliError(`Unsupported operation mode '${operationMode}' for repo commit.`, 2, {
    code: "INVALID_OPERATION_MODE",
    category: "validation",
    remediation: "Use prepare, show-changes, or finalize.",
  });
}

module.exports = {
  repoCommitCommand,
};
