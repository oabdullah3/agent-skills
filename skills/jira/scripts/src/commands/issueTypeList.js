const { CliError } = require("../errors");

async function issueTypeListCommand(client, args, output) {
  const project = await resolveProject(client, args);
  const data = await client.getIssueTypesForProject(project.id);

  const issueTypes = Array.isArray(data)
    ? data
    : Array.isArray(data?.issueTypes)
      ? data.issueTypes
      : [];

  output({
    mode: "issue-type-list",
    project,
    total: issueTypes.length,
    issueTypes,
  });
}

async function resolveProject(client, args) {
  if (args["project-id"]) {
    return { id: String(args["project-id"]) };
  }

  if (args["project-key"]) {
    const query = String(args["project-key"]);
    const maxResults = 50;
    const result = await client.searchProjects(query, 0, maxResults);
    const projects = result.values || [];
    const matches = projects.filter(
      (project) =>
        project &&
        typeof project.key === "string" &&
        project.key.toLowerCase() === query.toLowerCase()
    );

    if (matches.length === 1) {
      return {
        id: matches[0].id,
        key: matches[0].key,
        name: matches[0].name,
      };
    }

    if (matches.length > 1) {
      throw new CliError(
        `Project key '${query}' matched multiple projects. Use --project-id instead.`,
        5,
        { matches }
      );
    }

    throw new CliError(`Project key '${query}' not found`, 5);
  }

  if (args["project-query"]) {
    const query = String(args["project-query"]);
    const maxAttempts = 3;
    const pageSize = 25;

    let startAt = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await client.searchProjects(query, startAt, pageSize);
      const projects = result.values || [];

      if (projects.length === 1) {
        return {
          id: projects[0].id,
          key: projects[0].key,
          name: projects[0].name,
        };
      }

      if (projects.length > 1) {
        throw new CliError(
          `Project query '${query}' is ambiguous (${projects.length} matches). Provide --project-id/--project-key.`,
          5,
          { projects }
        );
      }

      startAt += pageSize;
    }

    throw new CliError(`Project not found after ${maxAttempts} attempts for query '${query}'`, 5);
  }

  throw new CliError(
    "Missing project selector: provide --project-id, --project-key, or --project-query",
    3
  );
}

module.exports = {
  issueTypeListCommand,
};
