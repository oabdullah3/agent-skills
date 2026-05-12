const { CliError } = require("./errors");

function toInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeNonNegativeInt(value, fallback, flagName) {
  const parsed = toInt(value, fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(`Invalid ${flagName}. Expected non-negative integer.`, 3);
  }
  return parsed;
}

function parseTopLevelPagination(args, options = {}) {
  const maxKey = options.maxKey || "max-results";
  const startKey = options.startKey || "start-at";
  const defaultMax = Number.isInteger(options.defaultMax) ? options.defaultMax : 50;
  const defaultStart = Number.isInteger(options.defaultStart) ? options.defaultStart : 0;

  const maxResults = normalizeNonNegativeInt(args[maxKey], defaultMax, `--${maxKey}`);
  const startAt = normalizeNonNegativeInt(args[startKey], defaultStart, `--${startKey}`);

  return {
    maxResults,
    startAt,
  };
}

function parseTupleFlag(args, flagKey, options = {}) {
  const raw = args[flagKey];
  if (raw === undefined || raw === false) {
    return { enabled: false };
  }

  const defaultMax = Number.isInteger(options.defaultMax) ? options.defaultMax : 50;
  const defaultStart = Number.isInteger(options.defaultStart) ? options.defaultStart : 0;

  if (raw === true) {
    return {
      enabled: true,
      maxResults: defaultMax,
      startAt: defaultStart,
      source: "default",
    };
  }

  const tuple = String(raw).trim();
  const bracketMatch = tuple.match(/^\[(\d+)\s*,\s*(\d+)\]$/);
  if (bracketMatch) {
    return {
      enabled: true,
      maxResults: normalizeNonNegativeInt(bracketMatch[1], defaultMax, `--${flagKey}`),
      startAt: normalizeNonNegativeInt(bracketMatch[2], defaultStart, `--${flagKey}`),
      source: "tuple",
    };
  }

  const csvMatch = tuple.match(/^(\d+)\s*,\s*(\d+)$/);
  if (csvMatch) {
    return {
      enabled: true,
      maxResults: normalizeNonNegativeInt(csvMatch[1], defaultMax, `--${flagKey}`),
      startAt: normalizeNonNegativeInt(csvMatch[2], defaultStart, `--${flagKey}`),
      source: "tuple",
    };
  }

  if (/^\d+$/.test(tuple)) {
    return {
      enabled: true,
      maxResults: normalizeNonNegativeInt(tuple, defaultMax, `--${flagKey}`),
      startAt: defaultStart,
      source: "max-only",
    };
  }

  throw new CliError(
    `Invalid --${flagKey} format. Use --${flagKey} [max,start], --${flagKey} max,start, or --${flagKey} with no value for defaults.`,
    3
  );
}

function paginateArray(items, startAt, maxResults) {
  const list = Array.isArray(items) ? items : [];
  const start = Math.max(0, startAt);
  const max = Math.max(0, maxResults);
  const values = list.slice(start, start + max);
  return {
    values,
    total: list.length,
    startAt: start,
    maxResults: max,
  };
}

function makePaginationMeta(options) {
  return {
    total: Number.isInteger(options.total) ? options.total : 0,
    startAt: Number.isInteger(options.startAt) ? options.startAt : 0,
    maxResults: Number.isInteger(options.maxResults) ? options.maxResults : 0,
    returned: Number.isInteger(options.returned) ? options.returned : 0,
    strategy: options.strategy || "server",
  };
}

module.exports = {
  parseTopLevelPagination,
  parseTupleFlag,
  paginateArray,
  makePaginationMeta,
};
