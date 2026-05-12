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

      if (response.ok) {
        return { status: response.status, data: payload };
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
          const fieldErrors = Object.entries(payload.errors).map(([k, v]) => {
            const rendered = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}: ${rendered}`;
          });
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
        status: response.status,
        data: payload,
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

      throw new CliError(`Request failed: ${err.message}`, 11);
    }
  }

  throw new CliError(`Request failed after retries: ${lastErr?.message || "unknown"}`, 11);
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
