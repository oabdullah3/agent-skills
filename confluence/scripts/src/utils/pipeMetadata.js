/**
 * Pipe Metadata Manager
 *
 * Manages the metadata file that stores localId mappings and original content
 * during ADF editing. Metadata persists across the prepare → show-changes → finalize workflow.
 *
 * Default location: ~/.openclaw/workspace/skills/confluence/
 * Custom location: via --pipe-dir flag or CONFLUENCE_PIPE_DIR env var
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Default pipe base directory - matches OpenClaw workspace structure
const DEFAULT_PIPE_BASE_DIR = path.join(os.homedir(), ".openclaw", "workspace", "skills", "confluence");
const DEFAULT_METADATA_FILENAME = ".confluence-pipe-metadata.json";
const DEFAULT_PIPE_FILENAME = ".confluence-pipe";

function resolvePipeBaseDir(customPath = null) {
    if (!customPath) {
        return getPipeBaseDir();
    }

    const resolved = path.resolve(customPath);
    const base = path.basename(resolved);

    if (base === DEFAULT_PIPE_FILENAME || base === DEFAULT_METADATA_FILENAME) {
        return path.dirname(resolved);
    }

    return resolved;
}

function resolvePipeFilePath(customPath = null) {
    if (!customPath) {
        return getPipePath();
    }

    const resolved = path.resolve(customPath);
    const base = path.basename(resolved);

    if (base === DEFAULT_PIPE_FILENAME) {
        return resolved;
    }

    if (base === DEFAULT_METADATA_FILENAME) {
        return path.join(path.dirname(resolved), DEFAULT_PIPE_FILENAME);
    }

    return path.join(resolved, DEFAULT_PIPE_FILENAME);
}

function resolveMetadataFilePath(customPath = null) {
    if (!customPath) {
        return getMetadataPath();
    }

    const resolved = path.resolve(customPath);
    const base = path.basename(resolved);

    if (base === DEFAULT_METADATA_FILENAME) {
        return resolved;
    }

    if (base === DEFAULT_PIPE_FILENAME) {
        return path.join(path.dirname(resolved), DEFAULT_METADATA_FILENAME);
    }

    return path.join(resolved, DEFAULT_METADATA_FILENAME);
}

/**
 * Get the canonical pipe base directory
 * Priority:
 * 1. CONFLUENCE_PIPE_DIR env var (for testing/custom location)
 * 2. Default: ~/.openclaw/workspace/skills/confluence
 *
 * @returns {string} - Absolute path to pipe directory
 */
function getPipeBaseDir() {
    const envDir = process.env.CONFLUENCE_PIPE_DIR;
    if (envDir) {
        return path.resolve(envDir);
    }
    return path.resolve(DEFAULT_PIPE_BASE_DIR);
}

/**
 * Get the canonical metadata file path
 * @param {string} customDir - Optional custom directory (from --pipe-dir flag)
 * @returns {string} - Absolute path to metadata file
 */
function getMetadataPath(customDir = null) {
    const baseDir = resolvePipeBaseDir(customDir);
    return path.join(baseDir, DEFAULT_METADATA_FILENAME);
}

/**
 * Get the canonical pipe file path
 * @param {string} customDir - Optional custom directory (from --pipe-dir flag)
 * @returns {string} - Absolute path to pipe file
 */
function getPipePath(customDir = null) {
    const baseDir = resolvePipeBaseDir(customDir);
    return path.join(baseDir, DEFAULT_PIPE_FILENAME);
}

/**
 * Extract metadata from ADF tree
 * Builds mappings of localIds to their positions and properties
 *
 * @param {Object} adfTree - The ADF tree structure
 * @param {string} originalMarkdown - Original Markdown representation (for line mapping)
 * @returns {Object} - Metadata object with localIdMapping, extensions, etc.
 */
function extractMetadata(adfTree, originalMarkdown = "") {
    const localIdMapping = [];
    let lineIndex = 0;

    const walkNode = (node, path = []) => {
        if (!node) return;

        const { type, attrs = {}, content } = node;
        const localId = attrs.localId;

        if (localId) {
            const entry = {
                localId,
                type,
                adfPath: path,
                markdownLine: lineIndex,
            };

            // Store additional attributes based on node type
            if (type === "heading" && attrs.level) {
                entry.level = attrs.level;
            }
            if (type === "codeBlock" && attrs.language) {
                entry.language = attrs.language;
            }
            // Store macro/extension info
            if (type === "extension" || type === "inlineExtension") {
                entry.extensionType = attrs.extensionType;
                entry.parameters = attrs.parameters;
            }

            localIdMapping.push(entry);

            // Only increment line for block-level elements, not inline breaks
            if (!["hardBreak", "softBreak"].includes(type)) {
                lineIndex++;
            }
        }

        // Recursively walk children
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
        originalAdf: adfTree,
        originalMarkdown,
        localIdMapping,
        extensions: extractExtensions(adfTree),
        fetchedAt: new Date().toISOString(),
    };
}

/**
 * Extract Confluence extensions/macros from ADF tree
 * These are special nodes that need special handling
 *
 * @param {Object} adfTree - ADF tree
 * @returns {Array} - Array of extension/macro information
 */
function extractExtensions(adfTree) {
    const extensions = [];

    const walkNode = (node) => {
        if (!node) return;

        if (node.type === "extension" || node.type === "inlineExtension") {
            extensions.push({
                type: node.type,
                localId: node.attrs?.localId,
                extensionType: node.attrs?.extensionType,
                parameters: node.attrs?.parameters,
            });
        }

        if (Array.isArray(node.content)) {
            node.content.forEach(walkNode);
        }
    };

    if (adfTree && adfTree.content) {
        adfTree.content.forEach(walkNode);
    }

    return extensions;
}

