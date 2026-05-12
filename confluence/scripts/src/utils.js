const { CliError } = require("./errors");

const GLOBAL_FLAGS = new Set(["env-dir", "config-path", "format"]);

function rejectUnknownFlags(args, allowedFlags, commandName) {
    const allowed = new Set(allowedFlags);
    
    const unknown = Object.keys(args).filter(
        (flag) => !allowed.has(flag) && !GLOBAL_FLAGS.has(flag)
    );

    if (unknown.length > 0) {
        throw new CliError(
        `Unrecognized flag(s) for '${commandName}': ${unknown.map((f) => `--${f}`).join(", ")}. Run --help for available flags.`,
        3
        );
    }
}


function parseDetailFlag(value, defaultLimit = 50) {
    if (!value || value === true) return { requested: !!value, start: 0, limit: defaultLimit };

    const cleanValue = String(value).replace(/[\[\]]/g, "");
    const parts = cleanValue.split(",");

    let limit = defaultLimit;
    let start = 0;

    // Pattern: [limit,start] - limit first, then start
    if (parts.length > 1) {
        limit = parseInt(parts[0].trim(), 10);
        start = parseInt(parts[1].trim(), 10);
    } else {
        limit = parseInt(parts[0].trim(), 10);
    }

    return {
        requested: true,
        start: isNaN(start) ? 0 : start,
        limit: isNaN(limit) ? defaultLimit : limit
    };
}

function buildPageExpansions(options) {
    const expansions = [];

    // Basic expansions that don't require pagination
    if (options.withBody) expansions.push("body.storage");
    if (options.withVersion) expansions.push("version");
    if (options.withSpace) expansions.push("space");

    // Collection expansions - Confluence API doesn't support [start:limit] in expand
    // We fetch all and paginate client-side
    if (options.withComments) expansions.push("children.comment");
    if (options.withAttachments) expansions.push("children.attachment");
    if (options.withLabels) expansions.push("metadata.labels");
    if (options.withAncestors) expansions.push("ancestors");
    if (options.withChildren) expansions.push("children.page");
    if (options.withRestrictions) expansions.push("restrictions.read.restrictions.user,restrictions.update.restrictions.user");
    if (options.withHistory) expansions.push("history.lastUpdated");

    return expansions.join(",");
}


function toInt(value, fallback) {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : fallback;
}

module.exports = {
    rejectUnknownFlags,
    toInt,
    parseDetailFlag,
    buildPageExpansions
};