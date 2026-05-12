const fs = require("fs");
const os = require("os");
const path = require("path");
const { CliError } = require("./errors");

const STORE_PATH = path.join(os.homedir(), ".openclaw", "jira-cli-idempotency.json");
const DEFAULT_TTL_SECONDS = 3600;

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { entries: {} };
    }
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.entries ? parsed : { entries: {} };
  } catch (_) {
    return { entries: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function cleanupExpired(store) {
  const now = Date.now();
  for (const [key, value] of Object.entries(store.entries || {})) {
    if (!value || !value.expiresAt || now > value.expiresAt) {
      delete store.entries[key];
    }
  }
}

function getIdempotentReplay(idempotencyKey, fingerprint) {
  if (!idempotencyKey) {
    return null;
  }

  const store = loadStore();
  cleanupExpired(store);
  const entry = store.entries[idempotencyKey];
  saveStore(store);

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

function storeIdempotentResult(idempotencyKey, fingerprint, result, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!idempotencyKey) {
    return;
  }

  const store = loadStore();
  cleanupExpired(store);
  store.entries[idempotencyKey] = {
    fingerprint,
    result,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  saveStore(store);
}

module.exports = {
  getIdempotentReplay,
  storeIdempotentResult,
};
