const fs = require("fs");
const os = require("os");
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

function readOpenClawConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      `Unable to read OpenClaw config at ${filePath}: ${err.message}`,
      2
    );
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
  const skillName = options.skillName || process.env.JIRA_SKILL_ENTRY || "jira-manager";
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

  const configPath =
    options.configPath ||
    process.env.OPENCLAW_CONFIG ||
    path.join(os.homedir(), ".openclaw", "openclaw.json");

  const parsed = readOpenClawConfig(configPath);
  const envNode = getNested(parsed, ["skills", "entries", skillName, "env"]);

  if (!envNode) {
    throw new CliError(
      `Skill entry '${skillName}' not found at skills.entries.${skillName}.env in ${configPath}`,
      2
    );
  }

  const cloudId = envNode.JIRA_CLOUD_ID;
  const email = envNode.JIRA_EMAIL;
  const token = envNode.JIRA_API_TOKEN;

  if (!cloudId || !email || !token) {
    throw new CliError(
      `Missing JIRA_CLOUD_ID, JIRA_EMAIL, or JIRA_API_TOKEN in skill '${skillName}'`,
      2
    );
  }

  return {
    cloudId,
    email,
    token,
    skillName,
    configPath,
    source: "openclaw-config",
  };
}

function inspectCredentials(options = {}) {
  const skillName = options.skillName || process.env.JIRA_SKILL_ENTRY || "jira-manager";
  const envDir = options.envDir || process.env.JIRA_ENV_DIR || null;
  const configPath =
    options.configPath ||
    process.env.OPENCLAW_CONFIG ||
    path.join(os.homedir(), ".openclaw", "openclaw.json");

  const attempts = [];

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
          return buildDiagnosticsResult(skillName, configPath, attempts, "dotenv", attempt);
        }
      } catch (err) {
        attempt.error = err.message;
      }
    }

    attempts.push(attempt);
    return buildDiagnosticsResult(skillName, configPath, attempts, "none", null);
  }

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
    return buildDiagnosticsResult(skillName, configPath, attempts, "env", envAttempt);
  }
  attempts.push(envAttempt);

  const configAttempt = {
    source: "openclaw-config",
    selected: false,
    configPath,
    exists: fs.existsSync(configPath),
    skillName,
    keyPresence: keyPresence({}),
    missingKeys: REQUIRED_KEYS,
    error: null,
    preview: {
      cloudId: null,
      email: null,
      token: null,
    },
  };

  if (configAttempt.exists) {
    try {
      const parsed = readOpenClawConfig(configPath);
      const envNode = getNested(parsed, ["skills", "entries", skillName, "env"]);
      if (!envNode) {
        configAttempt.error = `Skill entry '${skillName}' not found`;
      } else {
        configAttempt.keyPresence = keyPresence(envNode);
        configAttempt.missingKeys = REQUIRED_KEYS.filter((key) => !envNode[key]);
        configAttempt.preview = {
          cloudId: redactedValue(envNode.JIRA_CLOUD_ID),
          email: redactedValue(envNode.JIRA_EMAIL),
          token: redactedValue(envNode.JIRA_API_TOKEN),
        };
        if (configAttempt.missingKeys.length === 0) {
          configAttempt.selected = true;
          attempts.push(configAttempt);
          return buildDiagnosticsResult(skillName, configPath, attempts, "openclaw-config", configAttempt);
        }
      }
    } catch (err) {
      configAttempt.error = err.message;
    }
  } else {
    configAttempt.error = "Config file not found";
  }

  attempts.push(configAttempt);
  return buildDiagnosticsResult(skillName, configPath, attempts, "none", null);
}

function buildDiagnosticsResult(skillName, configPath, attempts, selectedSource, selectedAttempt) {
  const allMissing = REQUIRED_KEYS.filter((key) => {
    if (!selectedAttempt) return true;
    return !selectedAttempt.keyPresence[key];
  });

  return {
    mode: "doctor-credentials",
    selectedSource,
    skillName,
    configPath,
    lookupOrder: ["dotenv", "env", "openclaw-config"],
    attempts,
    missingKeys: allMissing,
    remediation: selectedSource === "none"
      ? [
          "Provide complete Jira credentials in one source: --env-dir .env, process env, or OpenClaw config.",
          "If using config fallback, ensure skills.entries.<skillName>.env contains JIRA_CLOUD_ID, JIRA_EMAIL, and JIRA_API_TOKEN.",
        ]
      : ["Credential source resolved successfully."],
  };
}

module.exports = {
  loadCredentials,
  inspectCredentials,
};
