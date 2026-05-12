const fs = require("fs");
const path = require("path");
const { CliError } = require("./errors");

const REQUIRED_KEYS = ["JIRA_CLOUD_ID", "JIRA_EMAIL", "JIRA_API_TOKEN"];

function redactedValue(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 2) return `${text[0] || ""}*** (len=${text.length})`;
  return `${text.slice(0, 2)}*** (len=${text.length})`;
}

function keyPresence(source) {
  return {
    JIRA_CLOUD_ID: Boolean(source?.JIRA_CLOUD_ID),
    JIRA_EMAIL: Boolean(source?.JIRA_EMAIL),
    JIRA_API_TOKEN: Boolean(source?.JIRA_API_TOKEN),
  };
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
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const exportStripped = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const idx = exportStripped.indexOf("=");
    if (idx < 1) {
      continue;
    }

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
  const cloudId = source.JIRA_CLOUD_ID;
  const email = source.JIRA_EMAIL;
  const token = source.JIRA_API_TOKEN;
  const missing = REQUIRED_KEYS.filter((key) => !source[key]);

  if (missing.length > 0) {
    throw new CliError(
      `Missing ${missing.join(", ")} in ${label}`,
      2
    );
  }

  return {
    cloudId,
    email,
    token,
  };
}

function loadCredentials(options = {}) {
  if (
    process.env.JIRA_CLOUD_ID &&
    process.env.JIRA_EMAIL &&
    process.env.JIRA_API_TOKEN
  ) {
    const normalized = normalizeCredentialSet(process.env, "process.env");
    return {
      ...normalized,
      source: "env",
    };
  }

  const envDir = options.envDir || process.env.JIRA_ENV_DIR;
  if (envDir) {
    const envPath = path.resolve(envDir, ".env");
    const parsedEnv = readDotEnvFile(envPath);
    const normalized = normalizeCredentialSet(parsedEnv, `.env at ${envPath}`);

    return {
      ...normalized,
      source: "dotenv",
      envPath,
    };
  }

  throw new CliError(
    "Missing Jira credentials. Provide JIRA_CLOUD_ID, JIRA_EMAIL, and JIRA_API_TOKEN via process env or use --env-dir.",
    2
  );
}

function inspectCredentials(options = {}) {
  const skillName = options.skillName || process.env.JIRA_SKILL_ENTRY || "jira-manager";
  const envDir = options.envDir || process.env.JIRA_ENV_DIR || null;

  const attempts = [];

  const envAttempt = {
    source: "env",
    selected: false,
    keyPresence: keyPresence(process.env),
    missingKeys: REQUIRED_KEYS.filter((key) => !process.env[key]),
    preview: {
      cloudId: redactedValue(process.env.JIRA_CLOUD_ID),
      email: redactedValue(process.env.JIRA_EMAIL),
      token: redactedValue(process.env.JIRA_API_TOKEN),
    },
  };
  if (envAttempt.missingKeys.length === 0) {
    envAttempt.selected = true;
    attempts.push(envAttempt);
    return buildDiagnosticsResult(skillName, attempts, "env", envAttempt);
  }
  attempts.push(envAttempt);

  if (envDir) {
    const envPath = path.resolve(envDir, ".env");
    const exists = fs.existsSync(envPath);
    const attempt = {
      source: "dotenv",
      selected: false,
      envPath,
      exists,
      keyPresence: keyPresence({}),
      missingKeys: REQUIRED_KEYS,
      error: null,
      preview: {
        cloudId: null,
        email: null,
        token: null,
      },
    };

    if (exists) {
      try {
        const parsedEnv = readDotEnvFile(envPath);
        attempt.keyPresence = keyPresence(parsedEnv);
        attempt.missingKeys = REQUIRED_KEYS.filter((key) => !parsedEnv[key]);
        attempt.preview = {
          cloudId: redactedValue(parsedEnv.JIRA_CLOUD_ID),
          email: redactedValue(parsedEnv.JIRA_EMAIL),
          token: redactedValue(parsedEnv.JIRA_API_TOKEN),
        };
        if (attempt.missingKeys.length === 0) {
          attempt.selected = true;
          attempts.push(attempt);
          return buildDiagnosticsResult(skillName, attempts, "dotenv", attempt);
        }
      } catch (err) {
        attempt.error = err.message;
      }
    }

    attempts.push(attempt);
  }

  return buildDiagnosticsResult(skillName, attempts, "none", null);
}

function buildDiagnosticsResult(skillName, attempts, selectedSource, selectedAttempt) {
  const allMissing = REQUIRED_KEYS.filter((key) => {
    if (!selectedAttempt) return true;
    return !selectedAttempt.keyPresence[key];
  });

  return {
    mode: "doctor-credentials",
    selectedSource,
    skillName,
    lookupOrder: ["env", "dotenv"],
    attempts,
    missingKeys: allMissing,
    remediation: selectedSource === "none"
      ? [
          "Provide complete Jira credentials in one source: process env or --env-dir .env.",
          "If using --env-dir, ensure the .env file contains JIRA_CLOUD_ID, JIRA_EMAIL, and JIRA_API_TOKEN.",
        ]
      : ["Credential source resolved successfully."],
  };
}

module.exports = {
  loadCredentials,
  inspectCredentials,
};
