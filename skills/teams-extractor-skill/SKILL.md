---
name: teams-extractor-skill
version: 1.0.0
description: Extract Microsoft Teams chat messages for a user-selected chat and time range using Chrome DevTools MCP, then run the mcp_chrome_devtools_win_evaluate_script() extraction workflow.
---

# Teams Chat Extractor Skill

Use this skill to extract message history from a specific Microsoft Teams chat and then use that extracted data for downstream analysis tasks.

## 1) Mission

Primary goal:

- extract messages from one user-approved Teams chat
- for one user-approved time period
- and return structured message context for follow-up tasks

## 2) Required Prerequisite

Before doing anything else, the agent must first refer to the chrome-devtools-mcp-skill to understand how to interact with the browser and how to help the user install or enable the Chrome DevTools MCP server if it is not already available.

If the chrome-devtools-mcp-skill is missing in the agent, the agent must guide the user on how to install that skill first so it can then refer to it. The install hint is that the skill is available publicly at `oabdullah3/agent-skills/skills/chrome-devtools-mcp-skill`.

This skill does not use browser fallback tools. If Chrome DevTools MCP is unavailable, the agent must stop and guide the user to set it up.

## 3) Access Strategy

Use Chrome DevTools MCP only.

The agent should work in this order before any evaluate-script extraction:

1. List browser pages
2. Navigate to Teams
3. Snapshot the page to verify login and current chat selection
4. Select/open the correct chat in Teams
5. Then start the mcp_chrome_devtools_win_evaluate_script() extraction flow

Platform-specific tool names:

- **Windows**: use the `mcp_chrome_devtools_win_*` tools
- **macOS/Linux**: use the `mcp_chrome_devtools_local_*` tools

### Preferred browser setup sequence

1. Call `mcp_chrome_devtools_win_list_pages()` or `mcp_chrome_devtools_local_list_pages()` to see what tabs/windows are available.
2. Call `mcp_chrome_devtools_win_navigate_page()` or `mcp_chrome_devtools_local_navigate_page()` to go to Teams if Teams is not already the active page.
3. Call `mcp_chrome_devtools_win_take_snapshot()` or `mcp_chrome_devtools_local_take_snapshot()` to inspect whether the user is logged in and whether the desired chat is already selected.
4. If the snapshot shows the user is not logged in, ask the user to log in and confirm when ready.
5. Use the mcp_chrome_devtools_win_click() to select the relevant chat if it is not already selected. Clickable icons to acess chat are typically displayed on the left vertical bar.
6. Only after the correct chat is open should the agent begin the mcp_chrome_devtools_win_evaluate_script() workflow.

### Tool-call intent

The exact browser-call sequence the agent should ideally make is:

1. `mcp_chrome_devtools_*_list_pages()`
2. `mcp_chrome_devtools_*_navigate_page()`
3. `mcp_chrome_devtools_*_snapshot()`
4. `mcp_chrome_devtools_*_select_page()` and/or the appropriate click/navigation interaction to open the target Teams chat
5. `mcp_chrome_devtools_win_evaluate_script()` workflow below

## 4) mcp_chrome_devtools_win_evaluate_script() Workflow

This skill uses the `mcp_chrome_devtools_win_evaluate_script()` tool to run JavaScript functions that extract messages from Teams. The workflow requires the agent to call four functions in order:

1. **injectGlobals** - Injects helper functions into the page (done once per chat or when variables need re-declaring)
2. **extractStart** - Initiates the extraction with a specified time period
3. **extractStatus** - Polls the extraction status until completion
4. **extractResult** - Retrieves the final extracted messages

## 5) Step-by-Step Workflow

### Step 1: Navigate and Verify Context

1. Use Chrome DevTools MCP only.
2. List available pages/tabs with the platform-appropriate `list_pages()` tool.
3. Navigate to Teams with the platform-appropriate `navigate_page()` tool if needed.
4. Take a snapshot with the platform-appropriate `snapshot()` tool to confirm login state and current chat selection.
5. If Teams is not loaded or the desired chat is not selected, use the platform-appropriate page-selection and click/navigation tools to open the correct chat.
6. Wait for the chat pane to finish loading before continuing.
7. Confirm the correct chat is displayed.

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

**Action:** Call `mcp_chrome_devtools_win_evaluate_script()` tool with the exact contents of `scripts/injectGlobals.js` as the parameter.

**Note:** Do NOT include this in subsequent extraction requests for the same chat within the same page session, as the injected functions persist in the window scope.

