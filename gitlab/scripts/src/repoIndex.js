const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDirectory, ensureInside, rejectSymlinkEscape } = require("./pathGuards");
const { isGitRepo, getOriginUrl } = require("./gitRunner");
const { canonicalRepoKey, normalizeRepoPath, extractRepoPathFromOrigin } = require("./gitlabClient");

function indexPath(invocationCwd = process.cwd()) {
  return path.join(invocationCwd, ".openclaw", "gitlab-repo-index.json");
}

function loadIndex(invocationCwd) {
  const file = indexPath(invocationCwd);
  try {
    if (!fs.existsSync(file)) return { entries: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return { entries: {} };
    return parsed;
  } catch (_) {
    return { entries: {} };
  }
}

function saveIndex(index, invocationCwd) {
  const file = indexPath(invocationCwd);
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function resolveCloneRoot(flags, invocationCwd = process.cwd()) {
  const explicit = flags["clone-root"];
  const envRoot = process.env.GITLAB_CLONE_ROOT;
  const workspaceParent = path.dirname(path.resolve(invocationCwd));
  const fallback = path.join(workspaceParent, "openclaw-repos");
  const cloneRoot = path.resolve(explicit || envRoot || fallback);

  ensureDirectory(cloneRoot);
  return cloneRoot;
}

function slugForRepoPath(repoPath) {
  return normalizeRepoPath(repoPath).replace(/\//g, "--");
}

function shortHash(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 8);
}

function canonicalFor(baseUrl, repoPath) {
  return canonicalRepoKey(baseUrl, repoPath);
}

function determineTargetDir(cloneRoot, baseUrl, repoPath) {
  const slug = slugForRepoPath(repoPath);
  const key = canonicalFor(baseUrl, repoPath);
  let candidate = path.join(cloneRoot, slug);

  if (fs.existsSync(candidate)) {
    const suffix = shortHash(key);
    candidate = path.join(cloneRoot, `${slug}-${suffix}`);
  }

  ensureInside(cloneRoot, candidate);
  rejectSymlinkEscape(cloneRoot, candidate);
  return candidate;
}

function originMatches(originUrl, runtimeBaseUrl, requestedRepoPath) {
  const fromOrigin = extractRepoPathFromOrigin(originUrl, runtimeBaseUrl);
  if (!fromOrigin) return false;
  return normalizeRepoPath(fromOrigin).toLowerCase() === normalizeRepoPath(requestedRepoPath).toLowerCase();
}

function validateIndexedEntry(entry, runtimeBaseUrl, repoPath) {
  if (!entry || !entry.repoDir) return false;
  if (!fs.existsSync(entry.repoDir)) return false;
  if (!isGitRepo(entry.repoDir)) return false;
  const origin = getOriginUrl(entry.repoDir);
  if (!origin) return false;
  return originMatches(origin, runtimeBaseUrl, repoPath);
}

function scanCloneRootForMatch(cloneRoot, runtimeBaseUrl, repoPath) {
  if (!fs.existsSync(cloneRoot)) return null;
  const children = fs.readdirSync(cloneRoot, { withFileTypes: true });
  for (const item of children) {
    if (!item.isDirectory()) continue;
    const repoDir = path.join(cloneRoot, item.name);
    if (!isGitRepo(repoDir)) continue;
    const origin = getOriginUrl(repoDir);
    if (originMatches(origin, runtimeBaseUrl, repoPath)) {
      return repoDir;
    }
  }
  return null;
}

function resolveExistingRepo({ invocationCwd, cloneRoot, runtimeBaseUrl, repoPath }) {
  const key = canonicalFor(runtimeBaseUrl, repoPath);
  const index = loadIndex(invocationCwd);

  const indexed = index.entries[key];
  if (validateIndexedEntry(indexed, runtimeBaseUrl, repoPath)) {
    indexed.lastValidatedAt = new Date().toISOString();
    saveIndex(index, invocationCwd);
    return { repoDir: indexed.repoDir, detectionSource: "index", canonicalRepoKey: key };
  }

  if (indexed) {
    delete index.entries[key];
    saveIndex(index, invocationCwd);
  }

  const scanned = scanCloneRootForMatch(cloneRoot, runtimeBaseUrl, repoPath);
  if (scanned) {
    index.entries[key] = {
      repoDir: scanned,
      lastValidatedAt: new Date().toISOString(),
    };
    saveIndex(index, invocationCwd);
    return { repoDir: scanned, detectionSource: "scan", canonicalRepoKey: key };
  }

  return null;
}

function rememberRepo({ invocationCwd, runtimeBaseUrl, repoPath, repoDir }) {
  const key = canonicalFor(runtimeBaseUrl, repoPath);
  const index = loadIndex(invocationCwd);
  index.entries[key] = {
    repoDir: path.resolve(repoDir),
    lastValidatedAt: new Date().toISOString(),
  };
  saveIndex(index, invocationCwd);
  return key;
}

module.exports = {
  resolveCloneRoot,
  determineTargetDir,
  resolveExistingRepo,
  rememberRepo,
};
