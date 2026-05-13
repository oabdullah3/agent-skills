---
name: teams-extractor-skill
version: 1.0.0
description: Extract Microsoft Teams chat messages for a user-selected chat and time range using the evaluate_script tool with a four-step extraction workflow.
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

## 2) Access Strategy

This skill uses the `evaluate_script` tool to run JavaScript functions that extract messages from Teams. The workflow requires the agent to call four functions in order:

1. **injectGlobals** - Injects helper functions into the page (done once per chat or when variables need re-declaring)
2. **extractStart** - Initiates the extraction with a specified time period
3. **extractStatus** - Polls the extraction status until completion
4. **extractResult** - Retrieves the final extracted messages

## 3) Step-by-Step Workflow

### Step 1: Navigate and Verify Context

1. Ensure you have access to Teams in the current browser
2. Navigate to Teams web app (or confirm Teams tab is already open)
3. Click/open the target chat in the left pane and wait for chat content to load
4. Confirm the correct chat is displayed

### Step 2: Collect User Inputs

Before starting extraction, gather:
1. **Target chat name** - person name or group chat name
2. **Time period** - normalize user intent into one of these values:
   - `currentlyLoaded` - only currently visible messages
   - `last24hours` - past 24 hours
   - `last7days` - past 7 days
   - `last30days` - past 30 days
   - `last3months` - past 3 months
   - `allMessages` - all messages in the chat
   - custom: `YYYY-MM-DD to YYYY-MM-DD` - specific date range

### Step 3: Inject Global Functions (First Time Per Chat)

**When to do this:** Only when first navigating to a new chat, or if a later step returns an error about undefined functions.

**Action:** Call `evaluate_script` tool with the exact contents of `scripts/injectGlobals.js` as the parameter.

**Note:** Do NOT include this in subsequent extraction requests for the same chat within the same page session, as the injected functions persist in the window scope.

**Parameter format:** Copy the entire file contents and pass them exactly as:
```javascript
(function injectGlobals(){
    // [exact file contents here - unmodified]
})
```

### Step 4: Start Extraction (Every Extraction Task)

**When to do this:** For each extraction request, even if it's a different time period in the same chat.

**Action:** Call `evaluate_script` tool with the contents of `scripts/extractStart.js`, **with the time period parameter modified** based on user intent.

**Critical:** You MUST modify the `'NEED_TO_REPLACE_THIS_VALUE_WITH_DESIRED_TIME_PERIOD'` placeholder with the actual time period value (e.g., `'last24hours'`).

**extractStart.js reference (for modification):**
```javascript
(function extractStart() {
    const result = window.__extractStart('NEED_TO_REPLACE_THIS_VALUE_WITH_DESIRED_TIME_PERIOD');
    return result; 
})
```

**Example:** If user wants messages from the past 24 hours, you would pass:
```javascript
(function extractStart() {
    const result = window.__extractStart('last24hours');
    return result; 
})
```

**Response:** This returns a result object with a `status` field. If `status === 'finished'`, skip to Step 5. If `status === 'running'`, proceed to Step 5 for polling.

### Step 5: Poll Extraction Status (Until Finished)

**When to do this:** After calling extractStart, poll periodically until extraction is complete.

**When to skip:** If the extractStart response already shows `status === 'finished'`, skip directly to Step 6.

**Action:** Call `evaluate_script` tool repeatedly with the exact contents of `scripts/extractStatus.js` until `status === 'finished'`.

**extractStatus.js reference:**
```javascript
(function extractStatus() {
    const result = window.__extractStatus();
    return result; 
})
```

**Polling strategy:** 
- Call extractStatus
- If `status === 'running'`, wait a reasonable interval (1-2 seconds) and poll again
- If `status === 'finished'`, proceed to Step 6
- Continue until finished

### Step 6: Retrieve Extracted Messages (When Status is Finished)

**When to do this:** Only after extraction status shows `finished`.

**Action:** Call `evaluate_script` tool with the exact contents of `scripts/extractResult.js`.

**extractResult.js reference:**
```javascript
(function extractResult() {
    return window.__extractResult; 
})
```

**Response:** Returns an array of extracted message objects with structure:
```json
[
  {
    "author": "User Name",
    "timestamp": "ISO timestamp",
    "content": "Message text content",
    "reactions": [...],
    ...
  },
  ...
]
```

## 4) evaluate_script Tool

**Tool Name (Platform-Specific):**
- **Linux/macOS:** `mcp_chrome_devtools_local_evaluate_script()`
- **Windows:** `mcp_chrome_devtools_win_evaluate_script()`

When this document refers to "evaluate_script", use the appropriate tool name above based on the operating system.

### evaluate_script Parameter Format

All parameters passed to the `evaluate_script` tool must follow this exact format:

```
(function functionName(){
    // function content here
})
```

**Important:** 
- NO curly braces after the closing parenthesis
- NO semicolon after the closing parenthesis
- Function name matches the source file (injectGlobals, extractStart, extractStatus, extractResult)

## 5) Handling Multiple Extraction Tasks in Same Chat

Example workflow:

1. User: "Extract messages from Chat A for the past 24 hours"
   - Call Step 3 (injectGlobals) once
   - Call Step 4 (extractStart with 'last24hours')
   - Poll with Step 5 until finished
   - Call Step 6 (extractResult)

2. User: "Now show me messages from Chat A for the past month"
   - Skip Step 3 (variables already injected)
   - Call Step 4 (extractStart with 'last30days') - note the new time period parameter
   - Poll with Step 5 until finished
   - Call Step 6 (extractResult)

3. User: "Extract from Chat B for the past week"
   - Call Step 3 (injectGlobals) again - new chat requires re-injection
   - Call Step 4 (extractStart with 'last7days')
   - Poll with Step 5 until finished
   - Call Step 6 (extractResult)

## 6) Error Recovery

If a subsequent step returns an error indicating undefined functions (e.g., `window.__extractStart is not defined`):
- Re-run Step 3 (injectGlobals) to ensure all functions are properly declared
- Then resume with Step 4

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
