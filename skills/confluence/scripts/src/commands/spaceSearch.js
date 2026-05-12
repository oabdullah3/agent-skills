const { CliError } = require("../errors");
const { rejectUnknownFlags, toInt, parseDetailFlag } = require("../utils");

async function spaceSearchCommand(client, args, output) {
  rejectUnknownFlags(args, [
    "space-key", "query", "limit", "start",
    "with-description", "with-homepage", "with-labels", "with-permissions"
  ], "space search");

  const spaceKey = args["space-key"];
  const query = args.query;
  const limit = toInt(args.limit, 10);
  const start = toInt(args.start, 0);

  const withDescription = Boolean(args["with-description"]);
  const withHomepage = Boolean(args["with-homepage"]);

  const labelsConf = parseDetailFlag(args["with-labels"]);
  const permConf = parseDetailFlag(args["with-permissions"]);

  async function augmentSingleSpace(targetSpaceKey, baseOutput) {
    const expansions = [];
    if (withDescription) expansions.push("description.plain");
    if (withHomepage) expansions.push("homepage");

    // Confluence API doesn't support [start:limit] in expand - fetch all and paginate client-side
    if (labelsConf.requested) expansions.push("metadata.labels");
    if (permConf.requested) expansions.push("permissions");

    const expandStr = expansions.join(",");
    const spaceData = await client.getSpace(targetSpaceKey, expandStr);

    if (!spaceData || !spaceData.key) {
        throw new CliError(`Space not found for key: ${targetSpaceKey}`, 404);
    }

    baseOutput.spaceData = {
      id: spaceData.id,
      key: spaceData.key,
      name: spaceData.name,
      type: spaceData.type,
    };

    if (withDescription) baseOutput.description = spaceData.description?.plain?.value || "No description";
    if (withHomepage) baseOutput.homepage = spaceData.homepage ? { id: spaceData.homepage.id, title: spaceData.homepage.title } : null;

    // Apply client-side pagination to results
    if (labelsConf.requested) {
      const allLabels = spaceData.metadata?.labels?.results || [];
      baseOutput.labels = allLabels.slice(labelsConf.start, labelsConf.start + labelsConf.limit);
    }
    if (permConf.requested) {
      const allPermissions = spaceData.permissions || [];
      baseOutput.permissions = allPermissions.slice(permConf.start, permConf.start + permConf.limit);
    }

    return baseOutput;
  }

  if (spaceKey) {
    const result = await augmentSingleSpace(spaceKey, {
      mode: "space-search",
      message: `Space details returned for exact key ${spaceKey}`,
    });
    output(result);
    return;
  }

  if (!query) {
    throw new CliError("Missing search criteria: provide --space-key or --query", 3);
  }

  const data = await client.searchSpaces(query, limit, start);
  const spaces = data.results || [];

  const formattedSpaces = spaces.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
  }));

  if (formattedSpaces.length === 1 && formattedSpaces[0]?.key) {
    const matchedKey = formattedSpaces[0].key;
    const result = await augmentSingleSpace(matchedKey, {
      mode: "space-search",
      query,
      total: 1,
      start,
      limit,
      message: `Single exact space match found (${matchedKey}). Returning requested details.`,
    });
    output(result);
    return;
  }

  if (formattedSpaces.length > 0 || start > 0) {
    output({
      mode: "space-search",
      query,
      total: data.totalSize || formattedSpaces.length,
      start,
      limit,
      spaces: formattedSpaces,
      message: formattedSpaces.length > 1 
        ? "MULTIPLE spaces found. Detail flags ignored. Please use --space-key to narrow down."
        : formattedSpaces.length === 1
          ? "Single space found. Use --space-key for full details."
          : "No spaces found at this pagination offset.",
    });
    return;
  }

  output({ mode: "space-search", query, total: 0, start, limit, spaces: [], message: "No spaces found." });
}

module.exports = { spaceSearchCommand };