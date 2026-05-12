const { CliError } = require("./errors");
const presetConfig = require("./locationPresets.json");

function resolvePageCreatePresetFromArgs(args) {
    const presets = presetConfig.pageCreatePresets || {};
    const matches = [];

    Object.entries(presets).forEach(([presetKey, preset]) => {
        const flagName = String(preset?.flag || "").trim();
        if (!flagName) {
            return;
        }
        if (Boolean(args[flagName])) {
            matches.push({
                presetKey,
                flagName,
                preset,
            });
        }
    });

    if (matches.length === 0) {
        return null;
    }

    if (matches.length > 1) {
        throw new CliError(
            `Multiple location presets requested: ${matches.map((m) => `--${m.flagName}`).join(", ")}. Use only one preset flag.`,
            3
        );
    }

    const match = matches[0];
    const templateSource = match.preset?.templateSource || {};
    const templateSpaceKey = String(templateSource.spaceKey || "").trim();
    const templatePathSegments = Array.isArray(templateSource.pathSegments)
        ? templateSource.pathSegments.map((s) => String(s).trim()).filter(Boolean)
        : [];
    const templateTitle = String(templateSource.title || "").trim();

    if (!templateSpaceKey || templatePathSegments.length === 0 || !templateTitle) {
        throw new CliError(`Location preset '${match.presetKey}' has invalid templateSource configuration.`, 10);
    }

    const destination = match.preset?.destination || null;
    const destinationSpaceKey = String(destination?.spaceKey || "").trim();
    const destinationPathSegments = Array.isArray(destination?.pathSegments)
        ? destination.pathSegments.map((s) => String(s).trim()).filter(Boolean)
        : [];

    const normalizedDestination = destinationSpaceKey
        ? {
            spaceKey: destinationSpaceKey,
            pathSegments: destinationPathSegments,
        }
        : null;

    return {
        presetKey: match.presetKey,
        flagName: match.flagName,
        templateSource: {
            spaceKey: templateSpaceKey,
            pathSegments: templatePathSegments,
            title: templateTitle,
        },
        destination: normalizedDestination,
        description: String(match.preset?.description || "").trim() || null,
    };
}

module.exports = {
    resolvePageCreatePresetFromArgs,
};
