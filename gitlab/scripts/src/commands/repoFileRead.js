const { Buffer } = require("buffer");
const { requireFlag } = require("../flagValidator");
const { requireResolvedRepo } = require("./repoResolve");

function decodeBase64(value) {
  if (!value) return "";
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch (_) {
    return "";
  }
}

async function repoFileReadCommand(client, flags, output) {
  requireFlag(flags, "file-path", "Missing --file-path for repo file read.");

  const repo = await requireResolvedRepo(client, flags, output, "repo file read", "read");
  if (!repo) return;

  const ref = flags.ref || repo.default_branch || "main";
  const file = await client.getFile({
    projectId: repo.id,
    filePath: flags["file-path"],
    ref,
  });

  const decoded = decodeBase64(file.content);
  const includeContent = !flags["content-only"] || flags["include-content"];

  output.print({
    mode: "success",
    command: "repo file read",
    operationMode: "read",
    result: {
      repo: {
        id: repo.id,
        path_with_namespace: repo.path_with_namespace,
      },
      file: {
        file_path: file.file_path,
        ref,
        size: file.size,
        encoding: file.encoding,
        content_sha256: file.content_sha256,
        last_commit_id: file.last_commit_id,
        execute_filemode: Boolean(file.execute_filemode),
      },
      ...(includeContent ? { content: decoded } : {}),
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
    },
    warnings: includeContent ? [] : ["Content omitted; rerun with --include-content to include file body."],
    nextSteps: [],
  });
}

module.exports = {
  repoFileReadCommand,
};