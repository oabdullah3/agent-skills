const { CliError } = require("../errors");

function normalizePipeWrittenFlag(args) {
    return Boolean(args["pipe-file-written-to"] || args["pipe-changed"]);
}

async function resolveSpaceKey(client, spaceKey, spaceName) {
    if (spaceKey) {
        return spaceKey;
    }

    if (!spaceName) {
        return null;
    }

    const spaceResult = await client.searchSpaces(spaceName, 100, 0);
    if (spaceResult.results.length === 0) {
        throw new CliError(`Space with name '${spaceName}' not found`, 5);
    }

    const exact = spaceResult.results.find((s) => s.name === spaceName);
    if (exact) {
        return exact.key;
    }

    if (spaceResult.results.length === 1) {
        return spaceResult.results[0].key;
    }

    throw new CliError(
        `Multiple spaces match '${spaceName}'. Please use --space-key. Found: ${spaceResult.results.map((s) => `${s.name} (${s.key})`).join(", ")}`,
        5
    );
}

async function resolvePageForEdit(client, { pageTitle, searchQuery, rawCql, spaceKey, spaceName }) {
    const resolvedSpaceKey = await resolveSpaceKey(client, spaceKey, spaceName);

    let cql;
    if (pageTitle && resolvedSpaceKey) {
        cql = `title = "${String(pageTitle).replace(/\"/g, '\\\"')}" AND space = "${resolvedSpaceKey}"`;
    } else if (searchQuery && resolvedSpaceKey) {
        cql = `text ~ "${String(searchQuery).replace(/\"/g, '\\\"')}" AND space = "${resolvedSpaceKey}"`;
    } else if (rawCql) {
        cql = rawCql;
    } else {
        throw new CliError("Must provide --page-title, --query, or --cql to resolve page", 3);
    }

    const result = await client.searchPagesCql(cql, 25, 0);
    const pages = (result.results || []).map((p) => ({
        id: p.id || p.content?.id,
        title: p.title || p.content?.title,
        space: p.resultGlobalContainer?.displayUrl?.split("/")[2] || resolvedSpaceKey || "Unknown",
    })).filter((p) => p.id);

    if (pages.length === 0) {
        return { mode: "none", cql, pages: [] };
    }

    if (pages.length > 1) {
        return { mode: "ambiguous", cql, pages };
    }

    return { mode: "single", cql, page: pages[0] };
}

function parseHierarchyPath(pathValue, flagName) {
    const normalized = String(pathValue || "").trim().replace(/\\/g, "/");
    if (!normalized) {
        throw new CliError(`${flagName} cannot be empty`, 3);
    }
    if (!normalized.startsWith(".")) {
        throw new CliError(`${flagName} must start with '.' (example: ./Parent/Child/)`, 3);
    }

    const withoutRoot = normalized.replace(/^\.\/?/, "");
    const segments = withoutRoot.split("/").map((s) => s.trim()).filter(Boolean);
    return segments;
}

async function resolvePageIdFromPath(client, spaceKey, pathValue, flagName = "--ancestor-path") {
    const segments = parseHierarchyPath(pathValue, flagName);
    if (segments.length === 0) {
        throw new CliError(`${flagName} must include at least one page segment below './'`, 3);
    }

    const space = await client.getSpace(spaceKey, "homepage");
    const homepageId = space?.homepage?.id;
    const homepageTitle = String(space?.homepage?.title || "").trim();
    if (!homepageId) {
        throw new CliError("Unable to resolve space homepage for path traversal.", 10);
    }

    const effectiveSegments = [...segments];
    if (homepageTitle && effectiveSegments[0] === homepageTitle) {
        effectiveSegments.shift();
    }

    if (effectiveSegments.length === 0) {
        return String(homepageId);
    }

    let currentParentId = String(homepageId);
    for (const segment of effectiveSegments) {
        const escapedSegment = String(segment).replace(/"/g, '\\"');
        const cql = `parent = ${currentParentId} AND space = "${spaceKey}" AND title = "${escapedSegment}"`;
        const searchResult = await client.searchPagesCql(cql, 25, 0);
        const matches = (searchResult.results || [])
            .map((r) => ({
                id: r?.content?.id || r?.id,
                title: r?.content?.title || r?.title,
            }))
            .filter((r) => r.id && r.title);

        if (matches.length === 0) {
            throw new CliError(`Path segment '${segment}' not found under current parent.`, 5);
        }
        if (matches.length > 1) {
            throw new CliError(`Path segment '${segment}' is ambiguous under current parent.`, 5);
        }

        currentParentId = String(matches[0].id);
    }

    return currentParentId;
}

function parseAtlasDocBody(pageContent) {
    const adfBody = pageContent?.body?.atlas_doc_format;
    if (!adfBody || adfBody.value == null) {
        return null;
    }

    if (typeof adfBody.value === "string") {
        return JSON.parse(adfBody.value);
    }

    return adfBody.value;
}

module.exports = {
    normalizePipeWrittenFlag,
    resolveSpaceKey,
    resolvePageForEdit,
    resolvePageIdFromPath,
    parseAtlasDocBody,
};
