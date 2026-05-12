const fs = require("fs");
const path = require("path");
const { requestJson } = require("./http");

class ConfluenceClient {
  constructor(credentials, options = {}) {
    this.cloudId = credentials.cloudId; 
    this.email = credentials.email;
    this.token = credentials.token;
    this.retries = Number.isInteger(options.retries) ? options.retries : 2;
    this.retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : 500;
  }

  baseUrl() {
    // Pure v1 gateway routing
    return `https://api.atlassian.com/ex/confluence/${this.cloudId}/wiki/rest/api`;
  }

  baseUrlV2() {
    return `https://api.atlassian.com/ex/confluence/${this.cloudId}/wiki/api/v2`;
  }

  authHeader() {
    const encoded = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    return `Basic ${encoded}`;
  }

  async api(endpoint, options = {}) {
    const headers = {
      Accept: "application/json",
      Authorization: this.authHeader(),
      ...(options.headers || {}),
    };

    return requestJson(`${this.baseUrl()}${endpoint}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
      retries: this.retries,
      retryDelayMs: this.retryDelayMs,
      timeoutMs: options.timeoutMs || 20000,
    });
  }

  async apiV2(endpoint, options = {}) {
    const headers = {
      Accept: "application/json",
      Authorization: this.authHeader(),
      ...(options.headers || {}),
    };

    return requestJson(`${this.baseUrlV2()}${endpoint}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
      retries: this.retries,
      retryDelayMs: this.retryDelayMs,
      timeoutMs: options.timeoutMs || 20000,
    });
  }

  // ---- USER ----
  async getMyself() {
    const res = await this.api(`/user/current`);
    return res.data;
  }

  async getMyDrafts(limit = 10) {
    const res = await this.api(`/content?type=page&status=draft&expand=history.createdBy,space&limit=${limit}`);
    return res.data?.results || [];
  }

  // ---- SPACES ----
  async searchSpaces(query, limit = 50, start = 0) {
    // Fetch all spaces with pagination (Confluence API max limit is 100)
    // We need to fetch all to ensure we find the space, then filter and paginate client-side
    const allSpaces = [];
    let fetchStart = 0;
    const fetchLimit = 100;
    
    while (true) {
      const res = await this.api(`/space?limit=${fetchLimit}&start=${fetchStart}`);
      const spaces = res.data?.results || [];
      allSpaces.push(...spaces);
      
      // Stop if we got fewer than requested (no more pages)
      if (spaces.length < fetchLimit) break;
      
      // Safety limit: don't fetch more than 500 spaces
      if (allSpaces.length >= 500) break;
      
      fetchStart += fetchLimit;
    }

    // Filter by query (case-insensitive match on name or key)
    const filtered = query
      ? allSpaces.filter(s =>
          s.name?.toLowerCase().includes(query.toLowerCase()) ||
          s.key?.toLowerCase().includes(query.toLowerCase())
        )
      : allSpaces;

    // Apply pagination client-side
    const paginated = filtered.slice(start, start + limit);

    return {
      results: paginated,
      totalSize: filtered.length,
      start,
      limit,
    };
  }

  async getSpace(spaceKey, expand = "") {
    const expandQuery = expand ? `?expand=${expand}` : "";
    const res = await this.api(`/space/${encodeURIComponent(spaceKey)}${expandQuery}`);
    return res.data;
  }

  // ---- PAGES & SEARCH ----
  async searchPagesCql(cql, limit = 50, start = 0) {
    // Fetch with larger limit and apply pagination client-side (Confluence /search endpoint has pagination bug)
    const fetchLimit = Math.max(limit * 2, 100);
    const res = await this.api(`/search?cql=${encodeURIComponent(cql)}&limit=${fetchLimit}&start=0`);
    const allResults = res.data?.results || [];
    
    // Apply pagination client-side
    const paginated = allResults.slice(start, start + limit);
    
    return {
      results: paginated,
      totalSize: res.data?.totalSize || allResults.length,
      start,
      limit,
    };
  }

  quoteCqlString(value) {
    const escaped = String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    return `"${escaped}"`;
  }

  buildPageSearchCql(filters = {}) {
    const clauses = ['type = "page"'];

    if (filters.query) {
      clauses.push(`text ~ ${this.quoteCqlString(filters.query)}`);
    }

    if (filters.title) {
      clauses.push(`title ~ ${this.quoteCqlString(filters.title)}`);
    }

    if (filters.spaceKey) {
      clauses.push(`space = ${this.quoteCqlString(filters.spaceKey)}`);
    }

    const labels = Array.isArray(filters.labels) ? filters.labels : [];
    if (labels.length === 1) {
      clauses.push(`label = ${this.quoteCqlString(labels[0])}`);
    } else if (labels.length > 1) {
      const labelClauses = labels.map((label) => `label = ${this.quoteCqlString(label)}`);
      clauses.push(`(${labelClauses.join(" AND ")})`);
    }

    if (filters.ancestorId) {
      clauses.push(`ancestor = ${String(filters.ancestorId)}`);
    }

    if (filters.createdFrom) {
      clauses.push(`created >= ${this.quoteCqlString(filters.createdFrom)}`);
    }

    if (filters.createdTo) {
      clauses.push(`created <= ${this.quoteCqlString(filters.createdTo)}`);
    }

    if (filters.updatedFrom) {
      clauses.push(`lastmodified >= ${this.quoteCqlString(filters.updatedFrom)}`);
    }

    if (filters.updatedTo) {
      clauses.push(`lastmodified <= ${this.quoteCqlString(filters.updatedTo)}`);
    }

    return clauses.join(" AND ");
  }

  async getPage(pageId, expand = "") {
    const expandQuery = expand ? `?expand=${expand}` : "";
    const res = await this.api(`/content/${encodeURIComponent(pageId)}${expandQuery}`);
    return res.data;
  }

  async getChildPages(parentPageId, limit = 200, start = 0) {
    const allChildren = [];
    let offset = start;
    const pageLimit = Math.min(limit, 200);

    while (allChildren.length < limit) {
      const remaining = limit - allChildren.length;
      const fetchLimit = Math.min(pageLimit, remaining);
      const res = await this.api(
        `/content/${encodeURIComponent(parentPageId)}/child/page?limit=${fetchLimit}&start=${offset}`
      );
      const batch = res.data?.results || [];
      allChildren.push(...batch);

      if (batch.length < fetchLimit) {
        break;
      }

      offset += fetchLimit;
    }

    return allChildren;
  }

  // ---- PAGE OPERATIONS (CREATE, UPDATE) ----
  async getPageContent(pageId, bodyFormat = "storage") {
    // Fetch page content in specified format (storage, atlas_doc_format, or view)
    const expand = `body.${bodyFormat},version`;
    const res = await this.api(`/content/${encodeURIComponent(pageId)}?expand=${encodeURIComponent(expand)}`);
    return res.data;
  }

  async createPage(spaceKey, title, bodyRepresentation, bodyValue, parentPageId = null) {
    // Create a new page in a space
    // bodyRepresentation: "storage" or "atlas_doc_format"
    // bodyValue: HTML string (for storage) or ADF object (for atlas_doc_format)
    const normalizedValue =
      typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);

    const payload = {
      type: "page",
      status: "current",
      title,
      space: {
        key: spaceKey,
      },
      body: {
        [bodyRepresentation]: {
          value: normalizedValue,
          representation: bodyRepresentation,
        },
      },
    };

    if (parentPageId) {
      payload.ancestors = [{ id: String(parentPageId) }];
    }

    const res = await this.api(`/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return res.data;
  }

  async updatePageContent(pageId, title, bodyRepresentation, bodyValue, versionNumber) {
    // Update page content with version management (optimistic locking)
    // versionNumber: current version number (we increment it)
    const normalizedValue =
      typeof bodyValue === "string" ? bodyValue : JSON.stringify(bodyValue);

    const payload = {
      id: String(pageId),
      type: "page",
      status: "current",
      title,
      body: {
        [bodyRepresentation]: {
          value: normalizedValue,
          representation: bodyRepresentation,
        },
      },
      version: {
        number: versionNumber + 1,
      },
    };

    const res = await this.api(`/content/${encodeURIComponent(pageId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return res.data;
  }

  async updatePageTitle(pageId, newTitle) {
    const page = await this.getPage(
      pageId,
      "version,title,body.storage,body.atlas_doc_format"
    );

    const currentVersion = Number(page?.version?.number);
    if (!Number.isFinite(currentVersion)) {
      throw new Error("Unable to determine current page version for title update");
    }

    let bodyRepresentation = "storage";
    let bodyValue = page?.body?.storage?.value;

    if (bodyValue == null && page?.body?.atlas_doc_format?.value != null) {
      bodyRepresentation = "atlas_doc_format";
      bodyValue = page.body.atlas_doc_format.value;
    }

    if (bodyValue == null) {
      throw new Error("Unable to load current page body for title update");
    }

    return this.updatePageContent(
      pageId,
      newTitle,
      bodyRepresentation,
      bodyValue,
      currentVersion
    );
  }

  async addPageComment(pageId, commentText) {
    const escaped = String(commentText)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const payload = {
      pageId: String(pageId),
      body: {
        representation: "storage",
        value: `<p>${escaped}</p>`,
      },
    };

    const res = await this.apiV2(`/footer-comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return res.data;
  }

  async addPageLabels(pageId, labels) {
    const payload = labels.map((name) => ({
      prefix: "global",
      name,
    }));

    const res = await this.api(`/content/${encodeURIComponent(pageId)}/label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return res.data;
  }

  async addPageInlineComment(pageId, commentText, inlineCommentProperties) {
    const escaped = String(commentText)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const payload = {
      pageId: String(pageId),
      body: {
        representation: "storage",
        value: `<p>${escaped}</p>`,
      },
      inlineCommentProperties,
    };

    const res = await this.apiV2(`/inline-comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    return res.data;
  }

  async getPageInlineComments(pageId, limit = 100) {
    const res = await this.apiV2(
      `/pages/${encodeURIComponent(pageId)}/inline-comments?limit=${encodeURIComponent(limit)}&body-format=storage`
    );
    return res.data?.results || [];
  }

  async addPageAttachment(pageId, filePath, comment = "") {
    const absolutePath = path.resolve(String(filePath));
    const fileBuffer = fs.readFileSync(absolutePath);
    const fileName = path.basename(absolutePath);

    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), fileName);
    form.append("minorEdit", "true");
    if (comment) {
      form.append("comment", String(comment));
    }

    const res = await this.api(`/content/${encodeURIComponent(pageId)}/child/attachment`, {
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

module.exports = { ConfluenceClient };