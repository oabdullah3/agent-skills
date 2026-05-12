const { CliError } = require("../errors");
const { rejectUnknownFlags } = require("../utils");
const fs = require("fs");
const MarkdownIt = require("markdown-it");
const { adfToMarkdown, markdownToAdf } = require("../utils/adfConverter");
const { buildPatchedAdfFromMarkdown, deriveTargetHeadingsFromEditedMarkdown } = require("../utils/sectionPatcher");
const { leaveChangeAuditComment } = require("../utils/changeAuditComment");
const { generateDiff, summarizeChanges, formatDiffOutput } = require("../utils/contentDiff");
const { getPipePath, writePipe, extractMetadata, storeMetadata, loadMetadata, clearBoth, validatePipeWritten } = require("../utils/pipeMetadata");
const { normalizePipeWrittenFlag, resolvePageForEdit, parseAtlasDocBody } = require("./pageEditCommon");

async function pageEditContentCommand(client, args, output) {
    rejectUnknownFlags(
        args,
        [
            "page-id",
            "page-title",
            "query",
            "space-key",
            "space-name",
            "cql",
            "operation-mode",
            "pipe-changed",
            "pipe-file-written-to",
            "human-approval-obtained",
            "pipe-dir",
            "inline-attachment-path",
            "inline-comment",
            "patch-scope",
            "target-heading",
            "patch-mode",
            "full-rewrite",
        ],
        "page edit content"
    );

    const pageId = args["page-id"];
    const pageTitle = args["page-title"];
    const searchQuery = args.query;
    const rawCql = args.cql;
    const spaceKey = args["space-key"];
    const spaceName = args["space-name"];
    const pipeDir = args["pipe-dir"];
    const inlineAttachmentPaths = parseAttachmentPaths(args["inline-attachment-path"]);
    const inlineCommentEnabled = Boolean(args["inline-comment"]);
    const patchScope = args["patch-scope"] ? String(args["patch-scope"]).trim() : "";
    const targetHeadings = parseTargetHeadings(args["target-heading"]);
    const patchMode = args["patch-mode"] ? String(args["patch-mode"]).trim() : "replace";
    const patchModeProvided = Object.prototype.hasOwnProperty.call(args, "patch-mode");
    const fullRewrite = Boolean(args["full-rewrite"]);

    const operationMode = args["operation-mode"] || "prepare";
    const pipeWritten = normalizePipeWrittenFlag(args);
    const approvalObtained = Boolean(args["human-approval-obtained"]);

    let actualMode = operationMode;
    if (pipeWritten && operationMode === "prepare") {
        actualMode = "show-changes";
    }

    const needsResolve = !pageId && (pageTitle || searchQuery || rawCql);
    if (needsResolve && actualMode === "prepare") {
        actualMode = "resolve";
    }

    if (actualMode === "resolve") {
        const resolved = await resolvePageForEdit(client, { pageTitle, searchQuery, rawCql, spaceKey, spaceName });
        if (resolved.mode === "none") {
            output({
                mode: "page-not-found",
                message: "No pages matched your search criteria.",
                cql: resolved.cql,
            });
            return;
        }

        if (resolved.mode === "ambiguous") {
            output({
                mode: "page-ambiguous",
                message: "Multiple pages matched. Please rerun with --page-id.",
                cql: resolved.cql,
                candidates: resolved.pages,
            });
            return;
        }

        output({
            mode: "page-resolved",
            message: "Page resolved.",
            resolvedPageId: resolved.page.id,
            pageDetails: resolved.page,
            nextStep: `Run again with --page-id ${resolved.page.id} --operation-mode prepare`,
        });
        return;
    }

    if (!pageId) {
        throw new CliError("Missing required: --page-id OR --page-title/--query/--cql", 3);
    }

    validatePatchFlags({ patchScope, targetHeadings, patchMode, patchModeProvided, fullRewrite });

    validateAttachmentPaths(inlineAttachmentPaths);

    if (actualMode === "prepare") {
        return handlePrepare(client, pageId, pipeDir, inlineAttachmentPaths, inlineCommentEnabled, output);
    }

    if (actualMode === "show-changes") {
        return handleShowChanges(pageId, pipeWritten, pipeDir, inlineCommentEnabled, {
            patchScope,
            targetHeadings,
            patchMode,
            fullRewrite,
        }, output);
    }

    if (actualMode === "finalize") {
        return handleFinalize(client, pageId, approvalObtained, pipeDir, inlineCommentEnabled, {
            patchScope,
            targetHeadings,
            patchMode,
            fullRewrite,
        }, output);
    }

    throw new CliError(`Unknown operation-mode: ${actualMode}. Use 'resolve', 'prepare', 'show-changes', or 'finalize'.`, 3);
}

