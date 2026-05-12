const fs = require("fs");
const path = require("path");
const { CliError } = require("./errors");

const REQUIRED_KEYS = ["CONFLUENCE_CLOUD_ID", "CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN"];

function readDotEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new CliError(`Unable to read .env file at ${filePath}: ${err.message}`, 2);
  }

  const result = {};
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const exportStripped = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const idx = exportStripped.indexOf("=");
    if (idx < 1) continue;

    const key = exportStripped.slice(0, idx).trim();
    const valueRaw = exportStripped.slice(idx + 1).trim();
    result[key] = stripWrappingQuotes(valueRaw);
  }

  return result;
}

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function normalizeCredentialSet(source, label) {
  const cloudId = source.CONFLUENCE_CLOUD_ID;
  const email = source.CONFLUENCE_EMAIL;
  const token = source.CONFLUENCE_API_TOKEN;
  const missing = REQUIRED_KEYS.filter((key) => !source[key]);

  if (missing.length > 0) {
    throw new CliError(`Missing ${missing.join(", ")} in ${label}`, 2);
  }

  return { cloudId, email, token };
}

function loadCredentials(options = {}) {
  if (process.env.CONFLUENCE_CLOUD_ID && process.env.CONFLUENCE_EMAIL && process.env.CONFLUENCE_API_TOKEN) {
    const normalized = normalizeCredentialSet(process.env, "process.env");
    return { ...normalized, source: "env" };
  }

  const envDir = options.envDir || process.env.CONFLUENCE_ENV_DIR;
  if (envDir) {
    const envPath = path.resolve(envDir, ".env");
    const parsedEnv = readDotEnvFile(envPath);
    const normalized = normalizeCredentialSet(parsedEnv, `.env at ${envPath}`);
    return { ...normalized, source: "dotenv", envPath };
  }

  throw new CliError(
    "Missing Confluence credentials. Provide CONFLUENCE_CLOUD_ID, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN via process env or use --env-dir.",
    2
  );
}

module.exports = { loadCredentials };
