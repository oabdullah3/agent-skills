const { CliError } = require("../errors");

async function issueAcceptanceSetCommand(client, args, output) {
  const issueIdOrKey = args.issue;
  const fieldId = args["acceptance-field-id"];
  const value = args["acceptance-value"];
  const dryRun = Boolean(args["dry-run"]);

  if (!issueIdOrKey) {
    throw new CliError("Missing required flag: --issue", 3);
  }

  if (!fieldId) {
    throw new CliError("Missing required flag: --acceptance-field-id", 3);
  }

  if (!fieldId.startsWith("customfield_")) {
    throw new CliError("Invalid --acceptance-field-id. Expected format customfield_<id>", 3);
  }

  if (!value) {
    throw new CliError("Missing required flag: --acceptance-value", 3);
  }

  const payload = {
    fields: {
      [fieldId]: value,
    },
  };

  if (dryRun) {
    output({ mode: "issue-acceptance-set-dry-run", issue: issueIdOrKey, payload });
    return;
  }

  await client.editIssue(issueIdOrKey, payload, 2);
  output({ mode: "issue-acceptance-set", issue: issueIdOrKey, updated: true, apiVersion: 2 });
}

module.exports = {
  issueAcceptanceSetCommand,
};
