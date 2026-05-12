const { requireResolvedRepo } = require("./repoResolve");

function toNeedle(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesNeedle(item, needle) {
  if (!needle) return true;
  const path = String(item.path || "").toLowerCase();
  const name = String(item.name || "").toLowerCase();
  return path.includes(needle) || name.includes(needle);
}

async function repoFileSearchCommand(client, flags, output) {
  const repo = await requireResolvedRepo(client, flags, output, "repo file search", "search");
  if (!repo) return;

  const ref = flags.ref || repo.default_branch || "main";
  const recursive = flags.recursive !== undefined ? Boolean(flags.recursive) : true;
  const perPage = Math.min(Number(flags["max-results"] || 100), 100);
  const pathPrefix = flags.path || "";
  const query = String(flags.query || flags.name || "").trim();
  const needle = toNeedle(query);

  const tree = await client.listRepositoryTree({
    projectId: repo.id,
    path: pathPrefix || undefined,
    ref,
    recursive,
    perPage,
    page: flags.page || 1,
  });

  const items = (Array.isArray(tree) ? tree : [])
    .filter((item) => item.type === "blob")
    .filter((item) => matchesNeedle(item, needle))
    .slice(0, Number(flags["max-results"] || 50));

  output.print({
    mode: "success",
    command: "repo file search",
    operationMode: "search",
    result: {
      repo: {
        id: repo.id,
        path_with_namespace: repo.path_with_namespace,
      },
      ref,
      query,
      count: items.length,
      files: items.map((item) => ({
        path: item.path,
        name: item.name,
        id: item.id,
      })),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
      recursive,
      pathPrefix,
    },
    warnings: query ? [] : ["No query provided; returning files from repository tree scope."],
    nextSteps: items.length === 0 ? ["Rerun with a different --query or --path."] : [],
  });
}

module.exports = {
  repoFileSearchCommand,
};