const { CliError } = require("../errors");
const { makeResolution, resolveInstruction } = require("../resolution");
const { parseTopLevelPagination, makePaginationMeta } = require("../pagination");
const { createExplain } = require("../explain");

async function projectSearchCommand(client, args, output) {
  const query = args.query;
  const topLevelPagination = parseTopLevelPagination(args, { defaultMax: 50, defaultStart: 0 });
  const withComponents = Boolean(args["with-components"]);
  const operationMode = String(args["operation-mode"] || "search").toLowerCase();
  const fallbackBehavior = [];

  function withExplain(payload, details) {
    const explain = createExplain(args, details);
    if (!explain) {
      return payload;
    }
    return { ...payload, explain };
  }

  if (!query) {
    throw new CliError("Missing required flag: --query", 3);
  }

  if (!["search", "resolve"].includes(operationMode)) {
    throw new CliError("Invalid --operation-mode for project search. Allowed: search, resolve", 3);
  }

  const data = await client.searchProjects(query, topLevelPagination.startAt, topLevelPagination.maxResults);
  const projects = data.values || [];

  if (operationMode === "resolve") {
    const normalized = projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
    }));

    const exact = normalized.filter((project) => {
      const key = String(project.key || "").toLowerCase();
      const name = String(project.name || "").toLowerCase();
      const q = String(query).toLowerCase();
      return key === q || name === q;
    });

    let resolution;
    if (exact.length === 1) {
      resolution = makeResolution("resolved", { query }, {
        selected: exact[0],
        instruction: resolveInstruction("project search", "resolved"),
      });
    } else if (exact.length > 1) {
      resolution = makeResolution("ambiguous", { query }, {
        candidates: exact,
        instruction: resolveInstruction("project search", "ambiguous"),
      });
    } else if (normalized.length === 1) {
      resolution = makeResolution("resolved", { query }, {
        selected: normalized[0],
        instruction: resolveInstruction("project search", "resolved"),
      });
    } else if (normalized.length > 1) {
      resolution = makeResolution("ambiguous", { query }, {
        candidates: normalized,
        instruction: resolveInstruction("project search", "ambiguous"),
      });
    } else {
      resolution = makeResolution("no-match", { query }, {
        instruction: resolveInstruction("project search", "no-match"),
      });
    }

    output(withExplain({
      mode: "project-search-resolve",
      query,
      total: data.total,
      startAt: data.startAt,
      maxResults: data.maxResults,
      pagination: makePaginationMeta({
        total: Number.isInteger(data.total) ? data.total : projects.length,
        startAt: Number.isInteger(data.startAt) ? data.startAt : topLevelPagination.startAt,
        maxResults: Number.isInteger(data.maxResults) ? data.maxResults : topLevelPagination.maxResults,
        returned: projects.length,
        strategy: "server",
      }),
      resolution,
    }, {
      selectors: { query, "operation-mode": operationMode },
      queryPlan: { route: "project-search", action: "searchProjects", decision: resolution.status },
      fieldsRequested: ["id", "key", "name"],
      enrichmentPlan: { withComponents: false },
      paginationPlan: { topLevel: topLevelPagination },
      fallbackBehavior,
    }));
    return;
  }

  const fieldsRequested = [
    "id",
    "key",
    "name",
    "issueTypes",
    ...(withComponents ? ["components"] : []),
  ];

  for (const project of projects) {
    if (!project?.id) {
      continue;
    }

    // 1. Fetch Issue Types (Default Behavior)
    try {
      const typesPayload = await client.getIssueTypesForProject(project.id);
      const issueTypes = Array.isArray(typesPayload)
        ? typesPayload
        : Array.isArray(typesPayload?.issueTypes)
          ? typesPayload.issueTypes
          : [];
      project.issueTypes = issueTypes;
    } catch (err) {
      project.issueTypes = [];
      project.issueTypesError = err.message;
      fallbackBehavior.push(`Issue types fetch failed for project ${project.key || project.id}; returned empty issueTypes.`);
    }

    // 2. Fetch Components (If requested)
    if (withComponents) {
      try {
        const compsPayload = await client.getProjectComponents(project.id);
        project.components = Array.isArray(compsPayload)
          ? compsPayload
          : Array.isArray(compsPayload?.values)
            ? compsPayload.values
            : [];
      } catch (err) {
        project.components = [];
        project.componentsError = err.message;
        fallbackBehavior.push(`Components fetch failed for project ${project.key || project.id}; returned empty components.`);
      }
    }
  }

  output(withExplain({
    mode: "project-search",
    query,
    total: data.total,
    startAt: data.startAt,
    maxResults: data.maxResults,
    pagination: makePaginationMeta({
      total: Number.isInteger(data.total) ? data.total : projects.length,
      startAt: Number.isInteger(data.startAt) ? data.startAt : topLevelPagination.startAt,
      maxResults: Number.isInteger(data.maxResults) ? data.maxResults : topLevelPagination.maxResults,
      returned: projects.length,
      strategy: "server",
    }),
    projects,
  }, {
    selectors: { query, "operation-mode": operationMode },
    queryPlan: { route: "project-search", action: "searchProjects" },
    fieldsRequested,
    enrichmentPlan: { withComponents },
    paginationPlan: { topLevel: topLevelPagination },
    fallbackBehavior,
  }));
}

module.exports = {
  projectSearchCommand,
};