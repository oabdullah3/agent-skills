const { CliError } = require("./errors");

function makeResolution(status, selector, options = {}) {
  return {
    status,
    selector,
    candidates: options.candidates || [],
    selected: options.selected || null,
    instruction: options.instruction || "",
  };
}

function resolveInstruction(command, status) {
  if (status === "resolved") {
    return `Resolution complete for ${command}. Continue with the same selector values for the next command step.`;
  }
  if (status === "ambiguous") {
    return `Resolution is ambiguous for ${command}. Choose one candidate and rerun with an exact identifier.`;
  }
  return `No match found for ${command}. Refine selector input and rerun resolve mode.`;
}

function classifyIssueLookupError(err) {
  if (!(err instanceof CliError)) {
    throw err;
  }
  const status = err?.details?.status;
  if (status === 404 || err.category === "not-found") {
    return "no-match";
  }
  return "error";
}

module.exports = {
  makeResolution,
  resolveInstruction,
  classifyIssueLookupError,
};