**Parameter format:** Copy the entire file contents and pass them exactly as:

```javascript
(function injectGlobals(){
    // [exact file contents here - unmodified]
})
```

### Step 4: Start Extraction (Every Extraction Task)

**When to do this:** For each extraction request, even if it's a different time period in the same chat.

**Action:** Call `mcp_chrome_devtools_win_evaluate_script()` tool with the contents of `scripts/extractStart.js`, **with the time period parameter modified** based on user intent.

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

**Response:** This returns a result object with a `status` field. If `status === 'done'`, skip to Step 5. If `status === 'running'`, proceed to Step 5 for polling.

### Step 5: Poll Extraction Status (Until Done)

**When to do this:** After calling extractStart, poll periodically until extraction is complete.

**When to skip:** If the extractStart response already shows `status === 'done'`, skip directly to Step 6.

**Action:** Call `mcp_chrome_devtools_win_evaluate_script()` tool repeatedly with the exact contents of `scripts/extractStatus.js` until `status === 'done'`.

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
- If `status === 'done'`, proceed to Step 6
- Continue until done

### Step 6: Retrieve Extracted Messages (When Status is Done)

**When to do this:** Only after extraction status shows `done`.

**Action:** Call `mcp_chrome_devtools_win_evaluate_script()` tool with the exact contents of `scripts/extractResult.js`.

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

## 6) mcp_chrome_devtools_win_evaluate_script() Tool

**Tool Name (Platform-Specific):**

- **Linux/macOS:** `mcp_chrome_devtools_local_evaluate_script()`
- **Windows:** `mcp_chrome_devtools_win_evaluate_script()`

When this document refers to "mcp_chrome_devtools_win_evaluate_script()", use the appropriate tool name above based on the operating system.

### mcp_chrome_devtools_win_evaluate_script() Parameter Format

All parameters passed to the `mcp_chrome_devtools_win_evaluate_script()` tool must follow this exact format:

```
(function functionName(){
    // function content here
})
```

**Important:**

- NO curly braces after the closing parenthesis
- NO semicolon after the closing parenthesis
- Function name matches the source file (injectGlobals, extractStart, extractStatus, extractResult)

## 7) Handling Multiple Extraction Tasks in Same Chat

Example workflow:

1. User: "Extract messages from Chat A for the past 24 hours"
   - Call Step 3 (injectGlobals) once
   - Call Step 4 (extractStart with 'last24hours')

- Poll with Step 5 until done
- Call Step 6 (extractResult)

1. User: "Now show me messages from Chat A for the past month"
   - Skip Step 3 (variables already injected)
   - Call Step 4 (extractStart with 'last30days') - note the new time period parameter

- Poll with Step 5 until done
- Call Step 6 (extractResult)

1. User: "Extract from Chat B for the past week"
   - Call Step 3 (injectGlobals) again - new chat requires re-injection
   - Call Step 4 (extractStart with 'last7days')

- Poll with Step 5 until done
- Call Step 6 (extractResult)

## 8) Error Recovery

If a subsequent step returns an error indicating undefined functions (e.g., `window.__extractStart is not defined`):

- Re-run Step 3 (injectGlobals) to ensure all functions are properly declared
- Then resume with Step 4

## 9) Output Handling

`window.__extractResult()` returns the extracted message array only when status is done.
Always check `window.__extractState.status` first:

- If `done`: safe to call `window.__extractResult()` for results
- If `error`: check `window.__extractState.error` for failure details
- If `running`: extraction still in progress, continue polling

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

## 10) Safety and Scope Rules

Always:

- get explicit user confirmation for target chat and date window
- keep extraction limited to user-requested chat/time period
- pause for user confirmation at login and browser-alignment gates

Never:

- extract from other chats without user approval
- proceed when browser context is ambiguous
- claim completion before `window.__extractStatus()` reports completion

## 11) Reliability Notes

- This non-blocking pattern avoids MCP timeouts by separating:
  - MCP layer: instant wrapper injection and status polling (milliseconds)
  - Page layer: background extraction promise (can run minutes)
- Always verify `window.extractTeamsChat` exists before injection:

  ```javascript
  mcp_chrome_devtools_win_evaluate_script()({function: "() => !!window.extractTeamsChat"})
  ```

- If `extractTeamsChat` becomes undefined (due to page reload/navigation), re-inject the wrapper and restart
- For very long extractions (>15 mins), consider chunking into weekly ranges and merging results
