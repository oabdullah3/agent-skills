const fs = require("fs");
const path = require("path");

const DEFAULT_TTL_SECONDS = 60;

function storePath(invocationCwd = process.cwd()) {
  return path.join(invocationCwd, ".agent", "gitlab-idempotency.json");
}

function cleanupExpired(store) {
  const now = Date.now();
  for (const [key, value] of Object.entries(store.keys || {})) {
    if (!value || !value.expiresAt || now > value.expiresAt) {
      delete store.keys[key];
    }
  }
}

function loadStore(invocationCwd) {
  const file = storePath(invocationCwd);
  try {
    if (!fs.existsSync(file)) return { keys: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.keys) return { keys: {} };
    cleanupExpired(parsed);
    return parsed;
  } catch (_) {
    return { keys: {} };
  }
}

function saveStore(data, invocationCwd) {
  const file = storePath(invocationCwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function hasKey(idempotencyKey, invocationCwd) {
  if (!idempotencyKey) return false;
  const store = loadStore(invocationCwd);
  return Boolean(store.keys[idempotencyKey]);
}

function consumeKey(idempotencyKey, payload, invocationCwd, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!idempotencyKey) return;
  const store = loadStore(invocationCwd);
  store.keys[idempotencyKey] = {
    consumedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlSeconds * 1000,
    payload,
  };
  saveStore(store, invocationCwd);
}

module.exports = {
  hasKey,
  consumeKey,
};
