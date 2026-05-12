const { CliError } = require("../errors");
const {
  parseDateMutationArgs,
  buildDateFieldsPayload,
} = require("./issueActions");

async function issueDatesSetCommand(client, args, output) {
  const issueIdOrKey = args.issue;
  const dryRun = Boolean(args["dry-run"]);

  if (args["start-field-id"] !== undefined) {
    throw new CliError("Flag removed: --start-field-id is no longer supported", 3);
  }

  if (!issueIdOrKey) {
    throw new CliError("Missing required flag: --issue", 3);
  }

  const dateMutation = parseDateMutationArgs(args, { requireOne: true });
  const fields = await buildDateFieldsPayload(client, issueIdOrKey, dateMutation);

  const payload = { fields };

  if (dryRun) {
    output({ mode: "issue-dates-set-dry-run", issue: issueIdOrKey, payload });
    return;
  }

  await client.editIssue(issueIdOrKey, payload, 2);
  output({ mode: "issue-dates-set", issue: issueIdOrKey, updated: true, apiVersion: 2 });
}

module.exports = {
  issueDatesSetCommand,
};
