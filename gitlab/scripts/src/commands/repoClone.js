const path = require("path");
const { runGit } = require("../gitRunner");
const { resolveRepoTarget } = require("../repoTarget");
const { resolveCloneRoot, resolveExistingRepo, determineTargetDir, rememberRepo } = require("../repoIndex");

async function repoCloneCommand(client, flags, output, context) {
  const resolved = await resolveRepoTarget(client, flags);
  if (resolved.status !== "resolved") {
    output.print({
      mode: "success",
      command: "repo clone",
      operationMode: flags["operation-mode"] || "resolve",
      result: resolved,
      metadata: { gitlabBaseUrl: client.baseUrl },
      warnings: ["No clone performed."],
      nextSteps: [resolved.instruction || "Rerun with exact selector."],
    });
    return;
  }

  const repo = resolved.repo;
  const repoPath = repo.path_with_namespace;
  const cloneRoot = path.resolve(flags.dest || resolveCloneRoot(flags, context.invocationCwd));

  const existing = resolveExistingRepo({
    invocationCwd: context.invocationCwd,
    cloneRoot,
    runtimeBaseUrl: client.baseUrl,
    repoPath,
  });

  if (existing) {
    output.print({
      mode: "success",
      command: "repo clone",
      operationMode: null,
      result: {
        reusedExisting: true,
        repoDir: existing.repoDir,
        cloneRoot,
        canonicalRepoKey: existing.canonicalRepoKey,
        detectionSource: existing.detectionSource,
      },
      metadata: {
        gitlabBaseUrl: client.baseUrl,
        repoPath,
      },
      warnings: [],
      nextSteps: [],
    });
    return;
  }

  const targetDir = determineTargetDir(cloneRoot, client.baseUrl, repoPath);
  try {
    runGit(["clone", repo.http_url_to_repo, targetDir], context.invocationCwd, {
      env: Object.assign({}, process.env, context.gitEnv || {}),
    });
  } catch (err) {
    if (err.message.includes("certificate verification failed") || err.message.includes("SSL certificate problem") || err.message.includes("CAfile:")) {
      throw new Error(
        "GitLab TLS Verification Failed.\n" +
        "You MUST provide the GitLab CA Certificate to the CLI to clone this repository securely.\n" +
        "Add CREDENTIAL_3 (the Base64 or PEM certificate bundle) to your OpenClaw JSON credentials or .env file.\n" +
        "DO NOT use GIT_SSL_NO_VERIFY=1 or insecure modes."
      );
    }
    if (context.flags && context.flags.debug) {
      throw err;
    }
    throw new Error(
      "Unable to clone repository. " + (err.message || "").substring(0, 100) +
      "... Please check your access or contact support."
    );
  }
  const canonicalRepoKey = rememberRepo({
    invocationCwd: context.invocationCwd,
    runtimeBaseUrl: client.baseUrl,
    repoPath,
    repoDir: targetDir,
  });

  output.print({
    mode: "success",
    command: "repo clone",
    operationMode: null,
    result: {
      reusedExisting: false,
      repoDir: targetDir,
      cloneRoot,
      canonicalRepoKey,
      detectionSource: "fresh-clone",
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
      repoPath,
    },
    warnings: [],
    nextSteps: [],
  });
}

module.exports = {
  repoCloneCommand,
};
