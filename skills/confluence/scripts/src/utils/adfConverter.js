/**
 * ADF (Atlassian Document Format) ↔ Markdown Converter
 *
 * Converts between ADF (JSON tree structure) and Markdown (text format).
 * Preserves localId attributes via metadata mapping.
 */

const MarkdownIt = require("markdown-it");

const INLINE_COMMENT_END_TOKEN = "[INLINE_COMMENT_END]";
const INLINE_SPECIAL_RE = /\[INLINE_COMMENT_EXISTING:([^\]]+)\]|\[INLINE_COMMENT_END\]/g;

/**
 * Convert ADF tree to clean Markdown string
 * Walks the ADF tree recursively and outputs Markdown.
 * Tree is assumed to have structure: { type, attrs, content }
 *
 * @param {Object} adfTree - ADF tree with { type, version, content }
 * @returns {string} - Markdown representation
 */
function adfToMarkdown(adfTree) {
    if (!adfTree || !adfTree.content) return "";

    const lines = [];
    adfTree.content.forEach((node) => {
        const markdown = nodeToMarkdown(node);
        if (markdown) lines.push(markdown);
    });

    return lines.join("\n\n");
}

/**
 * Convert a single ADF node to Markdown
 * @param {Object} node - ADF node
 * @returns {string} - Markdown representation
 */
function nodeToMarkdown(node) {
    if (!node) return "";

    const { type, attrs = {}, content } = node;

    switch (type) {
        case "heading": {
            const level = attrs.level || 1;
            const headingContent = contentToMarkdown(content);
            return `${"#".repeat(level)} ${headingContent}`;
        }

        case "paragraph": {
            return contentToMarkdown(content);
        }

        case "bulletList": {
            return listToMarkdown(node, 0, false);
        }

        case "orderedList": {
            return listToMarkdown(node, 0, true);
        }

        case "listItem": {
            // List items are handled by their parent list
            return contentToMarkdown(content);
        }

        case "codeBlock": {
            const language = attrs.language || "";
            const code = contentToMarkdown(content);
            const normalizedCode = code.replace(/\n+$/g, "");
            return `\`\`\`${language}\n${normalizedCode}\n\`\`\``;
        }

        case "mediaSingle": {
            return contentToMarkdown(content);
        }

        case "mediaGroup": {
            return contentToMarkdown(content);
        }

        case "blockquote": {
            const quoted = contentToMarkdown(flattenNestedBlockquoteContent(content));
            return quoted
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n");
        }

        case "hardBreak": {
            return "\n";
        }

        case "rule": {
            return "---";
        }

        case "table": {
            return tableToMarkdown(node);
        }

        // Handle Confluence macros (structured macros)
        case "extension": {
            // Convert macro to special Markdown comment syntax
            const macroType = attrs.extensionType || "unknown";
            const params = attrs.parameters || {};
            const paramStr = Object.entries(params)
                .map(([k, v]) => `${k}="${v}"`)
                .join(" ");
            return `<!-- CONFLUENCE_MACRO type="${macroType}" ${paramStr} -->`;
        }

        case "inlineExtension": {
            // Inline macro (e.g., user mention, status lozenge)
            const macroType = attrs.extensionType || "unknown";
            const params = attrs.parameters || {};
            
            // Special handling for user mentions
            if (macroType === "com.atlassian.confluence.macro.usermention") {
                const accountId = params.accountId || params.userkey || "";
                const displayName = params.displayName || params.name || "@user";
                return `@${displayName}(@${accountId})`;
            }
            
            // Special handling for status lozenges
            if (macroType === "com.atlassian.confluence.macro.status") {
                const text = params.text || "Status";
                const color = params.color || "blue";
                return `[STATUS: ${text} | ${color}]`;
            }
            
            // Generic inline macro
            const paramStr = Object.entries(params)
                .map(([k, v]) => `${k}="${v}"`)
                .join(" ");
            return `<!-- CONFLUENCE_MACRO type="${macroType}" ${paramStr} -->`;
        }

        // Handle media (attachments/images)
        case "media": {
            const type = attrs.type || "file";
            const id = attrs.id || "";
            const width = attrs.width || "";
            const height = attrs.height || "";
            const alignment = attrs.layout || "";
            const alt = attrs.alt || "";
            
            let attrs_str = [];
            if (id) attrs_str.push(`id="${id}"`);
            if (width) attrs_str.push(`width="${width}"`);
            if (height) attrs_str.push(`height="${height}"`);
            if (alignment) attrs_str.push(`align="${alignment}"`);
            
            return `<!-- CONFLUENCE_MEDIA type="${type}" alt="${alt}" ${attrs_str.join(" ")} -->`;
        }

        // Handle task lists (taskList, taskItem)
        case "taskList": {
            return (content || [])
                .map((item) => taskItemToMarkdown(item))
                .join("\n");
        }

        case "taskItem": {
            return taskItemToMarkdown(node);
        }

        // Handle text nodes (leaf nodes)
        case "text": {
            return node.text || "";
        }

        // Handle nested content without specific type
        default:
            return contentToMarkdown(content);
    }
}

