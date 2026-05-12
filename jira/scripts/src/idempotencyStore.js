const fs = require("fs");
const path = require("path");
const { CliError } = require("./errors");

const DEFAULT_TTL_SECONDS = 60;

function storePath(invocationCwd = process.cwd()) {
  return path.join(invocationCwd, ".agent", "jira-idempotency.json");
}

function loadStore(invocationCwd) {
  try {
    const pathToStore = storePath(invocationCwd);
    if (!fs.existsSync(pathToStore)) {
      return { entries: {} };
    }
    const raw = fs.readFileSync(pathToStore, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return { entries: {} };
    cleanupExpired(parsed);
    return parsed;
  } catch (_) {
    return { entries: {} };
  }
}

function saveStore(store, invocationCwd) {
  const pathToStore = storePath(invocationCwd);
  fs.mkdirSync(path.dirname(pathToStore), { recursive: true });
  fs.writeFileSync(pathToStore, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function cleanupExpired(store) {
  const now = Date.now();
  for (const [key, value] of Object.entries(store.entries || {})) {
    if (!value || !value.expiresAt || now > value.expiresAt) {
      delete store.entries[key];
    }
  }
}

function getIdempotentReplay(idempotencyKey, fingerprint, invocationCwd = process.cwd()) {
  if (!idempotencyKey) {
    return null;
  }

  const store = loadStore(invocationCwd);
  cleanupExpired(store);
  const entry = store.entries[idempotencyKey];
  saveStore(store, invocationCwd);

  if (!entry) {
    return null;
  }

  if (entry.fingerprint !== fingerprint) {
    throw new CliError(
      "Idempotency key reuse detected with a different mutation fingerprint. Use a new --idempotency-key.",
      3
    );
  }

  return entry.result || null;
}

function storeIdempotentResult(idempotencyKey, fingerprint, result, ttlSeconds = DEFAULT_TTL_SECONDS, invocationCwd = process.cwd()) {
  if (!idempotencyKey) {
    return;
  }

  const store = loadStore(invocationCwd);
  cleanupExpired(store);
  store.entries[idempotencyKey] = {
    fingerprint,
    result,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  saveStore(store, invocationCwd);
}

module.exports = {
  getIdempotentReplay,
  storeIdempotentResult,
};
