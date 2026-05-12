const { CliError } = require("../errors");
const { markdownToAdf } = require("./adfConverter");

function normalizeHeading(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function parseMarkdownHeadingLine(line) {
    const match = String(line || "").match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) return null;
    return {
        level: match[1].length,
        headingText: match[2].trim(),
    };
}

function parseMarkdownSections(markdown) {
    const lines = String(markdown || "").split(/\r?\n/);
    const sections = [];

    let currentStart = null;
    let currentHeading = null;
    let currentLevel = null;

    for (let i = 0; i < lines.length; i += 1) {
        const heading = parseMarkdownHeadingLine(lines[i]);
        if (!heading) continue;

        if (currentStart !== null) {
            sections.push({
                headingText: currentHeading,
                headingLevel: currentLevel,
                normalizedHeading: normalizeHeading(currentHeading),
                markdown: lines.slice(currentStart, i).join("\n"),
                headingIndex: sections.length,
            });
        }

        currentStart = i;
        currentHeading = heading.headingText;
        currentLevel = heading.level;
    }

    if (currentStart !== null) {
        sections.push({
            headingText: currentHeading,
            headingLevel: currentLevel,
            normalizedHeading: normalizeHeading(currentHeading),
            markdown: lines.slice(currentStart).join("\n"),
            headingIndex: sections.length,
        });
    }

    return sections;
}

function sectionBodyMarkdown(sectionMarkdown) {
    const lines = String(sectionMarkdown || "").split(/\r?\n/);
    if (lines.length <= 1) return "";
    return lines.slice(1).join("\n").replace(/^\n+/, "").trimEnd();
}

function normalizeSectionMarkdown(sectionMarkdown) {
    return String(sectionMarkdown || "").replace(/\r\n/g, "\n").trim();
}

function adfHeadingText(node) {
    if (!node || typeof node !== "object") return "";
    if (node.type === "text") return String(node.text || "");
    const children = Array.isArray(node.content) ? node.content : [];
    return children.map((child) => adfHeadingText(child)).join("");
}

function splitAdfSections(adfTree) {
    const content = Array.isArray(adfTree?.content) ? adfTree.content : [];
    const sections = [];

    let currentStart = null;
    let currentHeading = null;
    let currentLevel = null;

    for (let i = 0; i < content.length; i += 1) {
        const node = content[i];
        if (node?.type !== "heading") continue;

        if (currentStart !== null) {
            sections.push({
                startIndex: currentStart,
                endIndex: i - 1,
                headingText: currentHeading,
                headingLevel: currentLevel,
                normalizedHeading: normalizeHeading(currentHeading),
                headingIndex: sections.length,
            });
        }

        currentStart = i;
        currentHeading = adfHeadingText(node).trim();
        currentLevel = Number(node?.attrs?.level || 1);
    }

    if (currentStart !== null) {
        sections.push({
            startIndex: currentStart,
            endIndex: content.length - 1,
            headingText: currentHeading,
            headingLevel: currentLevel,
            normalizedHeading: normalizeHeading(currentHeading),
            headingIndex: sections.length,
        });
    }

    return sections;
}

