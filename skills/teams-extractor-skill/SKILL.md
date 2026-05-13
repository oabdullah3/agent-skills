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

## 2) Access Strategy (MCP First, Browser Fallback)

Preferred access order:
1. Chrome DevTools MCP server
2. Existing browser access tools/skills already available in the environment
3. Ask user to install/enable MCP access if neither path works

MCP startup commands:

Linux/macOS/standard:
```bash
npx chrome-devtools-mcp --autoConnect
```

WSL fallback:
```bash
cmd.exe /c npx -y chrome-devtools-mcp@latest -u http://localhost:62801
```

Before connecting to an already-open Chrome profile, require this user action:
1. In the target Chrome window, open `chrome://inspect/#remote-debugging`
2. Enable remote debugging
3. Confirm to the agent that this is done

If access still fails:
- attempt existing browser tools
- if unsuccessful, ask user/agent to add or start Chrome DevTools MCP
- stop extraction steps until browser access is confirmed

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
window.__extractState = { status: 'idle', startedAt: null, doneAt: null, error: null, result: null };

window.__extractStart = function(rangeMode) {
  window.__extractState = { status: 'running', startedAt: new Date().toISOString(), doneAt: null, error: null, result: null };
  window.__extractPromise = window.extractTeamsChat(rangeMode)
    .then((result) => {
      window.__extractState.status = 'completed';
      window.__extractState.doneAt = new Date().toISOString();
      window.__extractState.result = result;
      return result;
    })
    .catch((err) => {
      window.__extractState.status = 'failed';
      window.__extractState.doneAt = new Date().toISOString();
      window.__extractState.error = String(err && err.message ? err.message : err);
      throw err;
    });
  return window.__extractPromise;
};

window.__extractStatus = function() {
  const count = Array.isArray(window.__extractState?.result) ? window.__extractState.result.length : null;
  return { ...window.__extractState, count };
};

window.__extractResult = function() {
  return window.__extractState?.result ?? null;
};
```

## 7) Execution Flow

Run extraction:
```javascript
window.__extractStart('last30days');
```

Polling contract:
- poll `window.__extractStatus()` periodically
- treat this as long-running and be patient
- do not interrupt unless user asks to cancel

Completion logic:
- when status is `completed`, run `window.__extractResult()`
- when status is `failed`, report error and ask whether to retry with a narrower date range or different chat

## 8) Output Handling

`window.__extractResult()` returns an array of messages (chronological) suitable for downstream analysis.

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
