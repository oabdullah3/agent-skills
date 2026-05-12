const { CliError } = require("../errors");
const { makeResolution, resolveInstruction } = require("../resolution");
const { assertExactlyOneOf } = require("../flagValidator");
const {
  parseTopLevelPagination,
  parseTupleFlag,
  paginateArray,
  makePaginationMeta,
} = require("../pagination");
const { createExplain } = require("../explain");

async function issueSearchCommand(client, args, output) {
  const issueKey = args["issue-key"];
  const jql = args.jql;
  const topLevelPagination = parseTopLevelPagination(args, { defaultMax: 50, defaultStart: 0 });
  const withComments = parseTupleFlag(args, "with-comments", { defaultMax: 50, defaultStart: 0 });
  const withTransitions = parseTupleFlag(args, "with-transitions", { defaultMax: 50, defaultStart: 0 });
  const withAssignable = parseTupleFlag(args, "with-assignable", { defaultMax: 50, defaultStart: 0 });
  const withWorklogs = parseTupleFlag(args, "with-worklogs", { defaultMax: 50, defaultStart: 0 });
  const withAttachments = parseTupleFlag(args, "with-attachments", { defaultMax: 50, defaultStart: 0 });
  const operationMode = String(args["operation-mode"] || "search").toLowerCase();
  const fields = "summary,status,assignee,issuetype,priority,updated";
  const fallbackBehavior = [];

  function withExplain(payload, details) {
    const explain = createExplain(args, details);
    if (!explain) {
      return payload;
    }
    return { ...payload, explain };
  }

  if (!["search", "resolve"].includes(operationMode)) {
    throw new CliError("Invalid --operation-mode for issue search. Allowed: search, resolve", 3);
  }

  // Helper to attach deep context when exactly one issue is isolated
  async function augmentSingleIssue(issueIdOrKey, baseOutput) {
    const enrichmentPagination = {};

    if (withComments.enabled) {
      const commentsData = await client.getIssueComments(issueIdOrKey, withComments.startAt, withComments.maxResults);
      baseOutput.comments = commentsData.comments || [];
      baseOutput.commentsTotal = commentsData.total;
      enrichmentPagination.comments = makePaginationMeta({
        total: Number.isInteger(commentsData.total) ? commentsData.total : baseOutput.comments.length,
        startAt: Number.isInteger(commentsData.startAt) ? commentsData.startAt : withComments.startAt,
        maxResults: Number.isInteger(commentsData.maxResults) ? commentsData.maxResults : withComments.maxResults,
        returned: baseOutput.comments.length,
        strategy: "server",
      });
    }

    if (withTransitions.enabled) {
      const transitionsData = await client.getIssueTransitions(issueIdOrKey);
      const transitionSlice = paginateArray(transitionsData.transitions || [], withTransitions.startAt, withTransitions.maxResults);
      baseOutput.transitions = transitionSlice.values;
      enrichmentPagination.transitions = makePaginationMeta({
        total: transitionSlice.total,
        startAt: transitionSlice.startAt,
        maxResults: transitionSlice.maxResults,
        returned: transitionSlice.values.length,
        strategy: "client",
      });
    }

    if (withAssignable.enabled) {
      try {
        const assignableData = await client.getAssignableUsers(
          issueIdOrKey,
          withAssignable.startAt,
          withAssignable.maxResults
        );
        const normalized = Array.isArray(assignableData)
          ? assignableData
          : Array.isArray(assignableData?.values)
            ? assignableData.values
            : [];
        baseOutput.assignableUsers = normalized.map((u) => ({
              accountId: u.accountId,
              displayName: u.displayName,
              emailAddress: u.emailAddress,
            }));
        const assignableTotal = Number.isInteger(assignableData?.total)
          ? assignableData.total
          : withAssignable.startAt + baseOutput.assignableUsers.length;
        enrichmentPagination.assignableUsers = makePaginationMeta({
          total: assignableTotal,
          startAt: withAssignable.startAt,
          maxResults: withAssignable.maxResults,
          returned: baseOutput.assignableUsers.length,
          strategy: "server",
        });
      } catch (err) {
        baseOutput.assignableUsers = [];
        baseOutput.assignableUsersError = err.message;
        fallbackBehavior.push("Assignable users lookup failed; assignableUsers returned empty with assignableUsersError.");
      }
    }

    if (withWorklogs.enabled) {
      const worklogData = await client.getIssueWorklogs(issueIdOrKey, withWorklogs.startAt, withWorklogs.maxResults);
      baseOutput.worklogs = worklogData.worklogs || [];
      enrichmentPagination.worklogs = makePaginationMeta({
        total: Number.isInteger(worklogData.total) ? worklogData.total : baseOutput.worklogs.length,
        startAt: Number.isInteger(worklogData.startAt) ? worklogData.startAt : withWorklogs.startAt,
        maxResults: Number.isInteger(worklogData.maxResults) ? worklogData.maxResults : withWorklogs.maxResults,
        returned: baseOutput.worklogs.length,
        strategy: "server",
      });
    }

    if (withAttachments.enabled) {
      const attachmentData = await client.getIssueAttachments(issueIdOrKey);
      const attachmentSlice = paginateArray(attachmentData, withAttachments.startAt, withAttachments.maxResults);
      baseOutput.attachments = attachmentSlice.values;
      enrichmentPagination.attachments = makePaginationMeta({
        total: attachmentSlice.total,
        startAt: attachmentSlice.startAt,
        maxResults: attachmentSlice.maxResults,
        returned: attachmentSlice.values.length,
        strategy: "client",
      });
    }

    if (Object.keys(enrichmentPagination).length > 0) {
      baseOutput.enrichmentPagination = enrichmentPagination;
    }

    return baseOutput;
  }

  if (operationMode === "resolve") {
    assertExactlyOneOf(args, ["issue-key", "jql"], "issue selector", "issue search resolve");

    if (issueKey) {
      try {
        const issueData = await client.getIssue(issueKey, 3, "summary");
        output(withExplain({
          mode: "issue-search-resolve",
          resolution: makeResolution("resolved", { "issue-key": issueKey }, {
            selected: {
              key: issueData?.key || issueKey,
              id: issueData?.id,
              summary: issueData?.fields?.summary || null,
            },
            instruction: resolveInstruction("issue search", "resolved"),
          }),
        }, {
          selectors: { "issue-key": issueKey, "operation-mode": operationMode },
          queryPlan: { route: "issue-key", action: "getIssue(summary)" },
          fieldsRequested: ["summary"],
          enrichmentPlan: {
            comments: withComments,
            transitions: withTransitions,
            assignableUsers: withAssignable,
            worklogs: withWorklogs,
            attachments: withAttachments,
          },
          paginationPlan: { topLevel: topLevelPagination },
          fallbackBehavior,
        }));
        return;
      } catch (err) {
        if (err?.details?.status === 404) {
          output(withExplain({
            mode: "issue-search-resolve",
            resolution: makeResolution("no-match", { "issue-key": issueKey }, {
              instruction: resolveInstruction("issue search", "no-match"),
            }),
          }, {
            selectors: { "issue-key": issueKey, "operation-mode": operationMode },
            queryPlan: { route: "issue-key", action: "getIssue(summary)" },
            fieldsRequested: ["summary"],
            enrichmentPlan: {
              comments: withComments,
              transitions: withTransitions,
              assignableUsers: withAssignable,
              worklogs: withWorklogs,
              attachments: withAttachments,
            },
            paginationPlan: { topLevel: topLevelPagination },
            fallbackBehavior,
          }));
          return;
        }
        throw err;
      }
    }

    const data = await client.searchIssuesJql(jql, topLevelPagination.maxResults, fields, topLevelPagination.startAt);
    const issues = data.issues || [];
    const candidates = issues.map((issue) => ({
      key: issue.key,
      id: issue.id,
      summary: issue?.fields?.summary || null,
    }));

    let resolution;
    if (candidates.length === 1) {
      resolution = makeResolution("resolved", { jql }, {
        selected: candidates[0],
        instruction: resolveInstruction("issue search", "resolved"),
      });
    } else if (candidates.length > 1) {
      resolution = makeResolution("ambiguous", { jql }, {
        candidates,
        instruction: resolveInstruction("issue search", "ambiguous"),
      });
    } else {
      resolution = makeResolution("no-match", { jql }, {
        instruction: resolveInstruction("issue search", "no-match"),
      });
    }

    output(withExplain({
      mode: "issue-search-resolve",
      total: data.total,
      pagination: makePaginationMeta({
        total: Number.isInteger(data.total) ? data.total : issues.length,
        startAt: Number.isInteger(data.startAt) ? data.startAt : topLevelPagination.startAt,
        maxResults: Number.isInteger(data.maxResults) ? data.maxResults : topLevelPagination.maxResults,
        returned: issues.length,
        strategy: "server",
      }),
      resolution,
    }, {
      selectors: { jql, "operation-mode": operationMode },
      queryPlan: { route: "jql", action: "searchIssuesJql", decision: resolution.status },
      fieldsRequested: fields.split(","),
      enrichmentPlan: {
        comments: withComments,
        transitions: withTransitions,
        assignableUsers: withAssignable,
        worklogs: withWorklogs,
        attachments: withAttachments,
      },
      paginationPlan: { topLevel: topLevelPagination },
      fallbackBehavior,
    }));
    return;
  }

  if (issueKey) {
    const issueData = await client.getIssue(issueKey, 3, "*all");
    const result = await augmentSingleIssue(issueKey, {
      mode: "issue-search",
      issueData,
      pagination: makePaginationMeta({
        total: 1,
        startAt: 0,
        maxResults: 1,
        returned: 1,
        strategy: "server",
      }),
      message: `Issue details returned for key ${issueKey}`,
    });
    output(withExplain(result, {
      selectors: { "issue-key": issueKey, "operation-mode": operationMode },
      queryPlan: { route: "issue-key", action: "getIssue(*all)+optional-enrichments" },
      fieldsRequested: ["*all"],
      enrichmentPlan: {
        comments: withComments,
        transitions: withTransitions,
        assignableUsers: withAssignable,
        worklogs: withWorklogs,
        attachments: withAttachments,
      },
      paginationPlan: { topLevel: { startAt: 0, maxResults: 1 } },
      fallbackBehavior,
    }));
    return;
  }

  if (!jql) {
    throw new CliError("Missing required flag: --jql (or pass --issue-key)", 3);
  }

  const data = await client.searchIssuesJql(jql, topLevelPagination.maxResults, fields, topLevelPagination.startAt);
  const issues = data.issues || [];

  if (issues.length === 1 && issues[0]?.key) {
    const matchedKey = issues[0].key;
    const issueData = await client.getIssue(matchedKey, 3, "*all");
    const result = await augmentSingleIssue(matchedKey, {
      mode: "issue-search",
      jql,
      total: 1,
      pagination: makePaginationMeta({
        total: Number.isInteger(data.total) ? data.total : issues.length,
        startAt: Number.isInteger(data.startAt) ? data.startAt : topLevelPagination.startAt,
        maxResults: Number.isInteger(data.maxResults) ? data.maxResults : topLevelPagination.maxResults,
        returned: issues.length,
        strategy: "server",
      }),
      issueData,
      message: `Single exact issue match found (${matchedKey}). Returning full details.`,
    });
    output(withExplain(result, {
      selectors: { jql, "operation-mode": operationMode },
      queryPlan: { route: "jql", action: "searchIssuesJql->single-match->getIssue(*all)" },
      fieldsRequested: ["*all"],
      enrichmentPlan: {
        comments: withComments,
        transitions: withTransitions,
        assignableUsers: withAssignable,
        worklogs: withWorklogs,
        attachments: withAttachments,
      },
      paginationPlan: { topLevel: topLevelPagination },
      fallbackBehavior,
    }));
    return;
  }

  if (issues.length > 1) {
    output(withExplain({
      mode: "issue-search",
      jql,
      total: data.total,
      pagination: makePaginationMeta({
        total: Number.isInteger(data.total) ? data.total : issues.length,
        startAt: Number.isInteger(data.startAt) ? data.startAt : topLevelPagination.startAt,
        maxResults: Number.isInteger(data.maxResults) ? data.maxResults : topLevelPagination.maxResults,
        returned: issues.length,
        strategy: "server",
      }),
      issues,
      message:
        "MULTIPLE Issues found followed by a list of issues. Please use issue key to narrow down the search to a single issue to view enrichments (comments/transitions/assignable/worklogs/attachments) or full details.",
    }, {
      selectors: { jql, "operation-mode": operationMode },
      queryPlan: { route: "jql", action: "searchIssuesJql", decision: "multiple" },
      fieldsRequested: fields.split(","),
      enrichmentPlan: {
        comments: withComments,
        transitions: withTransitions,
        assignableUsers: withAssignable,
        worklogs: withWorklogs,
        attachments: withAttachments,
      },
      paginationPlan: { topLevel: topLevelPagination },
      fallbackBehavior,
    }));
    return;
  }

  output(withExplain({
    mode: "issue-search",
    jql,
    total: data.total,
    pagination: makePaginationMeta({
      total: Number.isInteger(data.total) ? data.total : issues.length,
      startAt: Number.isInteger(data.startAt) ? data.startAt : topLevelPagination.startAt,
      maxResults: Number.isInteger(data.maxResults) ? data.maxResults : topLevelPagination.maxResults,
      returned: issues.length,
      strategy: "server",
    }),
    issues,
    message: "No issues found.",
  }, {
    selectors: { jql, "operation-mode": operationMode },
    queryPlan: { route: "jql", action: "searchIssuesJql", decision: "no-match" },
    fieldsRequested: fields.split(","),
    enrichmentPlan: {
      comments: withComments,
      transitions: withTransitions,
      assignableUsers: withAssignable,
      worklogs: withWorklogs,
      attachments: withAttachments,
    },
    paginationPlan: { topLevel: topLevelPagination },
    fallbackBehavior,
  }));
}

module.exports = {
  issueSearchCommand,
};