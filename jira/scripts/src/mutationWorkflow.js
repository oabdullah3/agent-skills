const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CliError } = require("./errors");

const DEFAULT_PREVIEW_TTL_SECONDS = 900;
const PREVIEW_REF_STORE_PATH = path.join(os.homedir(), ".openclaw", "jira-cli-preview-refs.json");

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function buildPlanHash(payload) {
  return sha256(stableStringify(payload));
}

function buildPlanId(commandName, targetKey, planHash) {
  return sha256(`${commandName}:${targetKey}:${planHash}`).slice(0, 20);
}

function loadPreviewRefStore() {
  try {
    if (!fs.existsSync(PREVIEW_REF_STORE_PATH)) {
      return { entries: {} };
    }
    const raw = fs.readFileSync(PREVIEW_REF_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.entries ? parsed : { entries: {} };
  } catch (_) {
    return { entries: {} };
  }
}

function savePreviewRefStore(store) {
  fs.mkdirSync(path.dirname(PREVIEW_REF_STORE_PATH), { recursive: true });
  fs.writeFileSync(PREVIEW_REF_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function cleanupExpiredPreviewRefs(store) {
  const now = Date.now();
  for (const [key, value] of Object.entries(store.entries || {})) {
    if (!value || !value.expiresAt || now > value.expiresAt) {
      delete store.entries[key];
    }
  }
}

function issuePreviewRef({ planId, commandName, targetKey, actor, planHash, expiresInSeconds = DEFAULT_PREVIEW_TTL_SECONDS }) {
  const now = Date.now();
  const expiresAt = now + expiresInSeconds * 1000;
  const previewRef = String(planId || "").trim();
  if (!previewRef) {
    throw new CliError("Unable to issue preview reference without a valid plan id.", 2);
  }

  const store = loadPreviewRefStore();
  cleanupExpiredPreviewRefs(store);
  store.entries[previewRef] = {
    commandName,
    targetKey,
    actor,
    planHash,
    expiresAt,
  };
  savePreviewRefStore(store);

  return {
    previewRef,
    previewRefExpiresAt: new Date(expiresAt).toISOString(),
  };
}

function normalizePreviewRef(ref) {
  if (ref === undefined || ref === null) return "";
  return String(ref).trim();
}

function verifyPreviewRef(ref, expected) {
  const normalizedRef = normalizePreviewRef(ref);
  if (!normalizedRef) {
    throw new CliError(
      "Missing --preview-ref for finalize. Use --operation-mode show-changes to obtain a fresh preview reference.",
      3
    );
  }

  const store = loadPreviewRefStore();
  cleanupExpiredPreviewRefs(store);
  const entry = store.entries[normalizedRef];
  savePreviewRefStore(store);

  if (!entry) {
    throw new CliError(
      "Invalid or expired --preview-ref. Rerun --operation-mode show-changes and retry finalize.",
      3
    );
  }

  const mismatches = [];
  if (entry.commandName !== expected.commandName) mismatches.push("commandName");
  if (entry.targetKey !== expected.targetKey) mismatches.push("targetKey");
  if (entry.actor !== expected.actor) mismatches.push("actor");
  if (entry.planHash !== expected.planHash) mismatches.push("planHash");

  if (mismatches.length > 0) {
    const planHashOnly = mismatches.length === 1 && mismatches[0] === "planHash";
    const mismatchHint = planHashOnly
      ? " The command payload changed between show-changes and finalize (for example dynamic values like timestamps, random IDs, or edited flag values). Rerun show-changes and finalize with identical business flags and values."
      : "";
    throw new CliError(
      `Preview reference does not match current finalize context (${mismatches.join(", ")}). Rerun show-changes.${mismatchHint}`,
      3
    );
  }
}

function verifyFinalizeApproval({ previewRef, expected }) {
  verifyPreviewRef(previewRef, expected);
}

function buildDiffSummary({ before, plannedOperations, afterIntent, warnings, destructiveMarkers }) {
  return {
    before,
    plannedOperations,
    afterIntent,
    warnings: warnings || [],
    destructiveMarkers: destructiveMarkers || [],
  };
}

function requireNoDryRun(args, commandName) {
  if (args["dry-run"] !== undefined) {
    throw new CliError(
      `Flag --dry-run is no longer supported for ${commandName}. Use --operation-mode prepare or --operation-mode show-changes instead.`,
      3
    );
  }
}

module.exports = {
  DEFAULT_PREVIEW_TTL_SECONDS,
  buildPlanHash,
  buildPlanId,
  issuePreviewRef,
  verifyPreviewRef,
  verifyFinalizeApproval,
  buildDiffSummary,
  requireNoDryRun,
};
