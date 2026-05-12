const fs = require("fs");
const path = require("path");
const { CliError } = require("../errors");

async function issueAttachmentUploadCommand(client, args, output) {
  const issueIdOrKey = args.issue;
  const filePath = args["attach-file"];
  const dryRun = Boolean(args["dry-run"]);

  if (!issueIdOrKey) {
    throw new CliError("Missing required flag: --issue", 3);
  }

  if (!filePath) {
    throw new CliError("Missing required flag: --attach-file", 3);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new CliError(`Attachment file not found: ${absPath}`, 3);
  }

  if (dryRun) {
    output({
      mode: "issue-attachment-upload-dry-run",
      issue: issueIdOrKey,
      file: {
        path: absPath,
        name: path.basename(absPath),
      },
    });
    return;
  }

  const attachment = await client.uploadAttachment(issueIdOrKey, absPath);
  output({
    mode: "issue-attachment-upload",
    issue: issueIdOrKey,
    attachment,
  });
}

module.exports = {
  issueAttachmentUploadCommand,
};
