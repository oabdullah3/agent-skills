/**
 * Page Create Command
 *
 * Three-turn workflow:
 * 1. Turn 1 (prepare): Code writes pipe file (empty or template-preloaded), agent edits content
 * 2. Turn 2 (show-changes): Agent signals pipe changed, code shows preview
 * 3. Turn 3 (finalize): Human approves, code creates page and clears pipe
 */

const { CliError } = require("../errors");
const { rejectUnknownFlags } = require("../utils");
const { adfToMarkdown, markdownToAdf } = require("../utils/adfConverter");
const { leaveChangeAuditComment } = require("../utils/changeAuditComment");
const { resolvePageCreatePresetFromArgs } = require("../locationPresets");
const { getPipePath, writePipe, extractMetadata, storeMetadata, clearBoth, validatePipeWritten, getPipeBaseDir } = require("../utils/pipeMetadata");
const { parseAtlasDocBody } = require("./pageEditCommon");

async function pageCreateCommand(client, args, output) {
    rejectUnknownFlags(
        args,
        [
            "space-key", "space-name", "title", "page-location",
            "incident-report", "meeting-notes", "gap-analysis", "risk-register",
            "impact-analysis", "change-request-form", "release-notes",
            "operation-mode", "pipe-changed", "human-approval-obtained", "pipe-dir",
        ],
        "page create"
    );

    const spaceKey = args["space-key"];
    const spaceName = args["space-name"];
    const title = args.title;
    const pageLocation = args["page-location"];
    const locationPreset = resolvePageCreatePresetFromArgs(args);
    const operationMode = args["operation-mode"] || "prepare";
    const pipeChanged = Boolean(args["pipe-changed"]);
    const approvalObtained = Boolean(args["human-approval-obtained"]);
    const pipeDir = args["pipe-dir"];

    // Auto-detect operation mode if pipe-changed flag is present
    let actualMode = operationMode;
    if (pipeChanged && operationMode === "prepare") {
        actualMode = "show-changes";
    }

    if (!title) {
        throw new CliError("Missing required: --title", 3);
    }

    if (!locationPreset && !spaceKey && !spaceName) {
        throw new CliError("Missing required: --space-key or --space-name (or use a preset template flag)", 3);
    }

    if (actualMode === "prepare") {
        return handlePrepare(client, { spaceKey, spaceName, title, pageLocation, locationPreset, pipeDir }, output);
    } else if (actualMode === "show-changes") {
        return handleShowChanges(client, { spaceKey, spaceName, title, pageLocation, locationPreset, pipeChanged, pipeDir }, output);
    } else if (actualMode === "finalize") {
        return handleFinalize(client, { spaceKey, spaceName, title, pageLocation, locationPreset, approvalObtained, pipeDir }, output);
    } else {
        throw new CliError(`Unknown operation-mode: ${actualMode}. Use 'prepare', 'show-changes', or 'finalize'.`, 3);
    }
}

async function resolveSpace(client, spaceKey, spaceName) {
    let space;
    if (spaceKey) {
        const spaceResult = await client.searchSpaces(spaceKey, 1, 0);
        if (spaceResult.results.length === 0) {
            throw new CliError(`Space with key '${spaceKey}' not found`, 5);
        }
        space = spaceResult.results[0];
    } else {
        const spaceResult = await client.searchSpaces(spaceName, 100, 0);
        if (spaceResult.results.length === 0) {
            throw new CliError(`Space with name '${spaceName}' not found`, 5);
        }
        space = spaceResult.results.find(s => s.name === spaceName);
        if (!space) {
            if (spaceResult.results.length === 1) {
                space = spaceResult.results[0];
            } else {
                throw new CliError(
                    `Multiple spaces match '${spaceName}'. Please be more specific or use --space-key for exact match. Found: ${spaceResult.results.map(s => `${s.name} (${s.key})`).join(", ")}`,
                    5
                );
            }
        }
    }

    return space;
}

function parsePageLocation(pageLocation) {
    if (!pageLocation || pageLocation === "." || pageLocation === "./") {
        return [];
    }

    const normalized = String(pageLocation).trim().replace(/\\/g, "/");
    if (!normalized.startsWith(".")) {
        throw new CliError("Invalid --page-location. Must start with '.' (for example: ./Parent/Child/)", 3);
    }

    const withoutRoot = normalized.replace(/^\.\/?/, "");
    return withoutRoot.split("/").map(s => s.trim()).filter(Boolean);
}

