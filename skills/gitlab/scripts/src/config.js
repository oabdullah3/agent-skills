const fs = require("fs");
const path = require("path");
const { CliError } = require("./errors");
const REQUIRED = ["GITLAB_USERNAME", "GITLAB_TOKEN"];

function stripQuotes(value) {
  if (typeof value !== "string") return value;
  if (value.length >= 2) {
    const a = value[0];
    const b = value[value.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseDotEnv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const valueLine = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = valueLine.indexOf("=");
    if (eq < 1) continue;
    const key = valueLine.slice(0, eq).trim();
    const value = stripQuotes(valueLine.slice(eq + 1).trim());
    out[key] = value;
  }

  return out;
}


function normalizeCredentials(source, sourceName) {
  const mapped = {
    GITLAB_USERNAME: source.GITLAB_USERNAME || source.CREDENTIAL_1,
    GITLAB_TOKEN: source.GITLAB_TOKEN || source.CREDENTIAL_2,
    GITLAB_CA_BUNDLE: source.GITLAB_CA_BUNDLE || source.GITLAB_CA_BUNDLE_PATH || source.CREDENTIAL_3,
    GITLAB_CA_CERT_PEM: source.GITLAB_CA_CERT_PEM || source.GITLAB_CA_PEM,
  };

  const missing = REQUIRED.filter((k) => !mapped[k]);
  if (missing.length > 0) {
    throw new CliError(`Missing ${missing.join(", ")} in ${sourceName}.`, 2, {
      code: "MISSING_CREDENTIALS",
      category: "credentials",
      remediation: `Populate ${missing.join(", ")} and retry.`,
      source: sourceName,
      missing,
    });
  }

  return mapped;
}

function decodeEscapedNewlines(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function decodeMaybeBase64(value) {
  try {
    const raw = Buffer.from(String(value || ""), "base64").toString("utf8");
    if (raw.includes("BEGIN CERTIFICATE")) return raw;
    return null;
  } catch (_) {
    return null;
  }
}

function materializeCaFile(caValue, invocationCwd) {
  if (!caValue) return null;
  const raw = String(caValue).trim();
  if (!raw) return null;

  if (fs.existsSync(raw)) {
    return path.resolve(raw);
  }

  let pem = decodeEscapedNewlines(raw);
  if (!pem.includes("BEGIN CERTIFICATE")) {
    const decoded = decodeMaybeBase64(raw);
    if (decoded) pem = decoded;
  }

  if (!pem.includes("BEGIN CERTIFICATE")) {
    throw new CliError("Invalid GitLab CA input. Expected a file path, PEM, or base64-encoded PEM.", 2, {
      code: "INVALID_CA_BUNDLE_INPUT",
      category: "credentials",
      remediation:
        "Set GITLAB_CA_BUNDLE (or CREDENTIAL_3) to an existing PEM file path, PEM content, or base64-encoded PEM.",
    });
  }

  const certDir = path.join(invocationCwd, ".agent", "certs");
  const certPath = path.join(certDir, "gitlab-ca.pem");
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(certPath, pem.endsWith("\n") ? pem : `${pem}\n`, "utf8");
  return certPath;
}

function resolveGitTlsEnv(credentials, invocationCwd = process.cwd()) {
  const caInput = credentials?.GITLAB_CA_BUNDLE || credentials?.GITLAB_CA_CERT_PEM || credentials?.CREDENTIAL_3;
  if (!caInput) return {};
  const caFile = materializeCaFile(caInput, invocationCwd);
  if (caFile) {
    process.env.NODE_EXTRA_CA_CERTS = caFile;
    return { GIT_SSL_CAINFO: caFile };
  }
  return {};
}


function inferCaInputType(value) {
  const raw = String(value || "").trim();
  if (!raw) return "none";
  if (fs.existsSync(raw)) return "path";
  const newlineDecoded = decodeEscapedNewlines(raw);
  if (newlineDecoded.includes("BEGIN CERTIFICATE")) return "pem";
  if (decodeMaybeBase64(raw)) return "base64-pem";
  return "unknown";
}

function loadFromEnv() {
  const normalized = normalizeCredentials(process.env, "process.env");
  return {
    ...normalized,
    source: "env",
  };
}

function loadFromEnvDir(envDir) {
  const envPath = path.resolve(envDir, ".env");
  if (!fs.existsSync(envPath)) {
    throw new CliError(`No .env found at ${envPath}.`, 2, {
      code: "MISSING_ENV_FILE",
      category: "credentials",
      remediation: "Create .env in the provided env-dir or use another credential source.",
    });
  }
  const parsed = parseDotEnv(envPath);
  const normalized = normalizeCredentials(parsed, `.env:${envPath}`);
  return {
    ...normalized,
    source: "dotenv",
    envPath,
  };
}

function loadCredentials(flags = {}, invocationCwd = process.cwd()) {
  const attempts = [];

  try {
    const creds = loadFromEnv();
    return creds;
  } catch (err) {
    attempts.push({ source: "env", error: err.message });
  }

  const envDir = flags["env-dir"] || process.env.GITLAB_ENV_DIR;
  if (envDir) {
    try {
      const creds = loadFromEnvDir(envDir);
      return creds;
    } catch (err) {
      attempts.push({ source: "dotenv", error: err.message });
    }
  }

  throw new CliError("Unable to resolve GitLab credentials from configured sources.", 2, {
    code: "CREDENTIAL_RESOLUTION_FAILED",
    category: "credentials",
    remediation: "Provide credentials via process env or pass --env-dir with a .env file.",
    attempts,
  });
}

function inspectCredentialSources(flags = {}, invocationCwd = process.cwd()) {
  const envDir = flags["env-dir"] || process.env.GITLAB_ENV_DIR;

  const checks = [];

  function hasCaInput(source = {}) {
    return Boolean(source.GITLAB_CA_BUNDLE || source.GITLAB_CA_BUNDLE_PATH || source.CREDENTIAL_3 || source.GITLAB_CA_CERT_PEM || source.GITLAB_CA_PEM);
  }

  checks.push({
    source: "env",
    hasUsername: Boolean(process.env.GITLAB_USERNAME || process.env.CREDENTIAL_1),
    hasToken: Boolean(process.env.GITLAB_TOKEN || process.env.CREDENTIAL_2),
    hasCaInput: hasCaInput(process.env),
  });

  const dotenvPath = envDir ? path.resolve(envDir, ".env") : null;
  let dotenvParsed = null;
  if (dotenvPath && fs.existsSync(dotenvPath)) {
    try {
      dotenvParsed = parseDotEnv(dotenvPath);
    } catch (_) {
      dotenvParsed = null;
    }
  }
  checks.push({
    source: "dotenv",
    path: dotenvPath,
    exists: dotenvPath ? fs.existsSync(dotenvPath) : false,
    hasCaInput: hasCaInput(dotenvParsed || {}),
  });

  let selectedSource = "none";
  let tls = {
    caConfigured: false,
    caInputType: "none",
  };
  try {
    const selected = loadCredentials(flags, invocationCwd);
    selectedSource = selected.source;
    const caRaw = selected.GITLAB_CA_BUNDLE || selected.GITLAB_CA_CERT_PEM;
    tls = {
      caConfigured: Boolean(caRaw),
      caInputType: inferCaInputType(caRaw),
    };
  } catch (_) {
    selectedSource = "none";
  }

  return {
    mode: "doctor-credentials",
    selectedSource,
    tls,
    checks,
  };
}

module.exports = {
  loadCredentials,
  inspectCredentialSources,
  resolveGitTlsEnv,
};
