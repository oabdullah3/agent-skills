const fs = require("fs");
const path = require("path");
const { CliError } = require("./errors");

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureInside(baseDir, candidatePath) {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const rel = path.relative(base, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CliError(`Path '${candidate}' escapes base directory '${base}'.`, 2, {
      code: "PATH_ESCAPE",
      category: "safety",
      remediation: "Use a path under the approved clone root.",
    });
  }
  return candidate;
}

function rejectSymlinkEscape(baseDir, candidatePath) {
  const base = path.resolve(baseDir);
  let current = path.resolve(candidatePath);

  while (current.startsWith(base)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(current);
        if (!resolved.startsWith(base)) {
          throw new CliError(`Symlink path '${current}' resolves outside clone root.`, 2, {
            code: "SYMLINK_ESCAPE",
            category: "safety",
            remediation: "Use a non-symlink path within clone root.",
          });
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

module.exports = {
  ensureDirectory,
  ensureInside,
  rejectSymlinkEscape,
};
