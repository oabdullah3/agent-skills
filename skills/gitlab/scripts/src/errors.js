class CliError extends Error {
  constructor(message, exitCode = 1, details = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

function buildJsonError(error, command, operationMode) {
  return {
    mode: "error",
    command,
    operationMode: operationMode || null,
    error: {
      code: error.details?.code || "CLI_ERROR",
      category: error.details?.category || "runtime",
      message: error.message,
      retryable: Boolean(error.details?.retryable),
      remediation: error.details?.remediation || "Review input flags and rerun.",
      details: error.details || {},
    },
  };
}

module.exports = {
  CliError,
  buildJsonError,
};
