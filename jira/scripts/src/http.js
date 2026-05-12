const { CliError } = require("./errors");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    retries = 2,
    retryDelayMs = 500,
    timeoutMs = 20000,
  } = options;

  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const diagnostics = {
      retriesAttempted: attempt,
      retryDelayMs,
      lastHttpStatus: null,
      requestId: null,
    };

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const text = await response.text();
      const payload = text ? safeJsonParse(text) : null;
      diagnostics.lastHttpStatus = response.status;
      diagnostics.requestId =
        response.headers.get("x-request-id") ||
        response.headers.get("x-trace-id") ||
        response.headers.get("atl-traceid") ||
        null;

      if (response.ok) {
        return { status: response.status, data: payload, diagnostics };
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) {
        await wait(retryDelayMs * (attempt + 1));
        continue;
      }

      let message = `HTTP ${response.status}`;
      if (payload) {
        const parts = [];
        if (Array.isArray(payload.errorMessages) && payload.errorMessages.length > 0) {
          parts.push(payload.errorMessages.join("; "));
        }
        if (payload.errors && typeof payload.errors === "object") {
          const fieldErrors = Object.entries(payload.errors).map(([k, v]) => `${k}: ${v}`);
          if (fieldErrors.length > 0) {
            parts.push(fieldErrors.join("; "));
          }
        }
        if (parts.length > 0) {
          message = parts.join(" | ");
        } else if (payload.message) {
          message = payload.message;
        }
      }

      throw new CliError(message, 10, {
        code: response.status === 429 ? "ERR_RATE_LIMIT" : "ERR_HTTP",
        category: response.status === 401 ? "auth" : response.status === 403 ? "permission" : response.status === 404 ? "not-found" : response.status === 429 ? "rate-limit" : "network",
        retryable,
        remediation: response.status === 429
          ? "Rate-limited by Jira. Retry later."
          : "Verify request inputs and Jira permissions, then retry.",
        details: {
          status: response.status,
          data: payload,
        },
        diagnostics,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      const retryableNetwork =
        err.name === "AbortError" ||
        err.code === "ECONNRESET" ||
        err.code === "ENOTFOUND";

      if (retryableNetwork && attempt < retries) {
        await wait(retryDelayMs * (attempt + 1));
        continue;
      }

      if (err instanceof CliError) {
        throw err;
      }

      throw new CliError(`Request failed: ${err.message}`, 11, {
        code: "ERR_NETWORK",
        category: "network",
        retryable: retryableNetwork,
        remediation: "Check network connectivity and retry.",
      });
    }
  }

  throw new CliError(`Request failed after retries: ${lastErr?.message || "unknown"}`, 11, {
    code: "ERR_NETWORK_RETRIES_EXHAUSTED",
    category: "network",
    retryable: true,
    remediation: "Retries exhausted. Retry later or verify network and Jira availability.",
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

module.exports = {
  requestJson,
};
