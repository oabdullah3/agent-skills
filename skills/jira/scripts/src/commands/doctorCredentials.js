const { inspectCredentials } = require("../config");

async function doctorCredentialsCommand(_client, args, output) {
  const result = inspectCredentials({
    envDir: args["env-dir"],
    configPath: args["config-path"],
  });
  output(result);
}

module.exports = {
  doctorCredentialsCommand,
};
