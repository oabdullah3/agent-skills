const { CliError } = require("../errors");
const { rejectUnknownFlags } = require("../utils");
const { leaveChangeAuditComment } = require("../utils/changeAuditComment");
const fs = require("fs");

function parseLabels(rawLabelValue) {
    if (!rawLabelValue) {
        return [];
    }

    return String(rawLabelValue)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseAttachmentPaths(rawAttachmentValue) {
    if (!rawAttachmentValue) {
        return [];
    }

    return String(rawAttachmentValue)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function validateAttachmentPaths(paths) {
    for (const filePath of paths) {
        if (!fs.existsSync(filePath)) {
            throw new CliError(`Attachment file does not exist: ${filePath}`, 3);
        }
        if (!fs.statSync(filePath).isFile()) {
            throw new CliError(`Attachment path is not a file: ${filePath}`, 3);
        }
    }
}

async function pageEditDetailsCommand(client, args, output) {
    rejectUnknownFlags(
        args,
        ["page-id", "comment", "label", "attachment-path", "new-title", "operation-mode", "human-approval-obtained"],
        "page edit details"
    );

    const pageId = args["page-id"];
    const operationMode = args["operation-mode"] || "prepare";
    const approvalObtained = Boolean(args["human-approval-obtained"]);
    const comment = args.comment ? String(args.comment).trim() : "";
    const labels = parseLabels(args.label);
    const attachmentPaths = parseAttachmentPaths(args["attachment-path"]);
    const newTitle = args["new-title"] ? String(args["new-title"]).trim() : "";

    if (!pageId) {
        throw new CliError("Missing required: --page-id", 3);
    }

    if (!comment && labels.length === 0 && attachmentPaths.length === 0 && !newTitle) {
        throw new CliError("Provide at least one details flag: --comment, --label, --attachment-path, or --new-title", 3);
    }

    validateAttachmentPaths(attachmentPaths);

    let currentTitle = null;
    if (newTitle) {
        let pageData;
        try {
            pageData = await client.getPage(pageId, "title");
        } catch (err) {
            throw new CliError(`Failed to load page title for rename: ${err.message}`, err.exitCode || 10);
        }

        currentTitle = String(pageData?.title || "").trim();
        if (!currentTitle) {
            throw new CliError("Unable to resolve current page title for rename", 10);
        }

        if (currentTitle === newTitle) {
            throw new CliError("--new-title matches the existing page title", 3);
        }
    }

    if (operationMode === "prepare") {
        output({
            mode: "page-edit-details-awaiting-approval",
            message: "Details update prepared. Review planned operations.",
            pageId: String(pageId),
            plannedOperations: {
                renameTitle: newTitle ? { from: currentTitle, to: newTitle } : null,
                addComment: comment || null,
                addLabels: labels,
                addAttachments: attachmentPaths,
            },
            instruction:
                "If approved, rerun with --operation-mode finalize --human-approval-obtained and the same detail flags.",
        });
        return;
    }

    if (operationMode !== "finalize") {
        throw new CliError("Unknown operation-mode. Use 'prepare' or 'finalize'.", 3);
    }

    if (!approvalObtained) {
        throw new CliError("Missing flag: --human-approval-obtained. Explicit approval required.", 3);
    }

    try {
        const result = {
            pageId: String(pageId),
        };

        if (newTitle) {
            let updatedPage;
            try {
                updatedPage = await client.updatePageTitle(pageId, newTitle);
            } catch (err) {
                throw new CliError(`Title rename failed: ${err.message}`, err.exitCode || 10);
            }

            result.title = {
                oldTitle: currentTitle,
                newTitle: updatedPage?.title || newTitle,
            };
        }

        if (comment) {
            let createdComment;
            try {
                createdComment = await client.addPageComment(pageId, comment);
            } catch (err) {
                throw new CliError(`Comment update failed: ${err.message}`, err.exitCode || 10);
            }

            result.comment = {
                commentId: createdComment.id,
                url: createdComment._links?.webui || createdComment._links?.self,
            };
        }

        if (labels.length > 0) {
            try {
                await client.addPageLabels(pageId, labels);
            } catch (err) {
                throw new CliError(`Label update failed: ${err.message}`, err.exitCode || 10);
            }
            result.labels = labels;
        }

        if (attachmentPaths.length > 0) {
            const uploaded = [];
            for (const filePath of attachmentPaths) {
                try {
                    const uploadResult = await client.addPageAttachment(pageId, filePath, "Uploaded via confluence-cli page edit details");
                    const first = uploadResult?.results?.[0] || uploadResult;
                    uploaded.push({
                        id: first?.id || null,
                        title: first?.title || first?.name || filePath,
                        sourcePath: filePath,
                    });
                } catch (err) {
                    throw new CliError(`Attachment upload failed for '${filePath}': ${err.message}`, err.exitCode || 10);
                }
            }
            result.attachments = uploaded;
        }

        const changeTypes = [];
        if (newTitle) changeTypes.push("title:rename");
        if (comment) changeTypes.push("comment:add");
        if (labels.length > 0) changeTypes.push("label:update");
        if (attachmentPaths.length > 0) changeTypes.push("attachment:add");

        const auditComment = await leaveChangeAuditComment(client, {
            operation: "page edit details",
            changeTypes,
            pageId: String(pageId),
            pageTitle: result?.title?.newTitle || currentTitle || "Unknown",
        });

        output({
            mode: "page-edit-details",
            message: "Page details updated successfully.",
            updated: result,
            auditComment,
        });
    } catch (err) {
        throw new CliError(`Failed to update page details: ${err.message}`, 10);
    }
}

module.exports = { pageEditDetailsCommand };
