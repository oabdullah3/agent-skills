---
name: teams-extractor-skill
version: 1.0.0
description: Extract Microsoft Teams chat messages for a user-selected chat and time range using Chrome DevTools MCP when available, with browser-tool fallback.
required_environment_variables: []
optional_environmenta_variables: []
---

# Teams Chat Extractor Skill

Use this skill to extract message history from a specific Microsoft Teams chat and then use that extracted data for downstream analysis tasks.

## 1) Mission

Primary goal:
- extract messages from one user-approved Teams chat
- for one user-approved time period
- and return structured message context for follow-up tasks

## 2) Access Strategy (Chrome DevTools MCP required)

This skill requires the Chrome DevTools MCP server. It will not attempt alternative browser-access tools.

MCP is mandatory; startup commands (these need to be added to the mcp config json, wherever that might be):

Linux/macOS/standard:
```bash
npx chrome-devtools-mcp --autoConnect
```

WSL fallback (if using WSL host):
```bash
cmd.exe /c npx -y chrome-devtools-mcp@latest -u http://localhost:62801
```

Installation / missing MCP behavior:
- If MCP is not running or not installed, the agent must ask the user to add/start MCP and provide the exact command to run.
- Do not attempt to use other browser tools or proceed without MCP.
- Pause and await explicit user confirmation that MCP has been started and the browser approval step (below) has been completed.

Manual approval gate after MCP connect is triggered:
1. Once MCP initiates a browser connection, do not passively wait.
2. Prompt the user to manually allow access in Chrome (accept the connection).
3. Ask the user to reply when access is allowed.
4. Resume the workflow only after the user confirms approval.

Before connecting to an already-open Chrome profile, require this user action:
1. In the target Chrome window, open `chrome://inspect/#remote-debugging`
2. Enable remote debugging
3. Confirm to the agent that this is done

## 3) Mandatory Browser Verification Gate

Do not start Teams actions until browser alignment is verified.

After connecting to browser tabs:
1. Report current tab title and URL, or list open tabs
2. Ask user to confirm this is the intended browser context
3. Proceed only after explicit confirmation

## 4) Teams Navigation Gate

Once browser context is confirmed:
1. Navigate to Teams web app (or switch to existing Teams tab)
2. If login is required, pause and ask user to complete login
3. Continue only after user says login is complete

## 5) Required User Inputs Before Extraction

Collect both inputs explicitly:
1. Target chat in left pane
- person name or group name
- click/open that chat and wait for chat content to load

2. Time period
- all messages
- past week
- or custom date range

Normalize user intent into supported range values:
- `currentlyLoaded`
- `last24hours`
- `last7days`
- `last30days`
- `last3months`
- `allMessages`
- custom: `YYYY-MM-DD to YYYY-MM-DD`

## 6) Script Injection and Runtime Contract

Source script path:
- `skills/teams-extractor-skill/scripts/scroll-and-extract.js`

Inject the script into the console of the Teams tab that has the target chat open.

The script provides:
- `window.extractTeamsChat(rangeMode)` -> returns a Promise resolving to extracted message array

For compatibility with this skill contract, create helper runtime wrappers once per page session:

```javascript
window.__extractState = {status:'idle',startedAt:null,finishedAt:null,count:0,error:null};
window.__extractResult = null;
window.__extractStart = (rangeMode)=> {
  if (window.__extractState.status === 'running') return window.__extractState;
  window.__extractState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    count: 0,
    error: null
  };
  window.__extractPromise = window.extractTeamsChat(rangeMode)
    .then(res => {
      window.__extractResult = res || [];
      window.__extractState.status = 'done';
      window.__extractState.finishedAt = new Date().toISOString();
      window.__extractState.count = window.__extractResult.length;
    })
    .catch(err => {
      window.__extractState.status = 'error';
      window.__extractState.error = String(err);
    });
  return window.__extractState;
};
window.__extractStatus = () => window.__extractState;
```

## 7) Execution Flow

Run extraction (non-blocking):
```javascript
window.__extractStart('last30days');
```

Polling contract:
- poll `window.__extractStatus()` periodically (every 1-2 seconds recommended)
- each poll returns immediately with current status
- watch for status transitions: 'running' → 'done' or 'error'
- the count field shows number of messages collected so far

Completion logic:
- when status is done, run `window.__extractResult()` to get the message array
- when status is error, check `window.__extractState.error` for details
- when status is 'running', continue polling (extraction is still in progress)

Note: The extraction runs as a background promise in the page - MCP calls return immediately, avoiding timeouts.

## 8) Output Handling

`window.__extractResult()` returns the extracted message array ONLY when status is 'done'.
Always check `window.__extractState.status` first:
- If 'done': safe to call `window.__extractResult()` for results
- If 'error': check `window.__extractState.error` for failure details
- If 'running': extraction still in progress, continue polling

Expected item shape (from extractor):
- `id`
- `date`
- `timestamp`
- `author`
- `content`
- `metadata`:
  - `hasMentions`, `mentions`
  - `isReply`, `replyTo`
  - `hasImages`, `hasVideos`, `hasGif`

When summarizing or answering follow-up questions:
- clearly state the selected chat and time range used
- cite uncertainty if extraction appears incomplete
- avoid inferring messages outside extracted data

## 9) Safety and Scope Rules

Always:
- get explicit user confirmation for target chat and date window
- keep extraction limited to user-requested chat/time period
- pause for user confirmation at login and browser-alignment gates

Never:
- extract from other chats without user approval
- proceed when browser context is ambiguous
- claim completion before `window.__extractStatus()` reports completion

## 9.5) Reliability Notes

- This non-blocking pattern avoids MCP timeouts by separating:
  * MCP layer: instant wrapper injection and status polling (milliseconds)
  * Page layer: background extraction promise (can run minutes)
- Always verify `window.extractTeamsChat` exists before injection:
  ```javascript
  mcp_chrome_devtools_win_evaluate_script({function: "() => !!window.extractTeamsChat"})
  ```
- If `extractTeamsChat` becomes undefined (due to page reload/navigation), re-inject the wrapper and restart
- For very long extractions (>15 mins), consider chunking into weekly ranges and merging results