async function resolveParentFromLocation(client, spaceKey, pageLocation) {
    const segments = parsePageLocation(pageLocation);
    if (segments.length === 0) {
        return { parentPageId: null, resolvedPath: "./" };
    }

    const space = await client.getSpace(spaceKey, "homepage");
    const homepageId = space?.homepage?.id;
    if (!homepageId) {
        throw new CliError("Unable to resolve space homepage for --page-location traversal.", 10);
    }

    let currentParentId = String(homepageId);
    const resolved = [];

    for (const segment of segments) {
        const escapedSegment = segment.replace(/"/g, '\\"');
        const cql = `parent = ${currentParentId} AND space = "${spaceKey}" AND title = "${escapedSegment}"`;
        const searchResult = await client.searchPagesCql(cql, 25, 0);
        const matches = (searchResult.results || []).map(r => ({
            id: r?.content?.id || r?.id,
            title: r?.content?.title || r?.title,
        })).filter(r => r.id && r.title);

        if (matches.length === 0) {
            throw new CliError(
                `Path segment '${segment}' not found under parent page '${resolved[resolved.length - 1] || "<space-root>"}'.`,
                5
            );
        }

        if (matches.length > 1) {
            throw new CliError(
                `Path segment '${segment}' is ambiguous under '${resolved[resolved.length - 1] || "<space-root>"}'.`,
                5
            );
        }

        currentParentId = String(matches[0].id);
        resolved.push(matches[0].title);
    }

    return {
        parentPageId: currentParentId,
        resolvedPath: `./${resolved.join("/")}/`,
    };
}

async function resolveParentFromSegments(client, spaceKey, pathSegments = []) {
    const segments = Array.isArray(pathSegments)
        ? pathSegments.map((s) => String(s).trim()).filter(Boolean)
        : [];

    if (segments.length === 0) {
        return { parentPageId: null, resolvedPath: "./" };
    }

    const space = await client.getSpace(spaceKey, "homepage");
    const homepageId = space?.homepage?.id;
    if (!homepageId) {
        throw new CliError("Unable to resolve space homepage for preset path traversal.", 10);
    }

    let currentParentId = String(homepageId);
    const resolved = [];

    for (const segment of segments) {
        const escapedSegment = segment.replace(/"/g, '\\"');
        const cql = `parent = ${currentParentId} AND space = "${spaceKey}" AND title = "${escapedSegment}"`;
        const searchResult = await client.searchPagesCql(cql, 25, 0);
        const matches = (searchResult.results || []).map((r) => ({
            id: r?.content?.id || r?.id,
            title: r?.content?.title || r?.title,
        })).filter((r) => r.id && r.title);

        if (matches.length === 0) {
            throw new CliError(
                `Preset path segment '${segment}' not found under parent '${resolved[resolved.length - 1] || "<space-root>"}'.`,
                5
            );
        }

        if (matches.length > 1) {
            throw new CliError(
                `Preset path segment '${segment}' is ambiguous under '${resolved[resolved.length - 1] || "<space-root>"}'.`,
                5
            );
        }

        currentParentId = String(matches[0].id);
        resolved.push(matches[0].title);
    }

    return {
        parentPageId: currentParentId,
        resolvedPath: `./${resolved.join("/")}/`,
    };
}

async function resolveParent(client, spaceKey, pageLocation, locationPreset) {
    if (locationPreset && Array.isArray(locationPreset.destination?.pathSegments)) {
        return resolveParentFromSegments(client, spaceKey, locationPreset.destination.pathSegments);
    }
    return resolveParentFromLocation(client, spaceKey, pageLocation);
}

async function resolvePersonalSpaceKey(client) {
    const me = await client.getMyself();
    const key = String(me?.personalSpace?.key || "").trim();
    if (!key) {
        throw new CliError("Unable to resolve personal space key for preset destination fallback.", 10);
    }
    return key;
}

async function resolveDestinationContext(client, { spaceKey, spaceName, pageLocation, locationPreset }) {
    if (!locationPreset) {
        if (pageLocation && !spaceKey && !spaceName) {
            throw new CliError("--page-location requires --space-key or --space-name", 3);
        }
        const space = await resolveSpace(client, spaceKey, spaceName);
        const locationResolution = await resolveParentFromLocation(client, space.key, pageLocation);
        return {
            space,
            locationResolution,
            destinationSource: "user-input",
        };
    }

    const overrideSpaceProvided = Boolean(spaceKey || spaceName);
    if (pageLocation && !overrideSpaceProvided) {
        throw new CliError(`--${locationPreset.flagName}: --page-location override requires --space-key or --space-name`, 3);
    }

    if (overrideSpaceProvided) {
        const space = await resolveSpace(client, spaceKey, spaceName);
        const locationResolution = await resolveParentFromLocation(client, space.key, pageLocation);
        return {
            space,
            locationResolution,
            destinationSource: "user-override",
        };
    }

    if (locationPreset.destination?.spaceKey) {
        const space = await resolveSpace(client, locationPreset.destination.spaceKey, null);
        const locationResolution = await resolveParentFromSegments(
            client,
            space.key,
            locationPreset.destination.pathSegments || []
        );
        return {
            space,
            locationResolution,
            destinationSource: "preset-destination",
        };
    }

    const personalSpaceKey = await resolvePersonalSpaceKey(client);
    const space = await resolveSpace(client, personalSpaceKey, null);
    const locationResolution = await resolveParentFromLocation(client, space.key, "./");
    return {
        space,
        locationResolution,
        destinationSource: "personal-space-fallback",
    };
}

async function resolveTemplatePage(client, templateSource) {
    const templateSpaceKey = String(templateSource?.spaceKey || "").trim();
    const templatePathSegments = Array.isArray(templateSource?.pathSegments)
        ? templateSource.pathSegments.map((s) => String(s).trim()).filter(Boolean)
        : [];
    const templateTitle = String(templateSource?.title || "").trim();

    if (!templateSpaceKey || templatePathSegments.length === 0 || !templateTitle) {
        throw new CliError("Template preset has invalid source configuration.", 10);
    }

    const templateFolderResolution = await resolveParentFromSegments(client, templateSpaceKey, templatePathSegments);
    if (!templateFolderResolution.parentPageId) {
        throw new CliError("Template folder resolution did not return a parent page id.", 10);
    }

    const escapedTitle = templateTitle.replace(/"/g, '\\"');
    const cql = `parent = ${templateFolderResolution.parentPageId} AND space = "${templateSpaceKey}" AND title = "${escapedTitle}"`;
    const searchResult = await client.searchPagesCql(cql, 25, 0);
    const matches = (searchResult.results || []).map((r) => ({
        id: r?.content?.id || r?.id,
        title: r?.content?.title || r?.title,
    })).filter((r) => r.id && r.title);

    if (matches.length === 0) {
        throw new CliError(`Template page '${templateTitle}' not found in configured template location.`, 5);
    }

    if (matches.length > 1) {
        throw new CliError(`Template page '${templateTitle}' is ambiguous in configured template location.`, 5);
    }

    return {
        pageId: String(matches[0].id),
        title: matches[0].title,
        spaceKey: templateSpaceKey,
        folderPath: `./${templatePathSegments.join("/")}/`,
    };
}

async function resolveTemplateMarkdown(client, locationPreset) {
    if (!locationPreset?.templateSource) {
        return {
            markdown: "",
            templateInfo: null,
        };
    }

    const templatePage = await resolveTemplatePage(client, locationPreset.templateSource);
    const templateContent = await client.getPageContent(templatePage.pageId, "atlas_doc_format");
    const templateAdf = parseAtlasDocBody(templateContent);
    if (!templateAdf) {
        throw new CliError(`Template page '${templatePage.title}' content is not available in ADF format.`, 10);
    }

    return {
        markdown: adfToMarkdown(templateAdf),
        templateInfo: {
            presetKey: locationPreset.presetKey,
            flag: `--${locationPreset.flagName}`,
            sourceSpaceKey: templatePage.spaceKey,
            sourceFolderPath: templatePage.folderPath,
            templatePageId: templatePage.pageId,
            templatePageTitle: templatePage.title,
        },
    };
}

/**
 * Stage 1: Prepare
 * Create empty pipe file for agent to populate
 */
async function handlePrepare(client, params, output) {
    const {
        spaceKey,
        spaceName,
        title,
        pageLocation,
        locationPreset,
        pipeDir,
    } = params;

    const destination = await resolveDestinationContext(client, {
        spaceKey,
        spaceName,
        pageLocation,
        locationPreset,
    });

    const templatePreload = await resolveTemplateMarkdown(client, locationPreset);

    // Create preloaded pipe file for agent to edit
    writePipe(templatePreload.markdown || "", pipeDir);

    output({
        mode: "page-create-awaiting-approval",
        message: templatePreload.templateInfo
            ? "Ready to create a new page. Pipe file is preloaded from template content."
            : "Ready to create a new page. Please add content to the pipe file.",
        instruction:
            "1. Edit the pipe file at: " + getPipePath(pipeDir) +
            (templatePreload.templateInfo
                ? "\n2. The pipe was preloaded with template content. Follow and adapt it to user context.\n"
                : "\n2. Add your page content in Markdown format\n") +
            "3. Run the command again with --operation-mode show-changes --pipe-changed\n" +
            "4. In user-facing chat, explain this step in natural language (avoid dumping CLI flags unless asked)",
        pageDetails: {
            title,
            spaceKey: destination.space.key,
            spaceName: destination.space.name,
            spaceId: destination.space.id,
            pageLocation: destination.locationResolution.resolvedPath,
            parentPageId: destination.locationResolution.parentPageId,
            destinationSource: destination.destinationSource,
            locationPreset: locationPreset ? {
                presetKey: locationPreset.presetKey,
                flag: `--${locationPreset.flagName}`,
                description: locationPreset.description,
            } : null,
            templateSource: templatePreload.templateInfo,
        },
    });
}

/**
 * Stage 2: Show Changes
 * Agent has populated pipe file, show preview
 */
async function handleShowChanges(client, params, output) {
    const {
        spaceKey,
        spaceName,
        title,
        pageLocation,
        locationPreset,
        pipeChanged,
        pipeDir,
    } = params;

    if (!pipeChanged) {
        throw new CliError("Missing flag: --pipe-changed. You must edit the pipe file before proceeding.", 3);
    }

    // Read pipe file
    const pipeValidation = validatePipeWritten(pipeDir);
    if (!pipeValidation.written) {
        throw new CliError(pipeValidation.message, 3);
    }

    const markdown = pipeValidation.content;

    // Store metadata for finalize stage
    const metadata = {
        title,
        spaceKey: spaceKey || spaceName || null,
        pageLocation: pageLocation || "./",
        locationPreset: locationPreset ? locationPreset.presetKey : null,
        createdAt: new Date().toISOString(),
    };
    storeMetadata(metadata, pipeDir);

    const destination = await resolveDestinationContext(client, {
        spaceKey,
        spaceName,
        pageLocation,
        locationPreset,
    });

    output({
        mode: "page-create-preview-ready",
        message: "Content ready for creation. Review and confirm.",
        pageDetails: {
            title,
            spaceKey: destination.space.key,
            spaceName: destination.space.name,
            pageLocation: destination.locationResolution.resolvedPath,
            parentPageId: destination.locationResolution.parentPageId,
            destinationSource: destination.destinationSource,
            locationPreset: locationPreset ? {
                presetKey: locationPreset.presetKey,
                flag: `--${locationPreset.flagName}`,
                description: locationPreset.description,
            } : null,
        },
        preview: {
            contentPreview: markdown.substring(0, 500) + (markdown.length > 500 ? "..." : ""),
            lineCount: markdown.split("\n").length,
            characterCount: markdown.length,
            fullContent: markdown,
        },
        instruction:
            "Before requesting approval, share the FULL proposed page content and exact destination (space name/key + page location path + parent page id if present) in natural language.\n" +
            "Then ask for explicit approval.\n" +
            "If approved, run again with --operation-mode finalize --human-approval-obtained.\n" +
            "If changes are needed, edit the pipe file and rerun show-changes.",
    });
}

/**
 * Stage 3: Finalize
 * Human approved, create the page
 */
async function handleFinalize(client, params, output) {
    const {
        spaceKey,
        spaceName,
        title,
        pageLocation,
        locationPreset,
        approvalObtained,
        pipeDir,
    } = params;

    if (!approvalObtained) {
        throw new CliError("Missing flag: --human-approval-obtained. Explicit approval required to create page.", 3);
    }

    // Read the final markdown from pipe
    const pipeValidation = validatePipeWritten(pipeDir);
    if (!pipeValidation.written) {
        throw new CliError("Pipe file is empty or missing.", 3);
    }

    // Convert final markdown to ADF
    const finalMarkdown = pipeValidation.content;
    const adfTree = markdownToAdf(finalMarkdown);

    const destination = await resolveDestinationContext(client, {
        spaceKey,
        spaceName,
        pageLocation,
        locationPreset,
    });

    try {
        const created = await client.createPage(
            destination.space.key,
            title,
            "atlas_doc_format",
            adfTree,
            destination.locationResolution.parentPageId
        );

        const auditComment = await leaveChangeAuditComment(client, {
            operation: "page create",
            changeTypes: ["content:create"],
            pageId: created.id,
            pageTitle: created.title || title,
        });

        // Clear pipe and metadata files
        clearBoth(pipeDir, pipeDir);

        output({
            mode: "page-create",
            message: "Page created successfully.",
            created: {
                pageId: created.id,
                title: created.title,
                spaceKey: destination.space.key,
                spaceName: destination.space.name,
                pageLocation: destination.locationResolution.resolvedPath,
                parentPageId: destination.locationResolution.parentPageId,
                destinationSource: destination.destinationSource,
                locationPreset: locationPreset ? {
                    presetKey: locationPreset.presetKey,
                    flag: `--${locationPreset.flagName}`,
                    description: locationPreset.description,
                } : null,
                url: created._links?.webui || created._links?.self,
            },
            auditComment,
        });
    } catch (err) {
        // Clear files even on error
        clearBoth(pipeDir, pipeDir);

        throw new CliError(`Failed to create page: ${err.message}`, 10);
    }
}

module.exports = { pageCreateCommand };
