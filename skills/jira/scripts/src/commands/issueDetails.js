const { CliError } = require("../errors");

async function issueDetailsCommand(client, args, output) {
  const issueIdOrKey = args.issue;
  const apiVersion = toInt(args.version, 3);
  const fields = args.fields || "*all";

  if (!issueIdOrKey) {
    throw new CliError("Missing required flag: --issue", 3);
  }

  if (apiVersion !== 2 && apiVersion !== 3) {
    throw new CliError("Invalid --version. Allowed values: 2 or 3", 3);
  }

  const issue = await client.getIssue(issueIdOrKey, apiVersion, fields);
  output({
    mode: "issue-details",
    issue: issueIdOrKey,
    apiVersion,
    issueData: issue,
  });
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  issueDetailsCommand,
};
