#!/usr/bin/env node

const { run } = require("../src/cli");

run(process.argv.slice(2)).catch((err) => {
  const code = Number.isInteger(err && err.exitCode) ? err.exitCode : 1;
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(code);
});
