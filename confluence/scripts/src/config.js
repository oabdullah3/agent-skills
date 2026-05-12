const fs = require("fs");
const os = require("os");
const path = require("path");
const { CliError } = require("./errors");

const REQUIRED_KEYS = ["CONFLUENCE_CLOUD_ID", "CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN"];

function readOpenClawConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`Unable to read OpenClaw config at ${filePath}: ${err.message}`, 2);
  }
}

function getNested(obj, pathParts) {
  let cursor = obj;
  for (const part of pathParts) {
    if (cursor == null || typeof cursor !== "object" || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

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
  const skillName = options.skillName || process.env.CONFLUENCE_SKILL_ENTRY || "confluence-manager";
  const envDir = options.envDir || process.env.CONFLUENCE_ENV_DIR;

  if (envDir) {
    const envPath = path.resolve(envDir, ".env");
    const parsedEnv = readDotEnvFile(envPath);
    const normalized = normalizeCredentialSet(parsedEnv, `.env at ${envPath}`);
    return { ...normalized, source: "dotenv", envPath };
  }

  if (process.env.CONFLUENCE_CLOUD_ID && process.env.CONFLUENCE_EMAIL && process.env.CONFLUENCE_API_TOKEN) {
    const normalized = normalizeCredentialSet(process.env, "process.env");
    return { ...normalized, source: "env" };
  }

  const configPath =
    options.configPath ||
    process.env.OPENCLAW_CONFIG ||
    path.join(os.homedir(), ".openclaw", "openclaw.json");

  const parsed = readOpenClawConfig(configPath);
  const envNode = getNested(parsed, ["skills", "entries", skillName, "env"]);

  if (!envNode) {
    throw new CliError(`Skill entry '${skillName}' not found at skills.entries.${skillName}.env in ${configPath}`, 2);
  }

  const cloudId = envNode.CONFLUENCE_CLOUD_ID;
  const email = envNode.CONFLUENCE_EMAIL;
  const token = envNode.CONFLUENCE_API_TOKEN;

  if (!cloudId || !email || !token) {
    throw new CliError(`Missing CONFLUENCE_CLOUD_ID, CONFLUENCE_EMAIL, or CONFLUENCE_API_TOKEN in skill '${skillName}'`, 2);
  }

  return { cloudId, email, token, skillName, configPath, source: "openclaw-config" };
}

module.exports = { loadCredentials };
