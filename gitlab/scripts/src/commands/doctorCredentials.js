const { inspectCredentialSources } = require("../config");

async function doctorCredentialsCommand(flags, output, context) {
  const diagnostics = inspectCredentialSources(flags, context.invocationCwd);
  output.print({
    mode: "doctor-credentials",
    command: "doctor credentials",
    operationMode: null,
    result: diagnostics,
    metadata: {
      invocationCwd: context.invocationCwd,
    },
    warnings: [],
    nextSteps: [],
  });
}

module.exports = {
  doctorCredentialsCommand,
};
