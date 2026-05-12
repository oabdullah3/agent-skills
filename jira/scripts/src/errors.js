class CliError extends Error {
  constructor(message, exitCode = 1, options = null) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;

    const normalized = normalizeOptions(options);
    this.code = normalized.code || defaultCodeForExit(exitCode);
    this.category = normalized.category || defaultCategoryForExit(exitCode);
    this.retryable = Boolean(normalized.retryable);
    this.remediation = normalized.remediation || defaultRemediationForExit(exitCode);
    this.details = normalized.details;
    this.diagnostics = normalized.diagnostics;
  }
}

function normalizeOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return { details: options || null, diagnostics: null };
  }

  const known = ["code", "category", "retryable", "remediation", "details", "diagnostics"];
  const hasKnown = known.some((key) => Object.prototype.hasOwnProperty.call(options, key));
  if (hasKnown) {
    return {
      code: options.code,
      category: options.category,
      retryable: options.retryable,
      remediation: options.remediation,
      details: options.details || null,
      diagnostics: options.diagnostics || null,
    };
  }

  return { details: options, diagnostics: null };
}

function defaultCodeForExit(exitCode) {
  if (exitCode === 2) return "ERR_CLI_USAGE";
  if (exitCode === 3) return "ERR_VALIDATION";
  if (exitCode === 5) return "ERR_NOT_FOUND_OR_AMBIGUOUS";
  if (exitCode === 6) return "ERR_RESOLUTION";
  if (exitCode === 10) return "ERR_HTTP";
  if (exitCode === 11) return "ERR_NETWORK";
  return "ERR_INTERNAL";
}

function defaultCategoryForExit(exitCode) {
  if (exitCode === 2 || exitCode === 3) return "validation";
  if (exitCode === 5) return "not-found";
  if (exitCode === 6) return "ambiguity";
  if (exitCode === 10) return "network";
  if (exitCode === 11) return "network";
  return "internal";
}

function defaultRemediationForExit(exitCode) {
  if (exitCode === 2 || exitCode === 3) {
    return "Check command usage and required flags with --help, then retry.";
  }
  if (exitCode === 5 || exitCode === 6) {
    return "Refine selectors and rerun with exact identifiers.";
  }
  if (exitCode === 10 || exitCode === 11) {
    return "Retry later or verify network/auth configuration before retrying.";
  }
  return "Inspect error details and retry with corrected inputs.";
}

function toErrorPayload(err) {
  const base = err instanceof CliError
    ? err
    : new CliError(err?.message || "Unknown error", 1, {
        code: "ERR_INTERNAL",
        category: "internal",
        retryable: false,
        remediation: "Inspect logs and retry.",
      });

  const payload = {
    mode: "error",
    error: {
      code: base.code,
      category: base.category,
      message: base.message,
      retryable: Boolean(base.retryable),
      remediation: base.remediation,
      details: base.details || null,
    },
  };

  if (base.diagnostics) {
    payload.diagnostics = base.diagnostics;
  }

  return payload;
}

module.exports = {
  CliError,
  toErrorPayload,
};