/**
 * Convert content array to Markdown
 * Handles text nodes with marks (bold, italic, code)
 *
 * @param {Array} content - Array of nodes
 * @returns {string} - Markdown representation
 */
function contentToMarkdown(content) {
    if (!content || !Array.isArray(content)) return "";

    return content
        .map((item) => {
            if (item.type === "text") {
                let text = item.text || "";
                const marks = item.marks || [];
                let inlineCommentId = null;

                // Apply marks from innermost to outermost
                marks.forEach((mark) => {
                    switch (mark.type) {
                        case "strong":
                            text = `**${text}**`;
                            break;
                        case "em":
                            text = `*${text}*`;
                            break;
                        case "code":
                            text = `` + "`" + `${text}` + "`" + ``;
                            break;
                        case "link":
                            text = `[${text}](${mark.attrs?.href || ""})`;
                            break;
                        case "annotation":
                            if (mark.attrs?.annotationType === "inlineComment" && mark.attrs?.id) {
                                inlineCommentId = String(mark.attrs.id);
                            }
                            break;
                    }
                });

                if (inlineCommentId) {
                    text = `[INLINE_COMMENT_EXISTING:${inlineCommentId}]${text}[INLINE_COMMENT_END]`;
                }

                return text;
            } else {
                // Nested structure
                return nodeToMarkdown(item);
            }
        })
        .join("");
}