/**
 * Store metadata to file
 * Creates the directory if it doesn't exist
 *
 * @param {Object} metadata - Metadata object to store
 * @param {string} filePath - Optional custom file path
 * @throws {Error} - If file write fails
 */
function storeMetadata(metadata, filePath = null) {
    const targetPath = resolveMetadataFilePath(filePath);
    const dir = path.dirname(targetPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    try {
        fs.writeFileSync(targetPath, JSON.stringify(metadata, null, 2), "utf8");
    } catch (err) {
        throw new Error(`Failed to write metadata to ${targetPath}: ${err.message}`);
    }
}

/**
 * Load metadata from file
 * @param {string} filePath - Optional custom file path
 * @returns {Object|null} - Metadata object or null if file doesn't exist
 * @throws {Error} - If file read or JSON parse fails
 */
function loadMetadata(filePath = null) {
    const targetPath = resolveMetadataFilePath(filePath);

    if (!fs.existsSync(targetPath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(targetPath, "utf8");
        return JSON.parse(content);
    } catch (err) {
        throw new Error(`Failed to load metadata from ${targetPath}: ${err.message}`);
    }
}

/**
 * Check if metadata file exists and is younger than specified age
 * @param {number} maxAgeSeconds - Maximum age in seconds before considered stale
 * @returns {Object} - { exists, isStale, age }
 */
function checkMetadataAge(maxAgeSeconds = 300) {
    const targetPath = getMetadataPath();

    if (!fs.existsSync(targetPath)) {
        return {
            exists: false,
            isStale: false,
            age: null,
        };
    }

    const stats = fs.statSync(targetPath);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
    const isStale = ageSeconds > maxAgeSeconds;

    return {
        exists: true,
        isStale,
        age: ageSeconds,
    };
}

/**
 * Clear (delete) metadata file
 * @param {string} filePath - Optional custom file path
 * @throws {Error} - If deletion fails
 */
function clearMetadata(filePath = null) {
    const targetPath = resolveMetadataFilePath(filePath);

    if (!fs.existsSync(targetPath)) {
        return; // Already gone
    }

    try {
        fs.unlinkSync(targetPath);
    } catch (err) {
        throw new Error(`Failed to clear metadata at ${targetPath}: ${err.message}`);
    }
}

/**
 * Clear (delete) pipe file
 * @param {string} filePath - Optional custom file path
 */
function clearPipe(filePath = null) {
    const targetPath = resolvePipeFilePath(filePath);

    if (!fs.existsSync(targetPath)) {
        return; // Already gone
    }

    try {
        fs.unlinkSync(targetPath);
    } catch (err) {
        throw new Error(`Failed to clear pipe at ${targetPath}: ${err.message}`);
    }
}

/**
 * Clear both pipe and metadata files
 * Ensures clean state after operation completes
 * @param {string} pipeFilePath - Optional custom pipe file path
 * @param {string} metadataFilePath - Optional custom metadata file path
 */
function clearBoth(pipeFilePath = null, metadataFilePath = null) {
    clearPipe(pipeFilePath);
    clearMetadata(metadataFilePath || pipeFilePath);
}

/**
 * Write content to pipe file, ensuring directory exists
 * @param {string} content - Markdown content to write
 * @param {string} filePath - Optional custom file path
 * @throws {Error} - If write fails
 */
function writePipe(content, filePath = null) {
    const targetPath = resolvePipeFilePath(filePath);
    const dir = path.dirname(targetPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    try {
        fs.writeFileSync(targetPath, content, "utf8");
    } catch (err) {
        throw new Error(`Failed to write pipe file at ${targetPath}: ${err.message}`);
    }
}

/**
 * Read content from pipe file
 * @param {string} filePath - Optional custom file path
 * @returns {string|null} - File content or null if doesn't exist
 * @throws {Error} - If read fails
 */
function readPipe(filePath = null) {
    const targetPath = resolvePipeFilePath(filePath);

    if (!fs.existsSync(targetPath)) {
        return null;
    }

    try {
        return fs.readFileSync(targetPath, "utf8");
    } catch (err) {
        throw new Error(`Failed to read pipe file at ${targetPath}: ${err.message}`);
    }
}

/**
 * Check if pipe file exists and is not empty
 * @param {string} filePath - Optional custom file path
 * @returns {boolean}
 */
function isPipeWritten(filePath = null) {
    const content = readPipe(filePath);
    return content !== null && content.trim().length > 0;
}

/**
 * Validate that the pipe file was actually written to (not just exists)
 * Used to ensure agent actually edited the file before proceeding
 * @param {string} filePath - Optional custom file path
 * @returns {Object} - { written: boolean, content: string|null, message: string }
 */
function validatePipeWritten(filePath = null) {
    const content = readPipe(filePath);

    if (content === null) {
        return {
            written: false,
            content: null,
            message: "Pipe file not found. Did you forget to edit it?",
        };
    }

    if (content.trim().length === 0) {
        return {
            written: false,
            content: content,
            message: "Pipe file is empty. Please add content.",
        };
    }

    return {
        written: true,
        content: content,
        message: "Pipe file is ready.",
    };
}

module.exports = {
    // Paths
    getPipeBaseDir,
    getMetadataPath,
    getPipePath,

    // Metadata management
    extractMetadata,
    extractExtensions,
    storeMetadata,
    loadMetadata,
    checkMetadataAge,
    clearMetadata,

    // Pipe file management
    writePipe,
    readPipe,
    isPipeWritten,
    validatePipeWritten,
    clearPipe,

    // Combined operations
    clearBoth,
};