function findSectionByHeadingOccurrence(sections, headingText, occurrence) {
    const normalized = normalizeHeading(headingText);
    const matches = sections.filter((s) => s.normalizedHeading === normalized);
    if (occurrence >= matches.length) {
        return null;
    }
    return matches[occurrence] || null;
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function buildPatchedAdfFromMarkdown(options) {
    const {
        originalAdf,
        originalMarkdown,
        editedMarkdown,
        targetHeadings,
        patchMode,
    } = options || {};

    if (!Array.isArray(targetHeadings) || targetHeadings.length === 0) {
        throw new CliError("Patch mode requires at least one --target-heading", 3);
    }

    if (!["replace", "append", "prepend"].includes(patchMode)) {
        throw new CliError("Invalid --patch-mode. Use replace, append, or prepend.", 3);
    }

    const patched = deepClone(originalAdf || { type: "doc", version: 1, content: [] });
    const content = Array.isArray(patched.content) ? patched.content : [];

    const originalMdSections = parseMarkdownSections(originalMarkdown || "");
    const editedMdSections = parseMarkdownSections(editedMarkdown || "");
    const originalAdfSections = splitAdfSections(patched);

    if (originalAdfSections.length === 0) {
        throw new CliError("Patch mode requires at least one heading in the original page.", 3);
    }

    const headingUseCount = new Map();
    let offset = 0;
    const patchReport = [];

    for (const requestedHeading of targetHeadings) {
        const normalized = normalizeHeading(requestedHeading);
        const occurrence = headingUseCount.get(normalized) || 0;
        headingUseCount.set(normalized, occurrence + 1);

        const originalMdSection = findSectionByHeadingOccurrence(originalMdSections, requestedHeading, occurrence);
        const originalAdfSection = findSectionByHeadingOccurrence(originalAdfSections, requestedHeading, occurrence);

        if (!originalAdfSection || !originalMdSection) {
            throw new CliError(
                `Unable to resolve target heading '${requestedHeading}' occurrence ${occurrence + 1} in original content.`,
                5
            );
        }

        let editedSection = findSectionByHeadingOccurrence(editedMdSections, requestedHeading, occurrence);
        if (!editedSection) {
            editedSection = editedMdSections[originalMdSection.headingIndex] || null;
        }

        if (!editedSection) {
            throw new CliError(
                `Unable to resolve edited section for target heading '${requestedHeading}'. Keep the section or equivalent heading in the edited markdown.`,
                3
            );
        }

        const adjustedStart = originalAdfSection.startIndex + offset;
        const adjustedEnd = originalAdfSection.endIndex + offset;
        const currentSectionNodes = content.slice(adjustedStart, adjustedEnd + 1);

        let replacementNodes;
        if (patchMode === "replace") {
            replacementNodes = markdownToAdf(editedSection.markdown).content || [];
            if (replacementNodes.length === 0) {
                throw new CliError(`Edited section for heading '${requestedHeading}' is empty after conversion.`, 3);
            }
        } else {
            const bodyMarkdown = sectionBodyMarkdown(editedSection.markdown);
            const bodyNodes = bodyMarkdown ? (markdownToAdf(bodyMarkdown).content || []) : [];
            const sectionHeadingNode = currentSectionNodes[0];
            const sectionBodyNodes = currentSectionNodes.slice(1);

            if (!sectionHeadingNode || sectionHeadingNode.type !== "heading") {
                throw new CliError(`Target heading '${requestedHeading}' does not map to a heading section in ADF.`, 10);
            }

            replacementNodes = patchMode === "prepend"
                ? [sectionHeadingNode, ...bodyNodes, ...sectionBodyNodes]
                : [sectionHeadingNode, ...sectionBodyNodes, ...bodyNodes];
        }

        content.splice(adjustedStart, adjustedEnd - adjustedStart + 1, ...replacementNodes);
        offset += replacementNodes.length - (adjustedEnd - adjustedStart + 1);

        patchReport.push({
            targetHeading: requestedHeading,
            occurrence: occurrence + 1,
            mode: patchMode,
            originalNodes: adjustedEnd - adjustedStart + 1,
            replacementNodes: replacementNodes.length,
            editedHeading: editedSection.headingText,
        });
    }

    patched.content = content;
    return {
        patchedAdf: patched,
        patchReport,
    };
}

function deriveTargetHeadingsFromEditedMarkdown(originalMarkdown, editedMarkdown) {
    const originalSections = parseMarkdownSections(originalMarkdown || "");
    const editedSections = parseMarkdownSections(editedMarkdown || "");
    if (originalSections.length === 0 || editedSections.length === 0) {
        return [];
    }

    const headingUseCount = new Map();
    const targets = [];

    for (const originalSection of originalSections) {
        const normalized = originalSection.normalizedHeading;
        const occurrence = headingUseCount.get(normalized) || 0;
        headingUseCount.set(normalized, occurrence + 1);

        const editedSection = findSectionByHeadingOccurrence(
            editedSections,
            originalSection.headingText,
            occurrence
        );
        if (!editedSection) {
            continue;
        }

        const originalBody = normalizeSectionMarkdown(originalSection.markdown);
        const editedBody = normalizeSectionMarkdown(editedSection.markdown);
        if (originalBody !== editedBody) {
            targets.push(originalSection.headingText);
        }
    }

    return targets;
}

module.exports = {
    buildPatchedAdfFromMarkdown,
    deriveTargetHeadingsFromEditedMarkdown,
};