function tableToMarkdown(tableNode) {
    const rows = Array.isArray(tableNode?.content) ? tableNode.content : [];
    if (rows.length === 0) return "";

    const parsedRows = rows.map((row) => {
        const cells = Array.isArray(row?.content) ? row.content : [];
        return cells.map((cell) => tableCellToText(cell));
    });

    const maxCols = parsedRows.reduce((max, row) => Math.max(max, row.length), 0);
    if (maxCols === 0) return "";

    const normalizedRows = parsedRows.map((row) => {
        const padded = row.slice();
        while (padded.length < maxCols) padded.push("");
        return padded;
    });

    const header = normalizedRows[0];
    const divider = new Array(maxCols).fill("---");
    const body = normalizedRows.slice(1);

    const lines = [
        `| ${header.join(" | ")} |`,
        `| ${divider.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
    ];

    return lines.join("\n");
}

function tableCellToText(cellNode) {
    const blocks = Array.isArray(cellNode?.content) ? cellNode.content : [];
    const text = blocks
        .map((block) => {
            if (!block) return "";
            if (block.type === "paragraph") return contentToMarkdown(block.content);
            return nodeToMarkdown(block);
        })
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    return escapeTableCell(text);
}

function escapeTableCell(value) {
    return String(value || "").replace(/\|/g, "\\|");
}

function listToMarkdown(listNode, depth, ordered) {
    const items = listNode && Array.isArray(listNode.content) ? listNode.content : [];
    return items
        .map((item, idx) => listItemToMarkdown(item, depth, ordered ? `${idx + 1}. ` : "- "))
        .join("\n");
}

/**
 * Convert list item to Markdown with proper indentation
 * @param {Object} item - List item node
 * @param {string} prefix - List prefix (e.g., "- " or "1. ")
 * @returns {string} - Markdown representation
 */
function listItemToMarkdown(item, depth, prefix) {
    const indent = "  ".repeat(depth);
    const blocks = item && Array.isArray(item.content) ? item.content : [];

    if (blocks.length === 0) {
        return `${indent}${prefix}`;
    }

    const lines = [];
    let wroteFirstLine = false;

    for (const block of blocks) {
        if (!block) continue;

        if (block.type === "bulletList") {
            lines.push(listToMarkdown(block, depth + 1, false));
            continue;
        }

        if (block.type === "orderedList") {
            lines.push(listToMarkdown(block, depth + 1, true));
            continue;
        }

        const blockMarkdown = nodeToMarkdown(block);
        if (!blockMarkdown) continue;

        const blockLines = blockMarkdown.split("\n");
        if (!wroteFirstLine) {
            lines.push(`${indent}${prefix}${blockLines[0]}`);
            for (let i = 1; i < blockLines.length; i++) {
                lines.push(`${indent}  ${blockLines[i]}`);
            }
            wroteFirstLine = true;
        } else {
            lines.push(`${indent}  ${blockLines[0]}`);
            for (let i = 1; i < blockLines.length; i++) {
                lines.push(`${indent}  ${blockLines[i]}`);
            }
        }
    }

    if (!wroteFirstLine) {
        return `${indent}${prefix}`;
    }

    return lines.join("\n");
}

/**
 * Convert task item to Markdown checkbox syntax
 * @param {Object} item - Task item node
 * @returns {string} - Markdown representation
 */
function taskItemToMarkdown(item) {
    if (!item) return "";
    const { attrs = {}, content } = item;
    const state = attrs.state || "todo";
    const checked = state === "done" ? "x" : " ";
    const taskContent = contentToMarkdown(content);
    return `- [${checked}] ${taskContent}`;
}

/**
 * Convert Markdown to ADF tree
 * Parses Markdown and builds ADF structure with restored localIds.
 *
 * @param {string} markdown - Markdown text
 * @param {Object} metadata - Metadata object with localIdMapping and original ADF
 * @returns {Object} - ADF tree
 */
function markdownToAdf(markdown, metadata = {}) {
    const md = new MarkdownIt("commonmark", { html: true });
    md.enable("table");
    const tokens = md.parse(markdown, {});

    const adfContent = tokensToAdfNodes(tokens, metadata);

    return {
        type: "doc",
        version: 1,
        content: adfContent,
    };
}

/**
 * Convert markdown-it tokens to ADF nodes
 * @param {Array} tokens - Array of markdown-it tokens
 * @param {Object} metadata - Metadata for localId mapping
 * @returns {Array} - Array of ADF nodes
 */
function tokensToAdfNodes(tokens, metadata = {}) {
    const localIdMapping = metadata.localIdMapping || [];
    const state = {
        tokens,
        index: 0,
        localIdMapping,
        lineIndex: 0,
    };
    return parseBlockNodes(state, null);
}

function parseBlockNodes(state, stopTokenType) {
    const nodes = [];

    while (state.index < state.tokens.length) {
        const token = state.tokens[state.index];
        if (!token) {
            state.index++;
            continue;
        }

        if (stopTokenType && token.type === stopTokenType) {
            state.index++;
            break;
        }

        if (token.type === "heading_open") {
            nodes.push(parseHeadingNode(state));
            continue;
        }

        if (token.type === "paragraph_open") {
            nodes.push(parseParagraphNode(state));
            continue;
        }

        if (token.type === "bullet_list_open") {
            nodes.push(parseListNode(state, false));
            continue;
        }

        if (token.type === "ordered_list_open") {
            nodes.push(parseListNode(state, true));
            continue;
        }

        if (token.type === "blockquote_open") {
            const quoteNode = parseBlockquoteNode(state);
            if (Array.isArray(quoteNode)) {
                nodes.push(...quoteNode);
            } else if (quoteNode) {
                nodes.push(quoteNode);
            }
            continue;
        }

        if (token.type === "fence" || token.type === "code_block") {
            nodes.push(parseCodeBlockNode(state));
            continue;
        }

        if (token.type === "hr") {
            nodes.push({
                type: "rule",
                attrs: { localId: generateUUID() },
            });
            state.lineIndex++;
            state.index++;
            continue;
        }

        if (token.type === "table_open") {
            nodes.push(parseTableNode(state));
            continue;
        }

        if (token.type === "html_block") {
            const parsed = parseHtmlBlockNode(token.content || "");
            if (parsed) {
                nodes.push(parsed);
                state.lineIndex++;
            }
            state.index++;
            continue;
        }

        state.index++;
    }

    return nodes;
}

function parseHeadingNode(state) {
    const open = state.tokens[state.index];
    const inline = state.tokens[state.index + 1];
    const level = Number.parseInt((open.tag || "h1").replace("h", ""), 10) || 1;
    const line = getTokenStartLine(open, state.lineIndex);
    const localId = findLocalIdByLine(line, state.localIdMapping) || generateUUID();
    const content = inline && inline.type === "inline"
        ? inlineTokensToContent(inline.children || [])
        : [{ type: "text", text: "" }];

    state.index += 1;
    if (state.tokens[state.index] && state.tokens[state.index].type === "inline") state.index += 1;
    if (state.tokens[state.index] && state.tokens[state.index].type === "heading_close") state.index += 1;
    state.lineIndex = Math.max(state.lineIndex + 1, line + 1);

    return {
        type: "heading",
        attrs: { level, localId },
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
    };
}

function parseParagraphNode(state) {
    const open = state.tokens[state.index];
    const inline = state.tokens[state.index + 1];
    const line = getTokenStartLine(open, state.lineIndex);
    const localId = findLocalIdByLine(line, state.localIdMapping) || generateUUID();
    const content = inline && inline.type === "inline"
        ? inlineTokensToContent(inline.children || [])
        : [{ type: "text", text: "" }];

    state.index += 1;
    if (state.tokens[state.index] && state.tokens[state.index].type === "inline") state.index += 1;
    if (state.tokens[state.index] && state.tokens[state.index].type === "paragraph_close") state.index += 1;
    state.lineIndex = Math.max(state.lineIndex + 1, line + 1);

    return {
        type: "paragraph",
        attrs: { localId },
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
    };
}

function parseListNode(state, ordered) {
    const open = state.tokens[state.index];
    const line = getTokenStartLine(open, state.lineIndex);
    const node = {
        type: ordered ? "orderedList" : "bulletList",
        attrs: {
            localId: findLocalIdByLine(line, state.localIdMapping) || generateUUID(),
        },
        content: [],
    };

    state.index += 1;
    while (state.index < state.tokens.length) {
        const token = state.tokens[state.index];
        if (!token) {
            state.index++;
            continue;
        }

        if (token.type === (ordered ? "ordered_list_close" : "bullet_list_close")) {
            state.index++;
            break;
        }

        if (token.type === "list_item_open") {
            node.content.push(parseListItemNode(state));
            continue;
        }

        state.index++;
    }

    return node;
}

function parseListItemNode(state) {
    const open = state.tokens[state.index];
    const line = getTokenStartLine(open, state.lineIndex);
    state.index += 1;
    const content = parseBlockNodes(state, "list_item_close");
    return {
        type: "listItem",
        attrs: {
            localId: findLocalIdByLine(line, state.localIdMapping) || generateUUID(),
        },
        content: content.length > 0 ? content : [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
    };
}

function parseBlockquoteNode(state) {
    state.index += 1;
    const content = parseBlockNodes(state, "blockquote_close");

    return {
        type: "blockquote",
        content: flattenNestedBlockquoteContent(content),
    };
}

function flattenNestedBlockquoteContent(content) {
    if (!Array.isArray(content)) return [];
    const flattened = [];

    for (const node of content) {
        if (!node || typeof node !== "object") continue;
        if (node.type === "blockquote") {
            const nested = flattenNestedBlockquoteContent(node.content || []);
            flattened.push(...nested);
            continue;
        }

        const clone = { ...node };
        if (Array.isArray(node.content)) {
            clone.content = flattenNestedBlockquoteContent(node.content);
        }
        flattened.push(clone);
    }

    return flattened;
}

function parseCodeBlockNode(state) {
    const token = state.tokens[state.index];
    const line = getTokenStartLine(token, state.lineIndex);
    const localId = findLocalIdByLine(line, state.localIdMapping) || generateUUID();
    const languageInfo = String(token.info || "").trim();
    const language = languageInfo.split(/\s+/)[0] || "";
    state.lineIndex = Math.max(state.lineIndex + 1, line + 1);
    state.index += 1;

    return {
        type: "codeBlock",
        attrs: {
            language,
            localId,
        },
        content: [{ type: "text", text: token.content || "" }],
    };
}

function parseTableNode(state) {
    const open = state.tokens[state.index];
    const line = getTokenStartLine(open, state.lineIndex);
    const tableNode = {
        type: "table",
        attrs: {
            isNumberColumnEnabled: false,
            layout: "default",
            localId: findLocalIdByLine(line, state.localIdMapping) || generateUUID(),
        },
        content: [],
    };

    state.index += 1;
    while (state.index < state.tokens.length) {
        const token = state.tokens[state.index];
        if (!token) {
            state.index += 1;
            continue;
        }

        if (token.type === "table_close") {
            state.index += 1;
            break;
        }

        if (token.type === "tr_open") {
            tableNode.content.push(parseTableRow(state));
            continue;
        }

        state.index += 1;
    }

    state.lineIndex = Math.max(state.lineIndex + 1, line + 1);
    return tableNode;
}

function parseTableRow(state) {
    const rowOpen = state.tokens[state.index];
    const rowLine = getTokenStartLine(rowOpen, state.lineIndex);
    const row = {
        type: "tableRow",
        attrs: {
            localId: findLocalIdByLine(rowLine, state.localIdMapping) || generateUUID(),
        },
        content: [],
    };

    state.index += 1;
    while (state.index < state.tokens.length) {
        const token = state.tokens[state.index];
        if (!token) {
            state.index += 1;
            continue;
        }

        if (token.type === "tr_close") {
            state.index += 1;
            break;
        }

        if (token.type === "th_open") {
            row.content.push(parseTableCell(state, true));
            continue;
        }

        if (token.type === "td_open") {
            row.content.push(parseTableCell(state, false));
            continue;
        }

        state.index += 1;
    }

    return row;
}

function parseTableCell(state, isHeader) {
    const open = state.tokens[state.index];
    const closeType = isHeader ? "th_close" : "td_close";
    const cellLine = getTokenStartLine(open, state.lineIndex);
    const cell = {
        type: isHeader ? "tableHeader" : "tableCell",
        attrs: {
            localId: findLocalIdByLine(cellLine, state.localIdMapping) || generateUUID(),
        },
        content: [],
    };

    state.index += 1;
    while (state.index < state.tokens.length) {
        const token = state.tokens[state.index];
        if (!token) {
            state.index += 1;
            continue;
        }

        if (token.type === closeType) {
            state.index += 1;
            break;
        }

        if (token.type === "inline") {
            const inlineContent = inlineTokensToContent(token.children || []);
            cell.content.push({
                type: "paragraph",
                attrs: { localId: generateUUID() },
                content: inlineContent.length > 0 ? inlineContent : [{ type: "text", text: "" }],
            });
            state.index += 1;
            continue;
        }

        if (token.type === "paragraph_open") {
            cell.content.push(parseParagraphNode(state));
            continue;
        }

        if (token.type === "bullet_list_open") {
            cell.content.push(parseListNode(state, false));
            continue;
        }

        if (token.type === "ordered_list_open") {
            cell.content.push(parseListNode(state, true));
            continue;
        }

        state.index += 1;
    }

    if (cell.content.length === 0) {
        cell.content.push({
            type: "paragraph",
            attrs: { localId: generateUUID() },
            content: [{ type: "text", text: "" }],
        });
    }

    return cell;
}

function parseHtmlBlockNode(rawContent) {
    const content = String(rawContent || "").trim();
    if (!content) return null;

    const macroMatch = content.match(/^<!--\s*CONFLUENCE_MACRO\s+type="([^"]+)"\s*(.*?)\s*-->$/s);
    if (macroMatch) {
        return {
            type: "extension",
            attrs: {
                extensionType: macroMatch[1],
                parameters: parseHtmlAttributes(macroMatch[2]),
                localId: generateUUID(),
            },
        };
    }

    const mediaMatch = content.match(/^<!--\s*CONFLUENCE_MEDIA\s+type="([^"]+)"\s*alt="([^"]*)"\s*(.*?)\s*-->$/s);
    if (mediaMatch) {
        const attrs = parseHtmlAttributes(mediaMatch[3]);
        const mediaAttrs = {
            type: mediaMatch[1] || "file",
            id: attrs.id || "",
            alt: mediaMatch[2] || "",
            collection: attrs.collection || "contentId",
        };
        if (attrs.width) mediaAttrs.width = Number(attrs.width) || attrs.width;
        if (attrs.height) mediaAttrs.height = Number(attrs.height) || attrs.height;

        return {
            type: "mediaSingle",
            attrs: {
                layout: attrs.align || "center",
            },
            content: [
                {
                    type: "media",
                    attrs: mediaAttrs,
                },
            ],
        };
    }

    return {
        type: "paragraph",
        attrs: { localId: generateUUID() },
        content: [{ type: "text", text: content }],
    };
}

function parseHtmlAttributes(attrsText) {
    const attrs = {};
    const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g;
    let match;
    while ((match = attrRe.exec(String(attrsText || ""))) !== null) {
        attrs[match[1]] = match[2];
    }
    return attrs;
}

function getTokenStartLine(token, fallback) {
    if (token && Array.isArray(token.map) && Number.isInteger(token.map[0])) {
        return token.map[0];
    }
    return fallback;
}

/**
 * Convert inline markdown-it tokens to ADF content array
 * Handles text nodes with marks (bold, italic, code, links)
 *
 * @param {Array} children - Array of inline tokens
 * @returns {Array} - ADF content nodes
 */
function inlineTokensToContent(children) {
    if (!children || children.length === 0) return [];

    const content = [];
    const markStack = [];
    let activeInlineCommentId = null;

    const pushTextNode = (rawText, extraMarks = []) => {
        if (!rawText) return;
        const marks = [...markStack, ...extraMarks];
        if (activeInlineCommentId) {
            marks.push({
                type: "annotation",
                attrs: {
                    annotationType: "inlineComment",
                    id: activeInlineCommentId,
                },
            });
        }
        content.push({
            type: "text",
            text: rawText,
            marks: marks.length > 0 ? marks : undefined,
        });
    };

    const processSpecialText = (raw) => {
        let cursor = 0;
        const text = String(raw || "");
        let match;

        while ((match = INLINE_SPECIAL_RE.exec(text)) !== null) {
            const start = match.index;
            if (start > cursor) {
                pushTextNode(text.slice(cursor, start));
            }

            if (match[1] !== undefined) {
                activeInlineCommentId = String(match[1] || "").trim() || null;
            } else if (match[0] === INLINE_COMMENT_END_TOKEN) {
                activeInlineCommentId = null;
            } else {
                pushTextNode(match[0]);
            }

            cursor = INLINE_SPECIAL_RE.lastIndex;
        }

        if (cursor < text.length) {
            pushTextNode(text.slice(cursor));
        }

        INLINE_SPECIAL_RE.lastIndex = 0;
    };

    const removeTopMark = (type) => {
        for (let idx = markStack.length - 1; idx >= 0; idx--) {
            if (markStack[idx].type === type) {
                markStack.splice(idx, 1);
                return;
            }
        }
    };

    let i = 0;
    while (i < children.length) {
        const token = children[i];

        if (token.type === "text") {
            processSpecialText(token.content);
        } else if (token.type === "strong_open") {
            markStack.push({ type: "strong" });
        } else if (token.type === "strong_close") {
            removeTopMark("strong");
        } else if (token.type === "em_open") {
            markStack.push({ type: "em" });
        } else if (token.type === "em_close") {
            removeTopMark("em");
        } else if (token.type === "code_inline") {
            pushTextNode(token.content, [{ type: "code" }]);
        } else if (token.type === "link_open") {
            const href = token.attrGet("href") || "";
            markStack.push({ type: "link", attrs: { href } });
        } else if (token.type === "link_close") {
            removeTopMark("link");
        } else if (token.type === "softbreak" || token.type === "hardbreak") {
            if (token.type === "hardbreak") {
                content.push({
                    type: "hardBreak",
                });
            } else {
                pushTextNode("\n");
            }
        } else if (token.type === "html_inline") {
            processSpecialText(token.content);
        }
        i++;
    }

    return content.length > 0 ? content : [];
}

/**
 * Extract localId from mapping by line number
 * @param {number} lineIndex - Line number in Markdown
 * @param {Array} localIdMapping - Array of mappings
 * @returns {string|null} - LocalId or null
 */
function findLocalIdByLine(lineIndex, localIdMapping) {
    if (!localIdMapping || localIdMapping.length === 0) return null;

    const mapping = localIdMapping.find((m) => m.markdownLine === lineIndex);
    return mapping ? mapping.localId : null;
}

/**
 * Extract metadata from ADF tree
 * Walks the tree and extracts localId mappings, structure info
 *
 * @param {Object} adfTree - ADF tree
 * @returns {Object} - Metadata with localIdMapping, structure, etc.
 */
function extractAdfMetadata(adfTree) {
    const localIdMapping = [];
    let lineIndex = 0;

    const walkNode = (node, path = []) => {
        if (!node) return;

        const { type, attrs = {}, content } = node;
        const localId = attrs.localId;

        if (localId) {
            localIdMapping.push({
                localId,
                type,
                level: attrs.level, // for headings
                markdownLine: lineIndex,
                adfPath: path,
            });

            if (type !== "codeBlock" && type !== "hardBreak") {
                lineIndex++;
            }
        }

        if (Array.isArray(content)) {
            content.forEach((child, i) => {
                walkNode(child, [...path, i]);
            });
        }
    };

    if (adfTree && adfTree.content) {
        adfTree.content.forEach((node, i) => {
            walkNode(node, [i]);
        });
    }

    return {
        localIdMapping,
        structure: {
            hasHeadings: localIdMapping.some((m) => m.type === "heading"),
            hasLists: localIdMapping.some((m) => m.type === "bulletList"),
            codeBlocks: localIdMapping.filter((m) => m.type === "codeBlock").length,
        },
    };
}

/**
 * Generate a random UUID-like string for local IDs
 * @returns {string} - Random ID
 */
function generateUUID() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

module.exports = {
    adfToMarkdown,
    markdownToAdf,
    extractAdfMetadata,
    nodeToMarkdown,
    contentToMarkdown,
};
