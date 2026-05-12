const { resolveRepoTarget } = require("../repoTarget");

async function requireResolvedRepo(client, flags, output, command, operationMode = null) {
  const resolved = await resolveRepoTarget(client, flags);
  if (resolved.status === "resolved") {
    return resolved.repo;
  }

  output.print({
    mode: "success",
    command,
    operationMode,
    result: resolved,
    metadata: {
      gitlabBaseUrl: client.baseUrl,
    },
    warnings: ["No mutation performed."],
    nextSteps: [resolved.instruction || "Rerun with an exact repository selector."],
  });

  return null;
}

function repoContextKey(client, repo) {
  return `${client.baseUrl}::${repo.path_with_namespace}`;
}

module.exports = {
  requireResolvedRepo,
  repoContextKey,
};