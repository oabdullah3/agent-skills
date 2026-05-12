#!/usr/bin/env node

const { run } = require("../src/cli");
const { toErrorPayload } = require("../src/errors");

function wantsJsonError(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--format" && argv[i + 1] === "json") {
      return true;
    }
    if (token.startsWith("--format=")) {
      return token.slice(9) === "json";
    }
  }
  return false;
}

run(process.argv.slice(2)).catch((err) => {
  const code = Number.isInteger(err.exitCode) ? err.exitCode : 1;
  if (wantsJsonError(process.argv.slice(2))) {
    process.stdout.write(`${JSON.stringify(toErrorPayload(err), null, 2)}\n`);
    process.exit(code);
    return;
  }

  const message = err.message || "Unknown error";
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
});
