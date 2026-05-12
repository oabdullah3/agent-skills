const { spawnSync } = require("child_process");
const { CliError } = require("./errors");

function runGit(args, cwd, options = {}) {
  const proc = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeout || 30000,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });

  if (proc.error) {
    throw new CliError(`Failed to execute git ${args.join(" ")}: ${proc.error.message}`, 2, {
      code: "GIT_EXEC_FAILED",
      category: "runtime",
      remediation: "Ensure git is installed and accessible in PATH.",
    });
  }

  if (proc.status !== 0 && !options.allowFailure) {
    const stderr = String(proc.stderr || "").trim();
    throw new CliError(`git ${args.join(" ")} failed: ${stderr || "unknown error"}`, 2, {
      code: "GIT_COMMAND_FAILED",
      category: "runtime",
      remediation: "Check repository state and rerun.",
      gitArgs: args,
    });
  }

  return {
    status: proc.status,
    stdout: String(proc.stdout || ""),
    stderr: String(proc.stderr || ""),
  };
}

function isGitRepo(dir) {
  const result = runGit(["rev-parse", "--is-inside-work-tree"], dir, { allowFailure: true });
  return result.status === 0 && result.stdout.trim() === "true";
}

function getOriginUrl(dir) {
  const result = runGit(["remote", "get-url", "origin"], dir, { allowFailure: true });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

module.exports = {
  runGit,
  isGitRepo,
  getOriginUrl,
};
