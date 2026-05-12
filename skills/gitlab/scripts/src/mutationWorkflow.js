const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CliError } = require("./errors");

const DEFAULT_TTL_SECONDS = 60;

function previewStorePath(invocationCwd = process.cwd()) {
  return path.join(invocationCwd, ".agent", "gitlab-preview-tokens.json");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function intentHash(payload) {
  return sha256(stableStringify(payload));
}

function loadStore(invocationCwd) {
  const file = previewStorePath(invocationCwd);
  try {
    if (!fs.existsSync(file)) return { entries: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return { entries: {} };
    return parsed;
  } catch (_) {
    return { entries: {} };
  }
}

function saveStore(store, invocationCwd) {
  const file = previewStorePath(invocationCwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function cleanupExpired(store) {
  const now = Date.now();
  for (const [token, entry] of Object.entries(store.entries)) {
    if (!entry || !entry.expiresAt || now > entry.expiresAt || entry.consumedAt) {
      delete store.entries[token];
    }
  }
}

function issuePreviewToken({ command, repoDir, payload, invocationCwd, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const hash = intentHash(payload);
  const token = sha256(`${command}:${repoDir}:${hash}:${Date.now()}`).slice(0, 24);
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const store = loadStore(invocationCwd);
  cleanupExpired(store);
  store.entries[token] = {
    command,
    repoDir,
    hash,
    expiresAt,
    createdAt: Date.now(),
    consumedAt: null,
  };
  saveStore(store, invocationCwd);

  return {
    previewToken: token,
    previewTokenExpiresAt: new Date(expiresAt).toISOString(),
    intentHash: hash,
  };
}

function verifyFinalize({ command, repoDir, payload, previewToken, humanApprovalObtained, invocationCwd }) {
  if (!humanApprovalObtained) {
    throw new CliError("Missing --human-approval-obtained for finalize.", 3, {
      code: "MISSING_HUMAN_APPROVAL",
      category: "approval",
      remediation: "Request explicit user approval, then rerun finalize with --human-approval-obtained.",
    });
  }

  if (!previewToken) {
    throw new CliError("Missing --preview-token for finalize.", 3, {
      code: "MISSING_PREVIEW_TOKEN",
      category: "approval",
      remediation: "Run --operation-mode show-changes first and reuse the returned preview token.",
    });
  }

  const store = loadStore(invocationCwd);
  cleanupExpired(store);
  const entry = store.entries[previewToken];
  if (!entry) {
    saveStore(store, invocationCwd);
    throw new CliError("Invalid or expired --preview-token.", 3, {
      code: "INVALID_PREVIEW_TOKEN",
      category: "approval",
      remediation: "Rerun show-changes and use the fresh token.",
    });
  }

  const hash = intentHash(payload);
  const mismatch = [];
  if (entry.command !== command) mismatch.push("command");
  if (entry.repoDir !== repoDir) mismatch.push("repoDir");
  if (entry.hash !== hash) mismatch.push("intentHash");

  if (mismatch.length > 0) {
    saveStore(store, invocationCwd);
    throw new CliError(`Preview token mismatch: ${mismatch.join(", ")}.`, 3, {
      code: "PREVIEW_CONTEXT_MISMATCH",
      category: "approval",
      remediation: "Do not change business flags between show-changes and finalize; rerun show-changes.",
    });
  }

  entry.consumedAt = Date.now();
  saveStore(store, invocationCwd);
  return { intentHash: hash };
}

module.exports = {
  issuePreviewToken,
  verifyFinalize,
  intentHash,
};
