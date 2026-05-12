const fs = require("fs");
const path = require("path");

function storePath(invocationCwd = process.cwd()) {
  return path.join(invocationCwd, ".openclaw", "gitlab-idempotency.json");
}

function loadStore(invocationCwd) {
  const file = storePath(invocationCwd);
  try {
    if (!fs.existsSync(file)) return { keys: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.keys) return { keys: {} };
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

function consumeKey(idempotencyKey, payload, invocationCwd) {
  if (!idempotencyKey) return;
  const store = loadStore(invocationCwd);
  store.keys[idempotencyKey] = {
    consumedAt: new Date().toISOString(),
    payload,
  };
  saveStore(store, invocationCwd);
}

module.exports = {
  hasKey,
  consumeKey,
};
