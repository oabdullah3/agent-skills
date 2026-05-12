const { runGit } = require("../gitRunner");
const { resolveRepoDirFromFlags } = require("../workspaceResolver");

function parseStatusLines(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const files = lines.filter((l) => !l.startsWith("##")).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3),
  }));
  const branch = lines.find((l) => l.startsWith("##")) || null;
  return { branch, files };
}

async function repoStatusCommand(flags, output, context) {
  const resolved = resolveRepoDirFromFlags(flags, context.invocationCwd, context.runtimeBaseUrl);
  const statusRaw = runGit(["status", "--porcelain", "--branch"], resolved.repoDir).stdout;
  const diffSummary = runGit(["diff", "--stat"], resolved.repoDir, { allowFailure: true }).stdout;
  const parsed = parseStatusLines(statusRaw);

  output.print({
    mode: "success",
    command: "repo status",
    operationMode: null,
    result: {
      repoDir: resolved.repoDir,
      branch: parsed.branch,
      changedFiles: parsed.files,
      diffStat: diffSummary.trim() || null,
      hasChanges: parsed.files.length > 0,
    },
    metadata: {
      detectionSource: resolved.detectionSource,
      cloneRoot: resolved.cloneRoot,
      gitlabBaseUrl: context.runtimeBaseUrl,
    },
    warnings: [],
    nextSteps: [],
  });
}

module.exports = {
  repoStatusCommand,
};
