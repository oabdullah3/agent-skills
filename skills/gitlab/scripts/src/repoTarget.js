const { CliError } = require("./errors");
const { normalizeRepoPath } = require("./gitlabClient");

function repoPathFromUrl(url, expectedBaseUrl) {
  try {
    const parsed = new URL(url);
    const base = new URL(expectedBaseUrl);
    if (parsed.host !== base.host) {
      throw new CliError("--repo-url host does not match --gitlab-base-url host.", 2, {
        code: "REPO_URL_HOST_MISMATCH",
        category: "validation",
        remediation: "Use repo URL from the same GitLab host as --gitlab-base-url.",
      });
    }
    return normalizeRepoPath(parsed.pathname);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("Invalid --repo-url.", 2, {
      code: "INVALID_REPO_URL",
      category: "validation",
      remediation: "Pass a valid GitLab repository URL.",
    });
  }
}

async function resolveRepoTarget(client, flags) {
  const selectors = ["repo-id", "repo-path", "repo-url", "query"].filter((k) => Boolean(flags[k]));
  if (selectors.length !== 1) {
    throw new CliError("Provide exactly one selector: --repo-id | --repo-path | --repo-url | --query.", 2, {
      code: "INTERCHANGEABLE_SELECTOR_ERROR",
      category: "validation",
      remediation: "Use one selector flag only.",
    });
  }

  if (flags["repo-id"]) {
    const repo = await client.getRepoById(flags["repo-id"]);
    return {
      status: "resolved",
      repo,
      selector: "repo-id",
    };
  }

  if (flags["repo-path"]) {
    const repo = await client.getRepoByPath(flags["repo-path"]);
    return {
      status: "resolved",
      repo,
      selector: "repo-path",
    };
  }

  if (flags["repo-url"]) {
    const path = repoPathFromUrl(flags["repo-url"], client.baseUrl);
    const repo = await client.getRepoByPath(path);
    return {
      status: "resolved",
      repo,
      selector: "repo-url",
    };
  }

  const query = flags.query;
  const items = await client.searchRepos({
    query,
    membership: flags.membership ? true : undefined,
    minAccessLevel: flags["min-access-level"],
    perPage: flags["max-results"] || 20,
    page: 1,
  });

  if (!Array.isArray(items) || items.length === 0) {
    return {
      status: "no-match",
      selector: "query",
      candidates: [],
      instruction: "No repository matched query. Rerun with a narrower or different query.",
    };
  }

  if (items.length > 1) {
    return {
      status: "ambiguous",
      selector: "query",
      candidates: items.map((p) => ({
        id: p.id,
        path_with_namespace: p.path_with_namespace,
        default_branch: p.default_branch,
        web_url: p.web_url,
      })),
      instruction: "Rerun with --repo-id or exact --repo-path.",
    };
  }

  return {
    status: "resolved",
    selector: "query",
    repo: items[0],
  };
}

module.exports = {
  resolveRepoTarget,
};
