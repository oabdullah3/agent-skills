const { CliError } = require("./errors");

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  const value = String(baseUrl).trim().replace(/\/+$/, "");
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

function normalizeRepoPath(repoPath) {
  return String(repoPath || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");
}

function extractRepoPathFromOrigin(originUrl, runtimeBaseUrl) {
  if (!originUrl) return null;

  const httpMatch = originUrl.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/i);
  if (httpMatch) return normalizeRepoPath(httpMatch[1]);

  const sshMatch = originUrl.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/i);
  if (sshMatch) return normalizeRepoPath(sshMatch[1]);

  if (runtimeBaseUrl && originUrl.startsWith(runtimeBaseUrl)) {
    return normalizeRepoPath(originUrl.slice(runtimeBaseUrl.length));
  }

  return null;
}

function canonicalRepoKey(baseUrl, repoPath) {
  const base = normalizeBaseUrl(baseUrl);
  const path = normalizeRepoPath(repoPath).toLowerCase();
  return `${base}::${path}`;
}

class GitLabClient {
  constructor({ baseUrl, token }) {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    if (!normalizedBase) {
      throw new CliError("Missing or invalid runtime --gitlab-base-url.", 2, {
        code: "MISSING_RUNTIME_BASE_URL",
        category: "validation",
        remediation: "Provide --gitlab-base-url https://gitlab.example.com",
      });
    }
    this.baseUrl = normalizedBase;
    this.token = token;
  }

  async request(pathname, query = {}, options = {}) {
    const url = new URL(`${this.baseUrl}/api/v4${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const method = options.method || "GET";
    const headers = {
      "PRIVATE-TOKEN": this.token,
      Accept: "application/json",
      ...(options.headers || {}),
    };

    const init = {
      method,
      headers,
    };

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), init);

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch (_) {
        body = "";
      }
      throw new CliError(`GitLab API request failed (${response.status}).`, 2, {
        code: "GITLAB_API_FAILED",
        category: "http",
        remediation: "Verify runtime base URL, token scope, and target visibility.",
        status: response.status,
        body: body.slice(0, 500),
      });
    }

    if (response.status === 204) return null;

    if (options.responseType === "text") {
      return response.text();
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  async currentUser() {
    return this.request("/user");
  }

  async searchRepos({ query, membership, minAccessLevel, perPage = 20, page = 1 }) {
    return this.request("/projects", {
      search: query,
      membership,
      min_access_level: minAccessLevel,
      simple: true,
      per_page: perPage,
      page,
      order_by: "last_activity_at",
      sort: "desc",
    });
  }

  async getRepoById(id) {
    return this.request(`/projects/${encodeURIComponent(String(id))}`);
  }

  async getRepoByPath(repoPath) {
    return this.request(`/projects/${encodeURIComponent(normalizeRepoPath(repoPath))}`);
  }

  async getFile({ projectId, filePath, ref }) {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodeURIComponent(String(filePath))}`,
      { ref }
    );
  }

  async listRepositoryTree({ projectId, path, ref, recursive = true, perPage = 100, page = 1 }) {
    return this.request(`/projects/${encodeURIComponent(String(projectId))}/repository/tree`, {
      path,
      ref,
      recursive: recursive ? true : undefined,
      per_page: perPage,
      page,
    });
  }

  async createCommit({ projectId, branch, commitMessage, actions }) {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/repository/commits`,
      {},
      {
        method: "POST",
        body: {
          branch,
          commit_message: commitMessage,
          actions,
        },
      }
    );
  }

  async listBranches({ projectId, search, perPage = 20, page = 1 }) {
    return this.request(`/projects/${encodeURIComponent(String(projectId))}/repository/branches`, {
      search,
      per_page: perPage,
      page,
    });
  }

  async createBranch({ projectId, branch, ref }) {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/repository/branches`,
      {},
      {
        method: "POST",
        body: { branch, ref },
      }
    );
  }

  async listMergeRequests({ projectId, state = "opened", sourceBranch, targetBranch, perPage = 20, page = 1 }) {
    return this.request(`/projects/${encodeURIComponent(String(projectId))}/merge_requests`, {
      state,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      per_page: perPage,
      page,
      order_by: "updated_at",
      sort: "desc",
    });
  }

  async getMergeRequest({ projectId, iid }) {
    return this.request(`/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(iid))}`);
  }

  async getMergeRequestDiffs({ projectId, iid }) {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(iid))}/diffs`
    );
  }

  async compareBranches({ projectId, from, to, straight = false }) {
    return this.request(`/projects/${encodeURIComponent(String(projectId))}/repository/compare`, {
      from,
      to,
      straight: straight ? true : undefined,
    });
  }

  async createMergeRequest({ projectId, sourceBranch, targetBranch, title, description, draft }) {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests`,
      {},
      {
        method: "POST",
        body: {
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title,
          description,
          draft: Boolean(draft),
        },
      }
    );
  }
}

module.exports = {
  GitLabClient,
  normalizeBaseUrl,
  normalizeRepoPath,
  extractRepoPathFromOrigin,
  canonicalRepoKey,
};
