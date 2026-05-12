class CliError extends Error {
  constructor(message, exitCode = 1, details = null) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

module.exports = {
  CliError,
};
