const { CliError } = require("../errors");
const { rejectUnknownFlags, toInt, parseDetailFlag } = require("../utils");
const { resolvePageIdFromPath } = require("./pageEditCommon");

function parseStringListFlag(value) {
  if (!value) return [];
  const rawList = Array.isArray(value) ? value : [value];
  return rawList
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateIsoDateFlag(value, flagName) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    throw new CliError(`${flagName} must be an ISO-8601 date or datetime`, 3);
  }
  return String(value);
}

async function pageSearchCommand(client, args, output) {
  rejectUnknownFlags(args, [
    "page-id", "query", "title", "space-key", "cql", "limit", "start",
    "with-content", "with-labels", "with-version-history", "with-comments", "label",
    "with-ancestors", "with-children", "with-attachments", "with-restrictions", "body-format",
    "ancestor-id", "ancestor-path", "created-from", "created-to", "updated-from", "updated-to"
  ], "page search");

  const pageId = args["page-id"];
  const query = args.query;
  const title = args.title;
  const spaceKey = args["space-key"];
  const rawCql = args.cql;
  const labels = parseStringListFlag(args.label);
  const ancestorIdFlag = args["ancestor-id"];
  const ancestorPath = args["ancestor-path"];
  const createdFrom = validateIsoDateFlag(args["created-from"], "--created-from");
  const createdTo = validateIsoDateFlag(args["created-to"], "--created-to");
  const updatedFrom = validateIsoDateFlag(args["updated-from"], "--updated-from");
  const updatedTo = validateIsoDateFlag(args["updated-to"], "--updated-to");
  
  const limit = toInt(args.limit, 10); 
  const start = toInt(args.start, 0); 

  // Non-array details
  const withContent = Boolean(args["with-content"]);
  const withRestrictions = Boolean(args["with-restrictions"]);
  const bodyFormat = args["body-format"] || "view";

  // Array details (returns { requested, limit, start })
  const labelsConf = parseDetailFlag(args["with-labels"]);
  const historyConf = parseDetailFlag(args["with-version-history"]);
  const commentsConf = parseDetailFlag(args["with-comments"]);
  const ancestorsConf = parseDetailFlag(args["with-ancestors"]);
  const childrenConf = parseDetailFlag(args["with-children"]);
  const attachConf = parseDetailFlag(args["with-attachments"]);

  if (ancestorIdFlag && ancestorPath) {
    throw new CliError("Use either --ancestor-id or --ancestor-path, not both", 3);
  }

  let resolvedAncestorId = null;
  if (ancestorIdFlag) {
    const normalizedAncestorId = String(ancestorIdFlag).trim();
    if (!/^\d+$/.test(normalizedAncestorId)) {
      throw new CliError("--ancestor-id must be a numeric Confluence content ID", 3);
    }
    resolvedAncestorId = normalizedAncestorId;
  } else if (ancestorPath) {
    if (!spaceKey) {
      throw new CliError("--ancestor-path requires --space-key", 3);
    }
    resolvedAncestorId = await resolvePageIdFromPath(client, spaceKey, ancestorPath, "--ancestor-path");
  }

  async function augmentSinglePage(targetPageId, baseOutput) {
    const expansions = ["version"];
    if (withContent) expansions.push(`body.${bodyFormat}`);
    if (withRestrictions) expansions.push("restrictions.read.restrictions.user,restrictions.update.restrictions.user");

    // Confluence API doesn't support [start:limit] in expand - fetch all and paginate client-side
    if (labelsConf.requested) expansions.push("metadata.labels");
    if (historyConf.requested) expansions.push("history.lastUpdated");
    if (commentsConf.requested) expansions.push("children.comment");
    if (ancestorsConf.requested) expansions.push("ancestors");
    if (childrenConf.requested) expansions.push("children.page");
    if (attachConf.requested) expansions.push("children.attachment");

    const expandStr = expansions.join(",");
    const pageData = await client.getPage(targetPageId, expandStr);

    baseOutput.pageData = {
      id: pageData.id,
      title: pageData.title,
      type: pageData.type,
      status: pageData.status,
      spaceKey: pageData.space?.key,
      version: pageData.version?.number,
    };

    if (withContent) baseOutput.content = pageData.body?.[bodyFormat]?.value || "Empty";
    if (withRestrictions) baseOutput.restrictions = pageData.restrictions || {};

    // Apply client-side pagination to results
    if (labelsConf.requested) {
      const allLabels = pageData.metadata?.labels?.results || [];
      baseOutput.labels = allLabels.slice(labelsConf.start, labelsConf.start + labelsConf.limit);
    }
    if (historyConf.requested) baseOutput.lastUpdated = pageData.history?.lastUpdated || null;
    if (commentsConf.requested) {
      const allComments = pageData.children?.comment?.results || [];
      baseOutput.comments = allComments.slice(commentsConf.start, commentsConf.start + commentsConf.limit);
    }
    if (ancestorsConf.requested) {
      const allAncestors = pageData.ancestors || [];
      baseOutput.ancestors = allAncestors.slice(ancestorsConf.start, ancestorsConf.start + ancestorsConf.limit);
    }
    if (childrenConf.requested) {
      const allChildren = pageData.children?.page?.results || [];
      baseOutput.children = allChildren.slice(childrenConf.start, childrenConf.start + childrenConf.limit);
    }
    if (attachConf.requested) {
      const allAttachments = pageData.children?.attachment?.results || [];
      baseOutput.attachments = allAttachments.slice(attachConf.start, attachConf.start + attachConf.limit);
    }

    return baseOutput;
  }

  // 1. Exact Page ID Lookup
  if (pageId) {
    const result = await augmentSinglePage(pageId, {
      mode: "page-search",
      message: `Page details returned for exact ID ${pageId}`,
    });
    output(result);
    return;
  }

  // 2. Build CQL Query
  let cql = "";
  if (rawCql) {
    cql = rawCql;
  } else {
    const hasStructuredFilters = Boolean(
      query || title || spaceKey || labels.length > 0 || resolvedAncestorId || createdFrom || createdTo || updatedFrom || updatedTo
    );
    if (!hasStructuredFilters) {
      throw new CliError(
        "Missing search criteria: provide --page-id, --query, --title, --cql, --label, --ancestor-id/--ancestor-path, or date range filters",
        3
      );
    }

    cql = client.buildPageSearchCql({
      query,
      title,
      spaceKey,
      labels,
      ancestorId: resolvedAncestorId,
      createdFrom,
      createdTo,
      updatedFrom,
      updatedTo,
    });
  }

  // 3. Execute CQL Search
  const data = await client.searchPagesCql(cql, limit, start);
  const pages = data.results || [];

  const formattedPages = pages.map((p) => ({
    id: p.content?.id || p.id,
    title: p.content?.title || p.title,
    spaceKey: p.resultGlobalContainer?.displayUrl?.split('/')[2] || "Unknown",
    lastModified: p.lastModified,
    url: p.url,
  }));

  if (formattedPages.length === 1 && formattedPages[0]?.id) {
    const matchedId = formattedPages[0].id;
    const result = await augmentSinglePage(matchedId, {
      mode: "page-search",
      cql,
      total: 1,
      start,
      limit,
      message: `Single exact page match found (${matchedId}). Returning requested details.`,
    });
    output(result);
    return;
  }

  if (formattedPages.length > 0 || start > 0) {
    output({
      mode: "page-search",
      cql,
      total: data.totalSize || formattedPages.length,
      start,
      limit,
      pages: formattedPages,
      message: formattedPages.length > 1 
        ? "MULTIPLE pages found. Detail flags ignored. Please use --page-id to narrow down."
        : formattedPages.length === 1
          ? "Single page found. Use --page-id for full details."
          : "No pages found at this pagination offset.",
    });
    return;
  }

  output({ mode: "page-search", cql, total: 0, start, limit, pages: [], message: "No pages found." });
}

module.exports = { pageSearchCommand };