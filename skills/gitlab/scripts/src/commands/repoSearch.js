async function repoSearchCommand(client, flags, output) {
  const query = flags.query || "";
  const items = await client.searchRepos({
    query,
    membership: flags.membership ? true : undefined,
    minAccessLevel: flags["min-access-level"],
    perPage: flags["max-results"] || 20,
    page: flags.page || 1,
  });

  output.print({
    mode: "success",
    command: "repo search",
    operationMode: flags["operation-mode"] || "search",
    result: {
      count: items.length,
      items: items.map((p) => ({
        id: p.id,
        path_with_namespace: p.path_with_namespace,
        default_branch: p.default_branch,
        visibility: p.visibility,
        ssh_url_to_repo: p.ssh_url_to_repo,
        http_url_to_repo: p.http_url_to_repo,
        web_url: p.web_url,
        last_activity_at: p.last_activity_at,
      })),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
      query,
    },
    warnings: [],
    nextSteps: [],
  });
}

module.exports = {
  repoSearchCommand,
};
