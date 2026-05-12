function resolveAgentName() {
    const raw = String(process.env.AGENT_NAME || "AGENT").trim();
    if (!raw) return "AGENT";
    return raw;
}

function formatAuditComment({ operation, changeTypes, pageId, pageTitle, actorEmail, timestampIso }) {
    const safeChangeTypes = Array.isArray(changeTypes) && changeTypes.length > 0
        ? changeTypes.join(", ")
        : "unspecified";
    const agentName = resolveAgentName();

    return [
        `[${agentName} Change Audit]`,
        `Operation: ${operation || "unknown"}`,
        `Change types: ${safeChangeTypes}`,
        `Timestamp (UTC): ${timestampIso}`,
        `Actor email: ${actorEmail || "unknown"}`,
        `Page ID: ${String(pageId || "unknown")}`,
        `Page title: ${pageTitle || "unknown"}`,
        `Source: ${agentName} agent via confluence-cli`,
    ].join("\n");
}

async function leaveChangeAuditComment(client, { operation, changeTypes, pageId, pageTitle }) {
    const timestampIso = new Date().toISOString();
    const actorEmail = client && client.email ? String(client.email) : "unknown";

    if (!client || !pageId || typeof client.addPageComment !== "function") {
        return {
            status: "skipped",
            reason: "Missing client/addPageComment or pageId",
            timestampIso,
            actorEmail,
            operation,
            changeTypes,
        };
    }

    const commentText = formatAuditComment({
        operation,
        changeTypes,
        pageId,
        pageTitle,
        actorEmail,
        timestampIso,
    });

    try {
        const created = await client.addPageComment(String(pageId), commentText);
        return {
            status: "created",
            commentId: created?.id || null,
            timestampIso,
            actorEmail,
            operation,
            changeTypes,
        };
    } catch (err) {
        return {
            status: "failed",
            error: err && err.message ? err.message : String(err),
            timestampIso,
            actorEmail,
            operation,
            changeTypes,
        };
    }
}

module.exports = {
    leaveChangeAuditComment,
};
