const { CliError } = require("./errors");

function assertRequiredFlag(args, flag, commandName) {
  if (args[flag] === undefined || args[flag] === null || args[flag] === "") {
    throw new CliError(`Missing required flag for ${commandName}: --${flag}`, 3, {
      code: "ERR_FLAG_REQUIRED",
      category: "validation",
      remediation: `Provide --${flag} and retry ${commandName}.`,
    });
  }
}

function assertForbiddenFlags(args, forbiddenFlags, commandName) {
  const used = forbiddenFlags.filter((flag) => args[flag] !== undefined);
  if (used.length > 0) {
    throw new CliError(
      `Invalid flag(s) for ${commandName}: ${used.map((flag) => `--${flag}`).join(", ")}`,
      3,
      {
        code: "ERR_FLAG_FORBIDDEN",
        category: "validation",
        remediation: `Remove forbidden flags and retry ${commandName}.`,
        details: { commandName, forbiddenFlags: used.map((f) => `--${f}`) },
      }
    );
  }
}

function assertExactlyOneOf(args, flags, groupName, commandName) {
  const used = flags.filter((flag) => args[flag] !== undefined && args[flag] !== null && args[flag] !== "");
  if (used.length !== 1) {
    throw new CliError(
      `Exactly one ${groupName} is required for ${commandName}: ${flags.map((f) => `--${f}`).join(" | ")}`,
      3,
      {
        code: "ERR_FLAG_CONFLICT",
        category: "validation",
        remediation: `Provide exactly one flag from the ${groupName} set and retry ${commandName}.`,
        details: { commandName, groupName, provided: used.map((f) => `--${f}`) },
      }
    );
  }
}

function assertRequiredWith(args, flag, requiredFlags, commandName) {
  if (args[flag] === undefined) return;
  const missing = requiredFlags.filter((required) => args[required] === undefined);
  if (missing.length > 0) {
    throw new CliError(
      `Flag --${flag} in ${commandName} requires: ${missing.map((f) => `--${f}`).join(", ")}`,
      3,
      {
        code: "ERR_FLAG_DEPENDENCY",
        category: "validation",
        remediation: `Add required dependent flags and retry ${commandName}.`,
        details: { commandName, flag: `--${flag}`, missing: missing.map((f) => `--${f}`) },
      }
    );
  }
}

module.exports = {
  assertRequiredFlag,
  assertForbiddenFlags,
  assertExactlyOneOf,
  assertRequiredWith,
};
