#!/usr/bin/env node

const { run } = require("../src/cli");

run(process.argv.slice(2)).catch((err) => {
  const code = Number.isInteger(err.exitCode) ? err.exitCode : 1;
  const message = err.message || "Unknown error";
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
});