const { rejectUnknownFlags, toInt } = require("../utils");

async function meCommand(client, args, output) {
  rejectUnknownFlags(args, ["limit", "start", "recent-edits", "drafts", "saved"], "me");

  const limit = toInt(args.limit, 10);
  const start = toInt(args.start, 0);
  const profile = await client.getMyself();

  const result = {
    mode: "me",
    profile: {
      accountId: profile.accountId,
      displayName: profile.displayName,
      email: profile.email,
    },
  };

  if (args["recent-edits"]) {
    const cql = "lastModifier = currentUser() AND type = 'page' order by lastmodified desc";
    const data = await client.searchPagesCql(cql, limit, start);
    result.recentEdits = formatCqlResults(data.results || []);
  }

  if (args.drafts) {
    const drafts = await client.getMyDrafts(limit + start);
    // The /content?status=draft endpoint already returns only current user's drafts
    // Apply pagination client-side
    const paginatedDrafts = drafts.slice(start, start + limit);

    result.drafts = paginatedDrafts.map(p => ({
      id: p.id,
      title: p.title,
      spaceKey: p.space?.key || "Unknown",
      url: p._links?.webui || p._links?.self,
    }));
  }

  if (args.saved) {
    const cql = "favourite = currentUser() AND type = 'page' order by lastmodified desc";
    const data = await client.searchPagesCql(cql, limit, start);
    result.savedPages = formatCqlResults(data.results || []);
  }

  output(result);
}

function formatCqlResults(results) {
  return results.map(p => ({
    id: p.content?.id || p.id,
    title: p.content?.title || p.title,
    spaceKey: p.resultGlobalContainer?.displayUrl?.split('/')[2] || "Unknown",
    url: p._links?.webui || p.url,
  }));
}

module.exports = { meCommand };