function parseAttachmentPaths(rawValue) {
    if (!rawValue) return [];
    return String(rawValue)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseTargetHeadings(rawValue) {
    if (!rawValue) return [];
    const list = Array.isArray(rawValue) ? rawValue : [rawValue];
    return list
        .flatMap((entry) => String(entry).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
}

function validatePatchFlags({ patchScope, targetHeadings, patchMode, patchModeProvided, fullRewrite }) {
    const hasPatchScope = Boolean(patchScope);
    const hasTargets = targetHeadings.length > 0;
    const hasPatchMode = Boolean(patchModeProvided);
    const hasPatchConfig = hasPatchScope || hasTargets || hasPatchMode;

    if (fullRewrite && hasPatchConfig) {
        throw new CliError("--full-rewrite cannot be combined with --patch-scope/--target-heading/--patch-mode", 3);
    }

    if (!hasPatchConfig) return;

    if (!hasPatchScope) {
        throw new CliError("--target-heading/--patch-mode requires --patch-scope", 3);
    }

    if (!["heading", "section"].includes(patchScope)) {
        throw new CliError("Invalid --patch-scope. Use heading or section.", 3);
    }

    if (!hasTargets) {
        throw new CliError("--patch-scope requires at least one --target-heading", 3);
    }

    if (!["replace", "append", "prepend"].includes(patchMode)) {
        throw new CliError("Invalid --patch-mode. Use replace, append, or prepend.", 3);
    }
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function resolvePatchApplication(metadata, editedMarkdown, patchOptions) {
    if (patchOptions.fullRewrite) {
        const fullTree = markdownToAdf(editedMarkdown);
        return {
            newAdfTree: fullTree,
            effectiveMarkdown: adfToMarkdown(fullTree),
            patchReport: null,
            patchMeta: {
                strategy: "full-rewrite",
                autoDerived: false,
                usedTargets: [],
                warnings: [],
            },
        };
    }

    const explicitPatch = Boolean(patchOptions.patchScope);
    const scope = patchOptions.patchScope || "heading";
    const mode = patchOptions.patchMode || "replace";

    let targets = patchOptions.targetHeadings || [];
    let autoDerived = false;
    const warnings = [];

    if (!explicitPatch) {
        targets = deriveTargetHeadingsFromEditedMarkdown(
            metadata.originalMarkdown || "",
            editedMarkdown || ""
        );
        autoDerived = true;
    }

    if (!targets || targets.length === 0) {
        const unchanged = String(metadata.originalMarkdown || "") === String(editedMarkdown || "");
        if (unchanged) {
            const preservedTree = deepClone(metadata.originalAdf || { type: "doc", version: 1, content: [] });
            return {
                newAdfTree: preservedTree,
                effectiveMarkdown: adfToMarkdown(preservedTree),
                patchReport: [],
                patchMeta: {
                    strategy: "patch-preserve-noop",
                    autoDerived,
                    usedTargets: [],
                    warnings,
                },
            };
        }

        if (explicitPatch) {
            throw new CliError("Scoped patch requested but no target headings were resolved.", 3);
        }

        warnings.push("Default patch mode could not infer changed headings; falling back to full rewrite.");
        const fullTree = markdownToAdf(editedMarkdown);
        return {
            newAdfTree: fullTree,
            effectiveMarkdown: adfToMarkdown(fullTree),
            patchReport: null,
            patchMeta: {
                strategy: "auto-fallback-full-rewrite",
                autoDerived,
                usedTargets: [],
                warnings,
            },
        };
    }

    try {
        const patched = buildPatchedAdfFromMarkdown({
            originalAdf: metadata.originalAdf,
            originalMarkdown: metadata.originalMarkdown || "",
            editedMarkdown,
            targetHeadings: targets,
            patchMode: mode,
            patchScope: scope,
        });

        return {
            newAdfTree: patched.patchedAdf,
            effectiveMarkdown: adfToMarkdown(patched.patchedAdf),
            patchReport: patched.patchReport,
            patchMeta: {
                strategy: explicitPatch ? "scoped-explicit" : "scoped-default-auto",
                autoDerived,
                usedTargets: targets,
                warnings,
            },
        };
    } catch (err) {
        if (explicitPatch) {
            throw err;
        }

        warnings.push(`Default patch mode failed (${err.message}); falling back to full rewrite.`);
        const fullTree = markdownToAdf(editedMarkdown);
        return {
            newAdfTree: fullTree,
            effectiveMarkdown: adfToMarkdown(fullTree),
            patchReport: null,
            patchMeta: {
                strategy: "auto-fallback-full-rewrite",
                autoDerived,
                usedTargets: targets,
                warnings,
            },
        };
    }
}

function validateAttachmentPaths(paths) {
    for (const filePath of paths) {
        if (!fs.existsSync(filePath)) {
            throw new CliError(`Inline attachment file does not exist: ${filePath}`, 3);
        }
        if (!fs.statSync(filePath).isFile()) {
            throw new CliError(`Inline attachment path is not a file: ${filePath}`, 3);
        }
    }
}

function markerForAttachment(name) {
    return `[INLINE_ATTACHMENT:${name}]`;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mediaPlaceholderForAttachment(attachment) {
    const safeAlt = String(attachment.title || "attachment").replace(/"/g, "");
    const safeId = String(attachment.mediaId || attachment.id || "").replace(/"/g, "");
    const safeCollection = String(attachment.collection || "").replace(/"/g, "");
    return `<!-- CONFLUENCE_MEDIA type="file" alt="${safeAlt}" id="${safeId}" collection="${safeCollection}" -->`;
}

function applyInlineAttachmentMarkers(markdown, inlineAttachments = []) {
    let transformed = String(markdown || "");
    for (const attachment of inlineAttachments) {
        if (!attachment.marker || !attachment.id) {
            continue;
        }
        const placeholder = mediaPlaceholderForAttachment(attachment);
        const markerLinePattern = new RegExp(`^\\s*${escapeRegExp(attachment.marker)}\\s*$`, "gm");
        transformed = transformed.replace(markerLinePattern, placeholder);
        transformed = transformed.split(attachment.marker).join(placeholder);
    }
    return transformed;
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while (true) {
        const found = haystack.indexOf(needle, idx);
        if (found === -1) break;
        count += 1;
        idx = found + needle.length;
    }
    return count;
}

function findOccurrenceOffsets(haystack, needle) {
    if (!needle) return [];
    const offsets = [];
    let idx = 0;
    while (true) {
        const found = haystack.indexOf(needle, idx);
        if (found === -1) break;
        offsets.push(found);
        idx = found + needle.length;
    }
    return offsets;
}

function normalizeWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

function markdownToPlainText(markdown) {
    const md = new MarkdownIt("commonmark");
    const tokens = md.parse(String(markdown || ""), {});
    const pieces = [];

    for (const token of tokens) {
        if (token.type === "inline" && Array.isArray(token.children)) {
            for (const child of token.children) {
                if (child.type === "text" || child.type === "code_inline") {
                    pieces.push(child.content || "");
                }
            }
        } else if (token.type === "fence" || token.type === "code_block") {
            pieces.push(token.content || "");
        }
    }

    return pieces.join(" ");
}

function computeSelectionStats(sourceMarkdown, selectionPlainText, preferredMatchIndex = 0) {
    const fullPlain = normalizeWhitespace(markdownToPlainText(sourceMarkdown));
    const normalizedSelection = normalizeWhitespace(selectionPlainText);
    const offsets = findOccurrenceOffsets(fullPlain, normalizedSelection);
    const matchCount = offsets.length;
    const safePreferred = Number.isInteger(preferredMatchIndex) && preferredMatchIndex >= 0 ? preferredMatchIndex : 0;
    return {
        matchCount,
        matchIndex: matchCount > 0 ? Math.min(safePreferred, matchCount - 1) : 0,
    };
}

function resolveSelectionStatsFromPlain(fullPlain, selectionPlainText, preferredMatchIndex = 0, minOffset = 0) {
    const normalizedSelection = normalizeWhitespace(selectionPlainText);
    const offsets = findOccurrenceOffsets(fullPlain, normalizedSelection);
    const matchCount = offsets.length;
    if (matchCount === 0) {
        return { matchCount: 0, matchIndex: 0, matchedOffset: -1 };
    }

    const safePreferred = Number.isInteger(preferredMatchIndex) && preferredMatchIndex >= 0 ? preferredMatchIndex : 0;
    let chosenIndex = Math.min(safePreferred, matchCount - 1);

    for (let idx = 0; idx < offsets.length; idx++) {
        if (offsets[idx] >= minOffset) {
            chosenIndex = idx;
            break;
        }
    }

    return {
        matchCount,
        matchIndex: chosenIndex,
        matchedOffset: offsets[chosenIndex],
    };
}

function stripLinePrefix(line) {
    return String(line || "")
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}(?:[-*+]\s+|\d+\.\s+)/, "")
        .replace(/^\s*>\s+/, "")
        .trim();
}

function expandInlineCommentTargets(selectedText, fallbackSelectionPlainText) {
    const raw = String(selectedText || "");
    const lines = raw.split(/\r?\n/);
    const targets = [];

    for (const line of lines) {
        const cleaned = stripLinePrefix(line);
        if (!cleaned) continue;
        const plain = normalizeWhitespace(markdownToPlainText(cleaned));
        if (plain) {
            targets.push({
                raw: cleaned,
                plain,
            });
        }
    }

    if (targets.length > 0) {
        return targets;
    }

    const fallback = normalizeWhitespace(fallbackSelectionPlainText);
    return fallback
        ? [
              {
                  raw: fallback,
                  plain: fallback,
              },
          ]
        : [];
}

function injectExistingMarkerAtFirstMatch(markdown, commentId, targetText, startIndex = 0) {
    const source = String(markdown || "");
    const target = String(targetText || "");
    if (!target) {
        return { markdown: source, injected: false, nextIndex: startIndex };
    }

    const idx = source.indexOf(target, Math.max(0, startIndex));
    if (idx === -1) {
        return { markdown: source, injected: false, nextIndex: startIndex };
    }

    const marker = `[INLINE_COMMENT_EXISTING:${commentId}]${target}[INLINE_COMMENT_END]`;
    return {
        markdown: `${source.slice(0, idx)}${marker}${source.slice(idx + target.length)}`,
        injected: true,
        nextIndex: idx + marker.length,
    };
}

function extractInlineCommentIntents(markdown) {
    const text = String(markdown || "");
    const startRegex = /\[(INLINE_COMMENT_START|INLINE_COMMENT_EXISTING):([\s\S]*?)\]/g;
    const endToken = "[INLINE_COMMENT_END]";

    const intents = [];
    let cleaned = "";
    let cursor = 0;
    let match;

    while ((match = startRegex.exec(text)) !== null) {
        const startIndex = match.index;
        const markerEndIndex = startRegex.lastIndex;
        const markerType = String(match[1] || "").trim();
        const markerPayload = String(match[2] || "").trim();

        let commentId = null;
        let commentText = "";

        if (markerType === "INLINE_COMMENT_EXISTING") {
            commentId = markerPayload.trim();
            if (!commentId) {
                throw new CliError("Invalid INLINE_COMMENT_EXISTING marker: missing id.", 3);
            }
        } else {
            commentText = markerPayload;
        }

        if (markerType === "INLINE_COMMENT_START" && !commentText) {
            throw new CliError("Invalid inline comment marker: comment text is required.", 3);
        }

        const endIndex = text.indexOf(endToken, markerEndIndex);
        if (endIndex === -1) {
            throw new CliError("Invalid inline comment markers: missing INLINE_COMMENT_END.", 3);
        }

        const segmentBeforeMarker = text.slice(cursor, startIndex);
        if (segmentBeforeMarker.includes(endToken)) {
            throw new CliError("Invalid inline comment markers: INLINE_COMMENT_END found without matching start marker.", 3);
        }

        cleaned += segmentBeforeMarker;
        const selectedRaw = text.slice(markerEndIndex, endIndex);
        const selectedText = selectedRaw.trim();

        if (!selectedText) {
            throw new CliError("Invalid inline comment markers: selected text between start/end markers cannot be empty.", 3);
        }

        const selectionStartInCleaned = cleaned.length;
        if (markerType === "INLINE_COMMENT_EXISTING") {
            cleaned += `${match[0]}${selectedRaw}${endToken}`;
        } else {
            cleaned += selectedRaw;
        }

        intents.push({
            commentText,
            existingCommentId: commentId,
            selectedText,
            selectionStartInCleaned,
        });

        cursor = endIndex + endToken.length;
        startRegex.lastIndex = cursor;
    }

    const trailing = text.slice(cursor);
    if (trailing.includes(endToken)) {
        throw new CliError("Invalid inline comment markers: INLINE_COMMENT_END found without matching start marker.", 3);
    }

    cleaned += trailing;

    const enriched = intents.map((intent) => {
        const selectionPlainText = normalizeWhitespace(markdownToPlainText(intent.selectedText));
        if (!selectionPlainText) {
            throw new CliError("Invalid inline comment selection: marker-wrapped text resolves to empty plain text.", 3);
        }

        const fullPlain = normalizeWhitespace(markdownToPlainText(cleaned));
        const priorPlain = normalizeWhitespace(markdownToPlainText(cleaned.slice(0, intent.selectionStartInCleaned)));

        const matchCount = countOccurrences(fullPlain, selectionPlainText);
        const matchIndex = countOccurrences(priorPlain, selectionPlainText);

        return {
            commentText: intent.commentText,
            existingCommentId: intent.existingCommentId,
            selectedText: intent.selectedText,
            selectionPlainText,
            matchCount,
            matchIndex,
        };
    });

    return {
        cleanedMarkdown: cleaned,
        intents: enriched,
    };
}

async function handlePrepare(client, pageId, pipeDir, inlineAttachmentPaths, inlineCommentEnabled, output) {
    const uploadedInlineAttachments = [];
    for (const filePath of inlineAttachmentPaths) {
        const upload = await client.addPageAttachment(pageId, filePath, "Uploaded for inline insertion via page edit content");
        const first = upload?.results?.[0] || upload;
        const title = first?.title || filePath.split("/").pop();
        uploadedInlineAttachments.push({
            id: first?.id,
            mediaId: first?.extensions?.fileId || null,
            collection: first?.extensions?.collectionName || null,
            title,
            sourcePath: filePath,
            marker: markerForAttachment(title),
        });
    }

    const pageContent = await client.getPageContent(pageId, "atlas_doc_format");
    if (!pageContent || !pageContent.body) {
        throw new CliError(`Unable to fetch content for page ${pageId}`, 10);
    }

    const adfTree = parseAtlasDocBody(pageContent);
    if (!adfTree) {
        throw new CliError("Page content is not in ADF format.", 10);
    }

    const markdown = adfToMarkdown(adfTree);

    writePipe(markdown, pipeDir);

    const metadata = extractMetadata(adfTree, markdown);
    metadata.pageId = String(pageId);
    metadata.pageTitle = pageContent.title;
    metadata.versionNumber = pageContent.version?.number || 1;
    metadata.inlineAttachments = uploadedInlineAttachments;
    storeMetadata(metadata, pipeDir);

    output({
        mode: "page-edit-content-ready",
        message: "Page content written to pipe. Edit and rerun with show-changes.",
        pageDetails: {
            id: String(pageId),
            title: pageContent.title,
            space: pageContent.space?.key || "Unknown",
            lastModified: pageContent.version?.when || "Unknown",
            url: pageContent._links?.webui || pageContent._links?.self,
        },
        pipeLocation: getPipePath(pipeDir),
        inlineAttachmentInsertions: uploadedInlineAttachments.map((a) => ({
            marker: a.marker,
            sourcePath: a.sourcePath,
            attachmentId: a.id,
            mediaId: a.mediaId,
            collection: a.collection,
            attachmentTitle: a.title,
        })),
        existingInlineComments: undefined,
        existingInlineCommentInjection: undefined,
        existingInlineCommentsWarning: undefined,
        instruction:
            "1. Edit the content in the pipe file\n" +
            (uploadedInlineAttachments.length > 0
                ? "1a. To insert uploaded inline attachment(s), paste marker(s) exactly as provided in inlineAttachmentInsertions on their own line\n"
                : "") +
            (inlineCommentEnabled
                ? "1b. Existing inline comments are represented as [INLINE_COMMENT_EXISTING:<id>] ... [INLINE_COMMENT_END]. Keep these markers to preserve existing comments.\n1c. To add a new inline comment, wrap target text with: [INLINE_COMMENT_START: your comment text] target phrase [INLINE_COMMENT_END]\n"
                : "") +
            "2. Rerun with --operation-mode show-changes --pipe-changed\n" +
            "3. In user-facing chat, describe the intended edits in natural language (avoid exposing raw CLI syntax unless user asks)",
    });
}

async function handleShowChanges(pageId, pipeWritten, pipeDir, inlineCommentEnabled, patchOptions, output) {
    if (!pipeWritten) {
        throw new CliError("Missing flag: --pipe-changed (or legacy --pipe-file-written-to).", 3);
    }

    const metadata = loadMetadata(pipeDir);
    if (!metadata) {
        throw new CliError("Metadata not found. Run prepare first.", 3);
    }

    const pipeValidation = validatePipeWritten(pipeDir);
    if (!pipeValidation.written) {
        throw new CliError(pipeValidation.message, 3);
    }

    let inlineCommentPlan = null;
    if (inlineCommentEnabled) {
        const parsed = extractInlineCommentIntents(pipeValidation.content || "");
        inlineCommentPlan = {
            count: parsed.intents.length,
            comments: parsed.intents.map((i) => ({
                commentText: i.existingCommentId ? null : i.commentText,
                existingCommentId: i.existingCommentId || null,
                selectedTextPreview: i.selectionPlainText.length > 120 ? `${i.selectionPlainText.slice(0, 120)}...` : i.selectionPlainText,
            })),
        };
    }

    const rawEditedMarkdown = pipeValidation.content || "";
    const patchResolved = resolvePatchApplication(metadata, rawEditedMarkdown, patchOptions);
    const effectiveMarkdown = patchResolved.effectiveMarkdown;
    const patchReport = patchResolved.patchReport;

    const diff = generateDiff(metadata.originalMarkdown || "", effectiveMarkdown);
    const summary = summarizeChanges(diff);
    const diffText = formatDiffOutput(diff.hunks, ".confluence-pipe");

    output({
        mode: "page-edit-content-changes-ready",
        message: summary.summary,
        pageDetails: {
            id: String(pageId),
            title: metadata.pageTitle || "Unknown",
        },
        changes: summary.details,
        hasChanges: diff.hasChanges,
        inlineCommentPlan,
        patchPlan: patchReport,
        patchMeta: patchResolved.patchMeta,
        diffHunks: diff.hunks,
        diffFull: diffText,
        diffPreview: diffText.length > 4000 ? `${diffText.slice(0, 4000)}\n... (truncated)` : diffText,
        instruction:
            "Before requesting approval, share ALL proposed additions/removals and approximate locations (by nearby headings/lines) in natural language.\n" +
            "Do not request approval with only counts or a truncated summary.\n" +
            "If approved, rerun with --operation-mode finalize --human-approval-obtained.\n" +
            "If more edits are needed, update the pipe file and rerun show-changes.",
    });
}

async function handleFinalize(client, pageId, approvalObtained, pipeDir, inlineCommentEnabled, patchOptions, output) {
    if (!approvalObtained) {
        throw new CliError("Missing flag: --human-approval-obtained. Explicit approval required.", 3);
    }

    const metadata = loadMetadata(pipeDir);
    if (!metadata) {
        throw new CliError("Metadata not found. Run prepare first.", 3);
    }

    const pipeValidation = validatePipeWritten(pipeDir);
    if (!pipeValidation.written) {
        throw new CliError("Pipe file is empty or missing.", 3);
    }

    const parsedInlineComments = inlineCommentEnabled
        ? extractInlineCommentIntents(pipeValidation.content)
        : { cleanedMarkdown: pipeValidation.content, intents: [] };

    const modifiedMarkdown = applyInlineAttachmentMarkers(
        parsedInlineComments.cleanedMarkdown,
        metadata.inlineAttachments || []
    );
    const patchResolved = resolvePatchApplication(metadata, modifiedMarkdown, patchOptions);
    const newAdfTree = patchResolved.newAdfTree;
    const patchReport = patchResolved.patchReport;

    try {
        const updated = await client.updatePageContent(
            String(pageId),
            metadata.pageTitle || "Untitled",
            "atlas_doc_format",
            newAdfTree,
            metadata.versionNumber
        );

        let updatedMarkdown = modifiedMarkdown;
        try {
            const updatedContent = await client.getPageContent(pageId, "atlas_doc_format");
            const updatedAdfTree = parseAtlasDocBody(updatedContent);
            if (updatedAdfTree) {
                updatedMarkdown = adfToMarkdown(updatedAdfTree);
            }
        } catch (_err) {
            // Fallback to local markdown if refetch fails.
        }

        const inlineCommentResults = [];
        const updatedPlain = normalizeWhitespace(markdownToPlainText(updatedMarkdown));
        let globalCursor = 0;
        const pendingPropagation = [];
        for (const intent of parsedInlineComments.intents) {
            if (intent.existingCommentId) {
                inlineCommentResults.push({
                    commentText: null,
                    existingCommentId: intent.existingCommentId,
                    status: "preserved",
                });
                continue;
            }

            const fullBlockStats = computeSelectionStats(updatedMarkdown, intent.selectionPlainText, intent.matchIndex);
            if (fullBlockStats.matchCount > 0) {
                try {
                    const createdSingle = await client.addPageInlineComment(String(pageId), intent.commentText, {
                        textSelection: intent.selectionPlainText,
                        textSelectionMatchCount: fullBlockStats.matchCount,
                        textSelectionMatchIndex: fullBlockStats.matchIndex,
                    });

                    inlineCommentResults.push({
                        commentText: intent.commentText,
                        existingCommentId: null,
                        status: "created",
                        commentId: createdSingle?.id || null,
                        createdCount: 1,
                        strategy: "full-block",
                    });
                    continue;
                } catch (_err) {
                    // Fall back to segment-based creation below.
                }
            }

            const targets = expandInlineCommentTargets(intent.selectedText, intent.selectionPlainText);
            if (targets.length === 0) {
                inlineCommentResults.push({
                    commentText: intent.commentText,
                    existingCommentId: null,
                    status: "failed",
                    reason: "Selected text could not be resolved into inline comment targets.",
                });
                continue;
            }

            const primaryTarget = targets[0];
            const primaryStats = resolveSelectionStatsFromPlain(updatedPlain, primaryTarget.plain, intent.matchIndex, globalCursor);
            if (primaryStats.matchCount <= 0) {
                inlineCommentResults.push({
                    commentText: intent.commentText,
                    existingCommentId: intent.existingCommentId || null,
                    status: "failed",
                    reason: `No match for first target '${primaryTarget.plain.slice(0, 120)}${primaryTarget.plain.length > 120 ? "..." : ""}'`,
                });
                continue;
            }

            try {
                const created = await client.addPageInlineComment(String(pageId), intent.commentText, {
                    textSelection: primaryTarget.plain,
                    textSelectionMatchCount: primaryStats.matchCount,
                    textSelectionMatchIndex: primaryStats.matchIndex,
                });

                const createdId = created?.id || null;
                const createdMarkerId =
                    created?.properties?.inlineMarkerRef ||
                    created?.properties?.["inline-marker-ref"] ||
                    null;
                globalCursor = primaryStats.matchedOffset + primaryTarget.plain.length;

                const propagationTargets = targets;
                const additionalPropagationTargets = Math.max(0, targets.length - 1);
                if (createdMarkerId && propagationTargets.length > 0) {
                    pendingPropagation.push({
                        markerId: createdMarkerId,
                        targets: propagationTargets,
                    });
                }

                inlineCommentResults.push({
                    commentText: intent.commentText,
                    existingCommentId: intent.existingCommentId || null,
                    status: "created",
                    commentId: createdId,
                    markerId: createdMarkerId,
                    createdCount: 1,
                    propagatedTargets: additionalPropagationTargets,
                    strategy: additionalPropagationTargets > 0 ? "first-line-plus-propagation" : "first-line-only",
                    propagationReady: Boolean(createdMarkerId),
                });
            } catch (err) {
                inlineCommentResults.push({
                    commentText: intent.commentText,
                    existingCommentId: intent.existingCommentId || null,
                    status: "failed",
                    reason: `${err.message} (selection='${primaryTarget.plain.slice(0, 120)}${primaryTarget.plain.length > 120 ? "..." : ""}', matches=${primaryStats.matchCount}, index=${primaryStats.matchIndex})`,
                });
            }
        }

        if (pendingPropagation.length > 0) {
            let propagationMarkdown = updatedMarkdown;
            let totalInjected = 0;
            const propagationFailures = [];
            let cursor = 0;

            for (const item of pendingPropagation) {
                for (const target of item.targets) {
                    const injectedByRaw = injectExistingMarkerAtFirstMatch(propagationMarkdown, item.markerId, target.raw, cursor);
                    const injected = injectedByRaw.injected
                        ? injectedByRaw
                        : injectExistingMarkerAtFirstMatch(propagationMarkdown, item.markerId, target.plain, cursor);
                    propagationMarkdown = injected.markdown;
                    if (injected.injected) {
                        totalInjected += 1;
                        cursor = injected.nextIndex;
                    } else {
                        propagationFailures.push(
                            `Unable to propagate marker ${item.markerId} to '${target.plain.slice(0, 80)}${target.plain.length > 80 ? "..." : ""}'`
                        );
                    }
                }
            }

            if (totalInjected > 0) {
                try {
                    const refreshed = await client.getPageContent(pageId, "atlas_doc_format");
                    const refreshedVersion = refreshed?.version?.number;
                    const propagationAdf = markdownToAdf(propagationMarkdown);
                    await client.updatePageContent(
                        String(pageId),
                        metadata.pageTitle || "Untitled",
                        "atlas_doc_format",
                        propagationAdf,
                        Number.isInteger(refreshedVersion) ? refreshedVersion : updated.version?.number || metadata.versionNumber + 1
                    );
                } catch (err) {
                    propagationFailures.push(`Failed to persist propagated inline comment IDs: ${err.message}`);
                }
            }

            if (propagationFailures.length > 0) {
                inlineCommentResults.push({
                    status: "propagation-warning",
                    reason: propagationFailures.join("; "),
                });
            }
        }

        const changeTypes = ["content:edit"];
        if (inlineCommentEnabled) {
            changeTypes.push("inline-comment");
        }
        if (patchResolved.patchMeta.strategy !== "full-rewrite") {
            changeTypes.push(`patch:${patchOptions.patchScope || "heading"}:${patchOptions.patchMode || "replace"}`);
        }
        if (Array.isArray(metadata.inlineAttachments) && metadata.inlineAttachments.length > 0) {
            changeTypes.push("inline-attachment");
        }

        const auditComment = await leaveChangeAuditComment(client, {
            operation: "page edit content",
            changeTypes,
            pageId: updated.id || String(pageId),
            pageTitle: updated.title || metadata.pageTitle || "Untitled",
        });

        clearBoth(pipeDir, pipeDir);

        output({
            mode: "page-edit-content",
            message: "Page content updated successfully.",
            updated: {
                pageId: updated.id,
                title: updated.title,
                versionNumber: updated.version?.number,
                url: updated._links?.webui || updated._links?.self,
            },
            auditComment,
            inlineComments: inlineCommentEnabled ? inlineCommentResults : undefined,
            patchReport,
            patchMeta: patchResolved.patchMeta,
        });
    } catch (err) {
        clearBoth(pipeDir, pipeDir);

        if (err.message && err.message.includes("version")) {
            throw new CliError("Version conflict: page was modified by another user. Run prepare again.", 10);
        }

        throw new CliError(`Failed to update page: ${err.message}`, 10);
    }
}

module.exports = { pageEditContentCommand };
