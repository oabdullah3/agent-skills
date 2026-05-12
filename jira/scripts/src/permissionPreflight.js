const { CliError } = require("./errors");

function summarizeRequirements(requirements) {
  const normalized = Array.isArray(requirements) ? requirements : [];
  const byCategory = new Map();

  for (const req of normalized) {
    if (!req || !req.category || !req.permissionKey) continue;
    if (!byCategory.has(req.category)) {
      byCategory.set(req.category, {
        category: req.category,
        permissionKey: req.permissionKey,
        description: req.description || req.category,
      });
    }
  }

  return Array.from(byCategory.values());
}

function buildPreflightIntent(requirements, context = {}) {
  const categories = summarizeRequirements(requirements);
  return {
    willRunByDefault: true,
    bypassFlag: "--skip-permission-preflight",
    requiredCategories: categories,
    context,
  };
}

async function runPermissionPreflight(client, args, options) {
  const requirements = summarizeRequirements(options.requirements || []);
  const context = options.context || {};
  const commandName = options.commandName || "mutation finalize";

  if (args["skip-permission-preflight"]) {
    return {
      skipped: true,
      reason: "explicit-skip-flag",
      requirements,
      context,
    };
  }

  if (requirements.length === 0) {
    return {
      skipped: true,
      reason: "no-required-permissions",
      requirements,
      context,
    };
  }

  // Internal deterministic test hook for denied-path verification without mutating calls.
  if (String(process.env.OPENCLAW_PERMISSION_PREFLIGHT_FORCE_DENY || "").toLowerCase() === "true") {
    const missingCategories = requirements.map((req) => req.category);
    throw new CliError(
      `Permission preflight blocked ${commandName}. Missing categories: ${missingCategories.join(", ")}.`,
      3,
      {
        code: "ERR_PERMISSION_PREFLIGHT",
        category: "permission",
        retryable: false,
        remediation:
          "Adjust Jira permissions or rerun with --skip-permission-preflight only when human explicitly approves override.",
        details: {
          commandName,
          missingCategories,
          missingRequirements: requirements,
          context,
        },
      }
    );
  }

  const result = await client.checkPermissions(requirements, context);
  if (!result.ok) {
    const missingCategories = Array.from(new Set((result.missing || []).map((item) => item.category)));
    throw new CliError(
      `Permission preflight blocked ${commandName}. Missing categories: ${missingCategories.join(", ")}.`,
      3,
      {
        code: "ERR_PERMISSION_PREFLIGHT",
        category: "permission",
        retryable: false,
        remediation:
          "Adjust Jira permissions or rerun with --skip-permission-preflight only when human explicitly approves override.",
        details: {
          commandName,
          missingCategories,
          missingRequirements: result.missing,
          checked: result.checked,
          context,
        },
      }
    );
  }

  return {
    skipped: false,
    ok: true,
    checked: result.checked,
    context,
  };
}

module.exports = {
  summarizeRequirements,
  buildPreflightIntent,
  runPermissionPreflight,
};
