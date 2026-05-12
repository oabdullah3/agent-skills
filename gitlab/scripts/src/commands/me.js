async function meCommand(client, output) {
  const me = await client.currentUser();
  output.print({
    mode: "success",
    command: "me",
    operationMode: null,
    result: {
      id: me.id,
      username: me.username,
      name: me.name,
      web_url: me.web_url,
    },
    metadata: {
      gitlabBaseUrl: client.baseUrl,
    },
    warnings: [],
    nextSteps: [],
  });
}

module.exports = {
  meCommand,
};
