const { assertRequiredFlag } = require("../flagValidator");

async function issueCommentAddCommand(client, args, output) {
  const issueIdOrKey = args.issue;
  const body = args["comment-body"];
  const dryRun = Boolean(args["dry-run"]);

  assertRequiredFlag(args, "issue", "issue comment add");
  assertRequiredFlag(args, "comment-body", "issue comment add");

  const payload = { body };

  if (dryRun) {
    output({ mode: "issue-comment-add-dry-run", issue: issueIdOrKey, payload });
    return;
  }

  const comment = await client.addComment(issueIdOrKey, payload, 2);
  output({ mode: "issue-comment-add", issue: issueIdOrKey, comment });
}

module.exports = {
  issueCommentAddCommand,
};
