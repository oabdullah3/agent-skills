const { requestJson } = require("./http");
const fs = require("fs");
const path = require("path");

class JiraClient {
  constructor(credentials, options = {}) {
    this.cloudId = credentials.cloudId;
    this.email = credentials.email;
    this.token = credentials.token;
    this.retries = Number.isInteger(options.retries) ? options.retries : 2;
    this.retryDelayMs = Number.isInteger(options.retryDelayMs)
      ? options.retryDelayMs
      : 500;
    this.lastDiagnostics = null;
  }

  baseUrl(version = 3) {
    return `https://api.atlassian.com/ex/jira/${this.cloudId}/rest/api/${version}`;
  }

  authHeader() {
    const encoded = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    return `Basic ${encoded}`;
  }

  async api(version, endpoint, options = {}) {
    const headers = {
      Accept: "application/json",
      Authorization: this.authHeader(),
      ...(options.headers || {}),
    };

    try {
      const result = await requestJson(`${this.baseUrl(version)}${endpoint}`, {
        method: options.method || "GET",
        headers,
        body: options.body,
        retries: this.retries,
        retryDelayMs: this.retryDelayMs,
        timeoutMs: options.timeoutMs || 20000,
      });
      this.lastDiagnostics = result.diagnostics || null;
      return result;
    } catch (err) {
      this.lastDiagnostics = err?.diagnostics || null;
      throw err;
    }
  }

  consumeLastDiagnostics() {
    const d = this.lastDiagnostics;
    this.lastDiagnostics = null;
    return d;
  }

  async getMyself() {
    const endpoint = `/myself`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async getAssignableUsers(issueIdOrKey, startAt = 0, maxResults = 50) {
    const endpoint = `/user/assignable/search?issueKey=${encodeURIComponent(issueIdOrKey)}&startAt=${startAt}&maxResults=${maxResults}`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async searchProjects(query, startAt = 0, maxResults = 50) {
    const endpoint = `/project/search?query=${encodeURIComponent(query)}&startAt=${startAt}&maxResults=${maxResults}`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async getProjectComponents(projectIdOrKey) {
    const endpoint = `/project/${encodeURIComponent(projectIdOrKey)}/components`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async getIssueTypesForProject(projectId) {
    const endpoint = `/issuetype/project?projectId=${encodeURIComponent(projectId)}`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async searchIssuesJql(jql, maxResults = 50, fields = "summary", startAt = 0) {
    const endpoint = `/search/jql?startAt=${startAt}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}&jql=${encodeURIComponent(jql)}`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async getIssue(issueIdOrKey, version = 3, fields = "summary,description,version") {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}?fields=${encodeURIComponent(fields)}`;
    const res = await this.api(version, endpoint);
    return res.data;
  }

  async getIssueComments(issueIdOrKey, startAt = 0, maxResults = 50) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/comment?startAt=${startAt}&maxResults=${maxResults}`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async getIssueWorklogs(issueIdOrKey, startAt = 0, maxResults = 50, version = 3) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/worklog?startAt=${startAt}&maxResults=${maxResults}`;
    const res = await this.api(version, endpoint);
    return res.data;
  }

  async getIssueAttachments(issueIdOrKey, version = 3) {
    const data = await this.getIssue(issueIdOrKey, version, "attachment");
    return data?.fields?.attachment || [];
  }

  async checkPermissions(requirements, context = {}) {
    const required = Array.isArray(requirements) ? requirements : [];
    const uniquePermissionKeys = Array.from(new Set(required.map((item) => item.permissionKey).filter(Boolean)));

    if (uniquePermissionKeys.length === 0) {
      return {
        ok: true,
        checked: [],
        missing: [],
      };
    }

    const params = new URLSearchParams();
    params.set("permissions", uniquePermissionKeys.join(","));
    if (context.issueKey) params.set("issueKey", String(context.issueKey));
    if (context.projectKey) params.set("projectKey", String(context.projectKey));

    let permissionPayload;
    try {
      const endpoint = `/mypermissions?${params.toString()}`;
      const res = await this.api(3, endpoint);
      permissionPayload = res.data || {};
    } catch (_) {
      return {
        ok: true,
        checked: required.map((item) => ({ ...item, havePermission: null, checkStatus: "unknown" })),
        missing: [],
        checkStatus: "unknown",
      };
    }

    const permissionMap = permissionPayload.permissions || {};
    const checked = required.map((item) => {
      const node = permissionMap[item.permissionKey] || {};
      return {
        ...item,
        havePermission: Boolean(node.havePermission),
      };
    });

    const missing = checked.filter((item) => item.havePermission === false);

    return {
      ok: missing.length === 0,
      checked,
      missing,
      checkStatus: "checked",
    };
  }

  async getIssueTransitions(issueIdOrKey) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/transitions`;
    const res = await this.api(3, endpoint);
    return res.data;
  }

  async getIssueEditMeta(issueIdOrKey, version = 2) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/editmeta`;
    const res = await this.api(version, endpoint);
    return res.data;
  }

  async createIssue(fields) {
    const res = await this.api(3, "/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    return res.data;
  }

  async editIssue(issueIdOrKey, payload, version = 3) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}`;
    const res = await this.api(version, endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.data;
  }

  async addComment(issueIdOrKey, payload, version = 2) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/comment`;
    const res = await this.api(version, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.data;
  }

  async transitionIssue(issueIdOrKey, transitionId) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/transitions`;
    const res = await this.api(3, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transition: {
          id: transitionId,
        },
      }),
    });
    return res.data;
  }

  async assignIssue(issueIdOrKey, accountId) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/assignee`;
    const res = await this.api(3, endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: accountId,
      }),
    });
    return res.data;
  }

  async linkIssue(linkTypeName, inwardIssueKey, outwardIssueKey) {
    const endpoint = `/issueLink`;
    const res = await this.api(3, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: { name: linkTypeName },
        inwardIssue: { key: inwardIssueKey },
        outwardIssue: { key: outwardIssueKey },
      }),
    });
    return res.data;
  }

  async addWorklog(issueIdOrKey, payload, version = 2) {
    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/worklog`;
    const res = await this.api(version, endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.data;
  }

  async uploadAttachment(issueIdOrKey, filePath) {
    const form = new FormData();
    const content = fs.readFileSync(filePath);
    const blob = new Blob([content]);
    form.append("file", blob, path.basename(filePath));

    const endpoint = `/issue/${encodeURIComponent(issueIdOrKey)}/attachments`;
    const res = await this.api(3, endpoint, {
      method: "POST",
      headers: {
        "X-Atlassian-Token": "no-check",
      },
      body: form,
      timeoutMs: 60000,
    });
    return res.data;
  }
}

module.exports = {
  JiraClient,
};