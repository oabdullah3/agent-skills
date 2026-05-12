/**
 * Content Diff Generator
 *
 * Generates line-by-line diffs between original and modified Markdown content.
 * Similar to git diff output format.
 */

/**
 * Generate a diff between two Markdown strings
 * Returns diff in a structured format showing additions, deletions, and context
 *
 * @param {string} originalMarkdown - Original content
 * @param {string} modifiedMarkdown - Modified content
 * @returns {Object} - Diff object with { hasChanges, statistics, hunks }
 */
function generateDiff(originalMarkdown, modifiedMarkdown) {
    const originalLines = (originalMarkdown || "").split("\n");
    const modifiedLines = (modifiedMarkdown || "").split("\n");

    const hunks = computeHunks(originalLines, modifiedLines);
    const stats = computeStats(hunks);

    return {
        hasChanges: stats.additions > 0 || stats.deletions > 0,
        statistics: stats,
        hunks: hunks,
    };
}

/**
 * Compute diff hunks (contiguous sections of changes with context)
 * Uses Myers diff algorithm (simplified implementation)
 *
 * @param {Array<string>} original - Original lines
 * @param {Array<string>} modified - Modified lines
 * @returns {Array} - Array of hunks
 */
function computeHunks(original, modified) {
    const diffs = mydiff(original, modified);
    const hunks = [];

    let currentHunk = null;
    const contextSize = 3; // Lines of context before/after changes

    diffs.forEach((diff, index) => {
        const [type, line, origIndex, modIndex] = diff;

        // Determine if we need a new hunk or can extend current one
        if (type === " ") {
            // Context line
            if (currentHunk) {
                currentHunk.lines.push({
                    type: "context",
                    content: line,
                    originalLineNumber: origIndex + 1,
                    modifiedLineNumber: modIndex + 1,
                });
            }
        } else {
            // Change (+ or -)
            if (!currentHunk) {
                // Start new hunk
                currentHunk = {
                    originalStart: Math.max(0, origIndex - contextSize),
                    originalCount: 0,
                    modifiedStart: Math.max(0, modIndex - contextSize),
                    modifiedCount: 0,
                    lines: [],
                };

                // Add context before
                for (let i = Math.max(0, origIndex - contextSize); i < origIndex; i++) {
                    currentHunk.lines.push({
                        type: "context",
                        content: original[i],
                        originalLineNumber: i + 1,
                        modifiedLineNumber: i + 1,
                    });
                }
            }

            if (type === "-") {
                currentHunk.lines.push({
                    type: "deletion",
                    content: line,
                    originalLineNumber: origIndex + 1,
                    modifiedLineNumber: null,
                });
            } else if (type === "+") {
                currentHunk.lines.push({
                    type: "addition",
                    content: line,
                    originalLineNumber: null,
                    modifiedLineNumber: modIndex + 1,
                });
            }
        }

        // Check if we should close the hunk (too many unchanged lines)
        if (currentHunk && type === " ") {
            const linesSinceChange = diffs.slice(index).findIndex((d) => d[0] !== " ");

            if (linesSinceChange > contextSize * 2 || linesSinceChange === -1) {
                // Close hunk
                hunks.push(currentHunk);
                currentHunk = null;
            }
        }
    });

    if (currentHunk) {
        hunks.push(currentHunk);
    }

    return hunks;
}

/**
 * Simple Myers-like diff algorithm
 * Compares two arrays of lines and returns diff entries
 *
 * @param {Array<string>} original
 * @param {Array<string>} modified
 * @returns {Array} - Array of [type, line, origIndex, modIndex]
 */
