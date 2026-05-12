const { CliError } = require("./errors");

function requireFlag(flags, name, message) {
  if (!flags[name]) {
    throw new CliError(message || `Missing required flag --${name}.`, 2, {
      code: "MISSING_FLAG",
      category: "validation",
      remediation: `Rerun with --${name}.`,
    });
  }
}

function requireOneOf(flags, names, message) {
  const provided = names.filter((n) => Boolean(flags[n]));
  if (provided.length !== 1) {
    throw new CliError(
      message || `Provide exactly one of: ${names.map((n) => `--${n}`).join(", ")}.`,
      2,
      {
        code: "INTERCHANGEABLE_SELECTOR_ERROR",
        category: "validation",
        remediation: `Use one selector only: ${names.map((n) => `--${n}`).join(", ")}.`,
      }
    );
  }
}

module.exports = {
  requireFlag,
  requireOneOf,
};
