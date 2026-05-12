const path = require("path");
const { CliError } = require("./errors");
const { resolveCloneRoot, resolveExistingRepo } = require("./repoIndex");

function resolveRepoDirFromFlags(flags, invocationCwd, runtimeBaseUrl) {
  if (flags["repo-dir"]) {
    return {
      repoDir: path.resolve(flags["repo-dir"]),
      detectionSource: "explicit",
      canonicalRepoKey: null,
      cloneRoot: null,
    };
  }

  if (!flags["repo-path"]) {
    throw new CliError("Missing --repo-dir or --repo-path.", 2, {
      code: "MISSING_REPO_SELECTOR",
      category: "validation",
      remediation: "Provide --repo-dir for local operations or --repo-path for indexed repo resolution.",
    });
  }

  const cloneRoot = resolveCloneRoot(flags, invocationCwd);
  const found = resolveExistingRepo({
    invocationCwd,
    cloneRoot,
    runtimeBaseUrl,
    repoPath: flags["repo-path"],
  });

  if (!found) {
    throw new CliError("No existing local repository found for requested --repo-path.", 2, {
      code: "REPO_NOT_FOUND_LOCALLY",
      category: "resolution",
      remediation: "Run repo clone first or pass --repo-dir explicitly.",
    });
  }

  return {
    ...found,
    cloneRoot,
  };
}

module.exports = {
  resolveRepoDirFromFlags,
};
