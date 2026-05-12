function createOutput(format) {
  const jsonMode = String(format || "text").toLowerCase() === "json";

  return {
    jsonMode,
    print(payload) {
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
  };
}

module.exports = {
  createOutput,
};