function mydiff(original, modified) {
    const diffs = [];
    let origIndex = 0;
    let modIndex = 0;

    // Compute longest common subsequence (simplified)
    const lcs = computeLCS(original, modified);

    // Map original positions to modified positions via LCS
    const origToMod = new Map();
    let lcsOrigIdx = 0;
    let lcsModIdx = 0;

    for (const lcsLine of lcs) {
        // Find next occurrence of this line in both arrays
        while (lcsOrigIdx < original.length && original[lcsOrigIdx] !== lcsLine) {
            lcsOrigIdx++;
        }
        while (lcsModIdx < modified.length && modified[lcsModIdx] !== lcsLine) {
            lcsModIdx++;
        }

        if (lcsOrigIdx < original.length && lcsModIdx < modified.length) {
            origToMod.set(lcsOrigIdx, lcsModIdx);
            lcsOrigIdx++;
            lcsModIdx++;
        }
    }

    // Generate diff by comparing indices
    origIndex = 0;
    modIndex = 0;

    while (origIndex < original.length || modIndex < modified.length) {
        if (origIndex < original.length && modIndex < modified.length && original[origIndex] === modified[modIndex]) {
            // Match
            diffs.push([" ", original[origIndex], origIndex, modIndex]);
            origIndex++;
            modIndex++;
        } else if (origIndex < original.length && modIndex < modified.length && lcs.includes(original[origIndex]) && !lcs.includes(modified[modIndex])) {
            // Insertion in modified
            diffs.push(["+", modified[modIndex], origIndex, modIndex]);
            modIndex++;
        } else if (origIndex < original.length && modIndex < modified.length && !lcs.includes(original[origIndex])) {
            // Deletion from original
            diffs.push(["-", original[origIndex], origIndex, modIndex]);
            origIndex++;
        } else if (origIndex >= original.length && modIndex < modified.length) {
            diffs.push(["+", modified[modIndex], origIndex, modIndex]);
            modIndex++;
        } else if (modIndex >= modified.length && origIndex < original.length) {
            diffs.push(["-", original[origIndex], origIndex, modIndex]);
            origIndex++;
        } else {
            origIndex++;
            modIndex++;
        }
    }

    return diffs;
}

/**
 * Compute Longest Common Subsequence
 * Used to find unchanged lines between versions
 *
 * @param {Array<string>} arr1
 * @param {Array<string>} arr2
 * @returns {Array<string>} - LCS lines
 */
function computeLCS(arr1, arr2) {
    const m = arr1.length;
    const n = arr2.length;
    const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (arr1[i - 1] === arr2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to extract LCS
    const lcs = [];
    let i = m;
    let j = n;

    while (i > 0 && j > 0) {
        if (arr1[i - 1] === arr2[j - 1]) {
            lcs.unshift(arr1[i - 1]);
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return lcs;
}

/**
 * Compute statistics from hunks
 * @param {Array} hunks - Diff hunks
 * @returns {Object} - Statistics with additions, deletions, total changes
 */
function computeStats(hunks) {
    let additions = 0;
    let deletions = 0;

    hunks.forEach((hunk) => {
        hunk.lines.forEach((line) => {
            if (line.type === "addition") additions++;
            if (line.type === "deletion") deletions++;
        });
    });

    return {
        additions,
        deletions,
        total: additions + deletions,
        hunks: hunks.length,
    };
}

/**
 * Format hunks into a human-readable diff string (like git diff)
 * @param {Array} hunks - Diff hunks
 * @param {string} fileName - Optional file name for header
 * @returns {string} - Formatted diff output
 */
function formatDiffOutput(hunks, fileName = "content") {
    const lines = [`--- ${fileName} (original)`, `+++ ${fileName} (modified)`];

    hunks.forEach((hunk) => {
        lines.push(`@@ -${hunk.originalStart},${hunk.originalCount} +${hunk.modifiedStart},${hunk.modifiedCount} @@`);

        hunk.lines.forEach((line) => {
            const prefix = {
                context: " ",
                addition: "+",
                deletion: "-",
            }[line.type];

            const content = line.content.length > 100 ? line.content.substring(0, 97) + "..." : line.content;
            lines.push(`${prefix} ${content}`);
        });
    });

    return lines.join("\n");
}

/**
 * Summarize changes in a human-friendly format
 * @param {Object} diff - Diff object from generateDiff
 * @returns {Object} - Summary with message and details
 */
function summarizeChanges(diff) {
    const { hasChanges, statistics } = diff;

    if (!hasChanges) {
        return {
            summary: "No changes detected.",
            details: {
                additions: 0,
                deletions: 0,
                total: 0,
            },
            message: "The modified content is identical to the original.",
        };
    }

    const addMsg = statistics.additions === 1 ? "1 addition" : `${statistics.additions} additions`;
    const delMsg = statistics.deletions === 1 ? "1 deletion" : `${statistics.deletions} deletions`;

    return {
        summary: `Changes detected: ${addMsg}, ${delMsg}`,
        details: {
            additions: statistics.additions,
            deletions: statistics.deletions,
            total: statistics.total,
            hunks: statistics.hunks,
        },
        message: `${statistics.total} line(s) modified across ${statistics.hunks} section(s).`,
    };
}

module.exports = {
    generateDiff,
    computeHunks,
    computeStats,
    formatDiffOutput,
    summarizeChanges,
};
