---
name: chrome-devtools-mcp-skill
description: Comprehensive guide for connecting Hermes Agent to Chrome DevTools via MCP server. Enables browser automation, inspection, and programmatic control with full security confirmations and platform-specific instructions.
version: 1.2.0
author: Hermes Agent
license: MIT
---

# Chrome DevTools MCP Skill Guide

## Overview

This skill enables Hermes Agent to control and inspect Chrome/Edge browser instances through the Chrome DevTools Protocol (CDP) via an MCP server. The agent can automate browser actions, capture screenshots, inspect DOM, evaluate JavaScript, and perform advanced profiling and network analysis.

### Use Cases

- **Browser Automation**: Navigate pages, interact with elements, submit forms
- **Web Inspection**: Capture screenshots/PDFs, inspect DOM, read console logs
- **Network Analysis**: Capture and inspect network requests, modify cookies
- **Performance Testing**: Run performance traces, capture heap snapshots, CPU profiles
- **Accessibility Testing**: Generate accessibility snapshots, traverse DOM programmatically

### Supported Environments

- **Windows with WSL2**: MCP server runs on Windows (via cmd.exe) to access Windows-hosted Chrome
- **Native Linux**: MCP server runs via npx with local browser instances
- **macOS**: Native Node.js execution with local browser instances

---

## Security & Safety

**IMPORTANT**: Read this section before proceeding.

### Access Control & Isolation

- The agent will only connect to browser windows you explicitly authorize and prepare
- Enabling remote debugging exposes the DevTools protocol on a local endpoint—use it only for the specific profile/window you intend
- Do not leave sensitive tabs (banking, email, credentials, personal data) open unless you explicitly want the agent to access them
- The agent will ask for explicit confirmation before any action that modifies browser state

### Confirmation Checklist

Before starting, ensure you can answer the following (the agent will verify):

- [ ] Are you running on WSL2 (Windows host), native Linux, or macOS?
- [ ] Is Chrome/Edge installed and available?
- [ ] Is Chrome/Edge open and logged into the account(s) you want the agent to use?
- [ ] Have you opened only the target browser window (close other profiles/windows)?
- [ ] Have you enabled remote debugging for that window?

### Safeguard Behaviors

- **Confirmation Required**: The agent will ask for explicit permission before actions that modify state (navigation, form submission, sign-outs, cookie changes)
- **Code Preview**: The agent will show readable JavaScript snippets before evaluating them in page context
- **Sensitive Operations**: The agent will refuse operations involving password fields, credential use, or account changes unless you explicitly approve and accept the risk

### Command Safety Policy

- Avoid privileged shell commands in skill instructions because some agent/tooling environments block them.
- Prefer user-space install methods (for example, `nvm` for Node.js) when possible.
- If admin rights are required, instruct the user to run their organization's approved admin process outside the agent session instead of embedding elevated commands in this skill.

---

## Setup & Installation

### Phase 1: MCP Server Discovery

The agent will attempt to discover an existing MCP server through safe, permissioned methods:

1. **Query Hermes Configuration**: Check configured MCP servers via built-in APIs
2. **User Input**: Ask if you've already added a chrome-devtools MCP server and, if so, retrieve its name
3. **Process Inspection** (with permission): Search running processes for an active chrome-devtools-mcp server

**Important**: The agent will show the exact command before executing any permission-sensitive operation and requires your explicit approval.

If discovery succeeds, the agent will display results and ask whether you want to use the found server or add a new one.

### Phase 2: Installing & Adding the MCP Server

If discovery finds no existing server, the agent will offer installation commands. Choose the command appropriate for your environment:

#### WSL2 (Windows Host)

The server runs on Windows via `cmd.exe` so it can attach to Windows-hosted Chrome instances:

```bash
hermes mcp add chrome-devtools-win \
  --command cmd.exe \
  --args "/c npx -y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics"
```

This launches the MCP subprocess on the Windows host, enabling it to communicate with the Windows Chrome instance.

#### Native Linux

```bash
hermes mcp add chrome-devtools-local \
  --command npx \
  --args "-y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics"
```

#### macOS

```bash
hermes mcp add chrome-devtools-mac \
  --command npx \
  --args "-y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics"
```

**Flags Explained**:

- `--autoConnect`: Attempts automatic connection to the first available browser instance
- `--no-usage-statistics`: Disables telemetry (recommended for privacy-conscious setups)

**Next Step**: After adding the server, you may need to restart the agent or explicitly ask it to rediscover MCP servers. The agent will guide you through this.

### Phase 3: Enable Remote Debugging in Your Browser

Before the agent can connect, you must explicitly enable remote debugging for the target browser window.

**Important**: Open only the browser window/profile you want the agent to control. Close other windows and profiles to avoid ambiguous target selection.

#### Setup Steps

1. **Open the target Chrome/Edge window** with the profile/account you want the agent to use
2. **Log in** to any accounts you need the agent to access
3. **Enable remote debugging**:
   - Navigate to `chrome://inspect` (or `chrome://inspect/#remote-debugging`)
   - Confirm that remote debugging is enabled for your window/profile (behavior varies by build)
4. **Close unnecessary windows**: Shut down all other browser windows/profiles—leave only your target window open

#### Platform-Specific Notes

- **Windows**: `chrome://inspect` works as described above
- **Linux**: Same process; confirm Chrome has remote debugging capability enabled
- **macOS**: Same process; may require additional security confirmations depending on OS version

**Verification**: Navigate to `chrome://inspect` and verify your target tab appears in the list.

### Phase 4: Connect & Select Target

Once the MCP server is running and remote debugging is enabled, the agent will:

1. **Connect** to the named MCP server (e.g., `chrome-devtools-win`, `chrome-devtools-local`)
2. **Discover targets** using the server's listing tools
3. **Present options** and ask you which tab/window to control

#### Discovery Tools

The agent uses tools like:

- `list_pages` / `list_targets`: Returns open tabs with titles, URLs, and target IDs
- `select_page(pageId)`: Focuses the agent on a specific tab

#### Practical Guidance from Trial Runs

**Observation**: When multiple tabs are open, explicit selection by URL or title is more reliable than ID alone.

**Recommended Pattern**:

```
1. pages = mcp_chrome_devtools_win_list_pages()
   # Returns: [{id: 1, title: "Tab 1", url: "..."}, {id: 7, title: "Overview", url: "https://..."}, ...]

2. pick = find page where title matches "Overview" OR url contains "confluence"
   # Reduces ambiguity when many tabs are open

3. mcp_chrome_devtools_win_select_page(pageId=7)
   # Agent now operates on the selected page
```

**Trial Run Result**: The agent successfully discovered and selected a Confluence overview page (pageId 7) from a list of available targets. The MCP server brought the page to the foreground and made it ready for operations.

---

## Available Tools & Capabilities

The agent accesses these capabilities through MCP-registered tools. Exact tool names follow the pattern: `mcp_{server_name}_{tool_name}`.

**Note**: Availability depends on the MCP server version. The agent will display discovered tool names during setup.

### Target & Session Management

- **`list_targets` / `list_pages`**: Enumerate open browser tabs, windows, service workers, and extension pages
- **`select_page(pageId)`**: Focus the agent on a specific tab
- **`attach_to_target(targetId)`**: Establish a DevTools session with a target

### Navigation & Resource Loading

- **`navigate(targetId, url)`**: Navigate tab to a URL
- **`reload(targetId, [options])`**: Reload page with optional hard refresh
- **`go_back(targetId)`** / **`go_forward(targetId)`**: Browser history navigation

### DOM & Element Interaction

- **`querySelector(selector)`**: Find elements by CSS selector
- **`click(targetId, selector)`**: Emulate a mouse click on an element
- **`press_key(key)`**: Send keyboard input (e.g., "Enter", "Tab", "Control+A")
- **`type(targetId, selector, text)`**: Type text into an input field or textarea
- **`focus(targetId, selector)`**: Focus an element
- **`get_element_property(selector, property)`**: Retrieve element properties

### Screenshots & Captures

- **`screenshot(targetId, [options])`**: Capture page as PNG
  - Trial run result: Screenshots saved with platform-specific paths
- **`screenshot_element(targetId, selector)`**: Capture a single element
- **`capture_pdf(targetId, options)`**: Save page as PDF

### JavaScript Evaluation

- **`evaluate_script(targetId, expression)`**: Execute JavaScript in page context and return result
- Example: `evaluate_script(targetId, "document.title")` returns the page title

### Network & Cookies

- **`get_cookies(targetId, [filter])`**: Read cookies for the page
- **`set_cookies(targetId, cookies)`**: Set or update cookies
- **`network_enable(targetId)`**: Begin network traffic capture
- **`network_get_requests(targetId)`**: Retrieve captured network requests
- **`network_clear(targetId)`**: Clear network log

### Console & Logging

- **`console_enable(targetId)`**: Start capturing console output
- **`console_read(targetId, [filter])`**: Read console messages (logs, warnings, errors)
- **`console_clear(targetId)`**: Clear console

### Performance & Profiling

- **`performance_start_trace(targetId, [options])`**: Begin performance tracing
- **`performance_stop_trace(targetId)`**: Stop tracing and retrieve trace file
- **`take_cpu_profile(targetId, [duration])`**: Capture CPU profile
- **`take_heap_snapshot(targetId)`**: Capture heap snapshot for memory analysis

### Accessibility & Inspection

- **`take_snapshot(targetId, [verbose])`**: Generate accessibility tree snapshot (useful for element location)
  - Trial run result: Verbose snapshots include detailed UID entries for programmatic element selection

### Advanced: Raw Chrome DevTools Protocol

- **`cdp_send_raw(targetId, method, params)`**: Send raw CDP commands for operations not wrapped by high-level tools

---

## Common Operations & Patterns

### 1. List and Select a Page

#### Windows

```javascript
// List all open pages
pages = mcp_chrome_devtools_win_list_pages()

// Output example:
// [
//   { id: 1, title: "Gmail", url: "https://mail.google.com" },
//   { id: 7, title: "Confluence", url: "https://mindlayer.atlassian.net/wiki/..." }
// ]

// Select the Confluence page
mcp_chrome_devtools_win_select_page(pageId=7)
```

#### Linux / macOS

```javascript
// List all open pages
pages = mcp_chrome_devtools_local_list_pages()

// Output example:
// [
//   { id: 1, title: "Gmail", url: "https://mail.google.com" },
//   { id: 7, title: "Confluence", url: "https://mindlayer.atlassian.net/wiki/..." }
// ]

// Select the Confluence page
mcp_chrome_devtools_local_select_page(pageId=7)
```

### 2. Take a Screenshot

#### Windows (via WSL2)

```bash
# Full page screenshot (returns Windows path)
mcp_chrome_devtools_win_take_screenshot(filePath="/tmp/page.png", fullPage=true)
```

#### Linux / macOS

```bash
# Full page screenshot (returns Unix path)
mcp_chrome_devtools_local_take_screenshot(filePath="/tmp/page.png", fullPage=true)
```

**Path Handling Note**: Windows-hosted MCP servers may return Windows-style paths (e.g., `C:\tmp\page.png`). When running from WSL2, convert to `/mnt/c/tmp/page.png` for access.

### 3. Capture Accessibility Snapshot

Useful for locating elements by UID for programmatic interaction.

#### Windows

```javascript
// Generate verbose accessibility snapshot
snapshot = mcp_chrome_devtools_win_take_snapshot(verbose=true)

// Output includes UIDs for each interactive element:
// "uid_234": {"text": "Search", "role": "button", "selector": ".search-btn"}
// Use returned UIDs with click(), press_key(), etc.
```

#### Linux / macOS

```javascript
// Generate verbose accessibility snapshot
snapshot = mcp_chrome_devtools_local_take_snapshot(verbose=true)

// Output includes UIDs for each interactive element:
// "uid_234": {"text": "Search", "role": "button", "selector": ".search-btn"}
// Use returned UIDs with click(), press_key(), etc.
```

### 4. Evaluate JavaScript in Page Context

#### Windows

```javascript
// Get the page title
title = mcp_chrome_devtools_win_evaluate_script(targetId, "document.title")

// Count elements
count = mcp_chrome_devtools_win_evaluate_script(targetId, "document.querySelectorAll('a').length")

// Get form values
values = mcp_chrome_devtools_win_evaluate_script(
  targetId, 
  "JSON.stringify({name: document.querySelector('input[name=name]').value, email: document.querySelector('input[name=email]').value})"
)
```

#### Linux / macOS

```javascript
// Get the page title
title = mcp_chrome_devtools_local_evaluate_script(targetId, "document.title")

// Count elements
count = mcp_chrome_devtools_local_evaluate_script(targetId, "document.querySelectorAll('a').length")

// Get form values
values = mcp_chrome_devtools_local_evaluate_script(
  targetId, 
  "JSON.stringify({name: document.querySelector('input[name=name]').value, email: document.querySelector('input[name=email]').value})"
)
```

### 5. Navigate to a URL

#### Windows

```javascript
mcp_chrome_devtools_win_navigate(targetId, "https://example.com")
// Page begins loading; the agent will wait for navigation to complete
```

#### Linux / macOS

```javascript
mcp_chrome_devtools_local_navigate(targetId, "https://example.com")
// Page begins loading; the agent will wait for navigation to complete
```

### 6. Click an Element

#### Windows (using CSS selector)

```javascript
mcp_chrome_devtools_win_click(targetId, "button.submit")
mcp_chrome_devtools_win_click(targetId, "a[href*='logout']")
```

#### Windows (using UID from snapshot)

```javascript
// First, capture snapshot to get UIDs
snapshot = mcp_chrome_devtools_win_take_snapshot(verbose=true)
// Find UID for "Submit" button in snapshot

// Then click using UID
mcp_chrome_devtools_win_click(targetId, uid="uid_456")
```

#### Linux / macOS (using CSS selector)

```javascript
mcp_chrome_devtools_local_click(targetId, "button.submit")
mcp_chrome_devtools_local_click(targetId, "a[href*='logout']")
```

#### Linux / macOS (using UID from snapshot)

```javascript
// First, capture snapshot to get UIDs
snapshot = mcp_chrome_devtools_local_take_snapshot(verbose=true)
// Find UID for "Submit" button in snapshot

// Then click using UID
mcp_chrome_devtools_local_click(targetId, uid="uid_456")
```

### 7. Type into a Form Field

#### Windows

```javascript
// Type into an input by CSS selector
mcp_chrome_devtools_win_type(targetId, "input[name='username']", "john_doe")
mcp_chrome_devtools_win_type(targetId, "textarea#comments", "This is my feedback")

// Type using UID
mcp_chrome_devtools_win_type(targetId, uid="uid_789", "input text")
```

#### Linux / macOS

```javascript
// Type into an input by CSS selector
mcp_chrome_devtools_local_type(targetId, "input[name='username']", "john_doe")
mcp_chrome_devtools_local_type(targetId, "textarea#comments", "This is my feedback")

// Type using UID
mcp_chrome_devtools_local_type(targetId, uid="uid_789", "input text")
```

### 8. Start Performance Trace & Capture Results

#### Windows

```javascript
// Start tracing
mcp_chrome_devtools_win_performance_start_trace(targetId)

// ... perform actions in the page ...

// Stop and retrieve trace
trace_file = mcp_chrome_devtools_win_performance_stop_trace(targetId, filePath="/tmp/trace.json")
// Output: trace file saved to /tmp/trace.json
```

#### Linux / macOS

```javascript
// Start tracing
mcp_chrome_devtools_local_performance_start_trace(targetId)

// ... perform actions in the page ...

// Stop and retrieve trace
trace_file = mcp_chrome_devtools_local_performance_stop_trace(targetId, filePath="/tmp/trace.json")
// Output: trace file saved to /tmp/trace.json
```

### 9. Read Console Messages

#### Windows

```javascript
// Enable console capture
mcp_chrome_devtools_win_console_enable(targetId)

// ... perform actions ...

// Read messages
messages = mcp_chrome_devtools_win_console_read(targetId)
// Output: [{level: "log", text: "Page loaded"}, {level: "error", text: "Failed to fetch"}]
```

#### Linux / macOS

```javascript
// Enable console capture
mcp_chrome_devtools_local_console_enable(targetId)

// ... perform actions ...

// Read messages
messages = mcp_chrome_devtools_local_console_read(targetId)
// Output: [{level: "log", text: "Page loaded"}, {level: "error", text: "Failed to fetch"}]
```

### 10. Get & Set Cookies

#### Windows

```javascript
// Retrieve all cookies
cookies = mcp_chrome_devtools_win_get_cookies(targetId)

// Set a cookie
mcp_chrome_devtools_win_set_cookies(targetId, [{name: "session_id", value: "abc123"}])
```

#### Linux / macOS

```javascript
// Retrieve all cookies
cookies = mcp_chrome_devtools_local_get_cookies(targetId)

// Set a cookie
mcp_chrome_devtools_local_set_cookies(targetId, [{name: "session_id", value: "abc123"}])
```

---

## JavaScript injection via `evaluate_script`

Refer to docs/javascript-injection-guide.md for more details.

## Safeguards & Confirmation Flow

### State-Modifying Actions

The agent will display a confirmation prompt before executing any action that modifies browser or page state:

**Actions requiring confirmation**:

- Navigation to a new URL
- Form submission or data entry
- Cookie modification
- Signing out or changing account state
- Closing tabs
- Running JavaScript that modifies DOM

**Confirmation format**:

```
The agent will show:
1. The intended action in plain language
2. The code/command to be executed
3. A request for your approval (Yes/No)
```

If you refuse, the agent will explain why it needed the action and ask for alternative instructions.

### Sensitive Operations

**The agent will refuse or require explicit opt-in for**:

- Reading password fields or sensitive input
- Programmatic credential entry (e.g., auto-filling login forms)
- Accessing personal data fields (name, email, phone)
- Modifying account settings or security options

You can override these safeguards by explicitly instructing the agent and confirming you accept the risk, but the agent will require clear, unambiguous approval.

---

## Troubleshooting

### Issue: Agent Cannot Find MCP Server

**Symptoms**: Agent reports "chrome-devtools-mcp server not found" after discovery attempts.

**Solution**:

1. Verify the server name you provided matches what you used during `hermes mcp add`
2. If using Windows/WSL2, ensure the server was added as `chrome-devtools-win` (or your chosen name)
3. Restart the Hermes agent: Ask it to "restart and rediscover MCP servers"
4. Manually add the server if needed using commands from Phase 2 above

### Issue: npx Command Not Found

**Symptoms**: "npx not found" or "npm is not installed" error during server setup.

**Solution**:

- Install Node.js and npm
  - **Windows**: Download from <https://nodejs.org/> or use `choco install nodejs` (if using Chocolatey)
  - **Linux (recommended, no elevated shell command in skill)**: install Node with `nvm` so npm/npx are available in user space
  - **Linux (system package manager)**: install `nodejs` and `npm` with your distro package manager using your organization's approved admin process
  - **macOS**: `brew install node` (if using Homebrew)
- Verify installation: `node --version && npm --version`
- Then retry the server installation command from Phase 2

### Issue: Agent Cannot Attach to Browser Target

**Symptoms**: Agent lists pages but fails to attach or interact with them.

**Solution**:

1. Verify remote debugging is enabled: Navigate to `chrome://inspect` and confirm your target window appears
2. Ensure only the target window is open (close other profiles/windows)
3. For WSL2: Verify the server is running on the Windows host and has access to the Windows Chrome instance
4. Try explicitly selecting the page by URL or title using the pattern from Phase 4

### Issue: Screenshots Show Incorrect Path or Cannot Be Found

**Symptoms**: Screenshot saved to `C:\tmp\page.png` (Windows path) but you can't access from WSL.

**Solution** (WSL2 users):

- Windows paths map to WSL2 as `/mnt/c/`
- Convert: `C:\tmp\page.png` → `/mnt/c/tmp/page.png`
- Example:

  ```bash
  cat /mnt/c/tmp/page.png  # View the file
  cp /mnt/c/tmp/page.png ~/page.png  # Copy to WSL home
  ```

### Issue: Ambiguous Target Selection with Multiple Tabs

**Symptoms**: Agent asks "which tab?" and displays multiple tabs; you're unsure which to pick.

**Solution**:

1. Use the pattern from Phase 4 to select by URL or title match
2. Or, temporarily close all other tabs except your target, then reconnect
3. Provide clear instructions: "Select the tab with title matching 'Confluence Overview'" or "Select the tab at URL <https://example.com>"

### Issue: Sensitive Page Elements Not Responding to Clicks

**Symptoms**: `mcp_chrome_devtools_win_click(selector)` fails or clicks the wrong element.

**Solution**:

1. Use `take_snapshot(verbose=true)` to view the accessibility tree and locate precise UIDs
2. Use the UID directly: `mcp_chrome_devtools_win_click(uid="uid_456")` instead of CSS selector
3. Try alternative selectors: `button:nth-child(2)`, `[data-testid='submit-btn']`, etc.

### Issue: JavaScript Evaluation Returns Undefined

**Symptoms**: `evaluate_script(targetId, expression)` returns `undefined` or unexpected values.

**Solution**:

1. Verify the expression is valid JavaScript: `document.title`, `document.querySelectorAll('a').length`
2. Check if the page has fully loaded before evaluating
3. Use JSON.stringify() to return complex objects: `JSON.stringify({key: value})`
4. For async operations, wrap in async/await (if the MCP server supports it)

### Issue: Performance Trace or Heap Snapshot Not Saving

**Symptoms**: Trace file not found at specified path, or error saving.

**Solution**:

- Ensure the target directory exists and is writable
  - **Linux/macOS**: `mkdir -p /tmp && touch /tmp/test.txt` to verify write access
  - **Windows**: Use a writable directory like `C:\Users\YourUser\Downloads\`
- For WSL2, save to a writable WSL path: `/tmp/` or `~/`
- Provide the full absolute path (not relative paths)

### Issue: Agent Refuses to Perform a Sensitive Operation

**Symptoms**: "I cannot perform that operation without explicit confirmation" when trying to modify credentials or sensitive data.

**Solution**:

1. This is intentional safeguard behavior—it's protecting sensitive operations
2. You can override by explicitly requesting: "I understand the risks. Please [operation]. I consent."
3. Use this sparingly and only for operations you fully understand
4. The agent will log these override approvals for audit purposes

---

## Quick Reference & Copy-Paste Commands

### Discovery & Setup (All Platforms)

**Check for existing server**:

```bash
# The agent will do this automatically with permission
ps aux | grep chrome-devtools-mcp
```

### Installation Commands

**WSL2 (Windows Host)**:

```bash
hermes mcp add chrome-devtools-win \
  --command cmd.exe \
  --args "/c npx -y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics"
```

**Linux**:

```bash
hermes mcp add chrome-devtools-local \
  --command npx \
  --args "-y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics"
```

**macOS**:

```bash
hermes mcp add chrome-devtools-mac \
  --command npx \
  --args "-y chrome-devtools-mcp@latest --autoConnect --no-usage-statistics"
```

### Common Tool Invocations

**List pages (Windows)**:

```
mcp_chrome_devtools_win_list_pages()
```

**List pages (Linux/macOS)**:

```
mcp_chrome_devtools_local_list_pages()
```

**Select page (Windows)**:

```
mcp_chrome_devtools_win_select_page(pageId=7)
```

**Select page (Linux/macOS)**:

```
mcp_chrome_devtools_local_select_page(pageId=7)
```

**Take screenshot (Windows)**:

```
mcp_chrome_devtools_win_take_screenshot(filePath="/tmp/page.png", fullPage=true)
```

**Take screenshot (Linux/macOS)**:

```
mcp_chrome_devtools_local_take_screenshot(filePath="/tmp/page.png", fullPage=true)
```

**Take accessibility snapshot (Windows)**:

```
mcp_chrome_devtools_win_take_snapshot(verbose=true)
```

**Take accessibility snapshot (Linux/macOS)**:

```
mcp_chrome_devtools_local_take_snapshot(verbose=true)
```

**Navigate to URL (Windows)**:

```
mcp_chrome_devtools_win_navigate(targetId, "https://example.com")
```

**Navigate to URL (Linux/macOS)**:

```
mcp_chrome_devtools_local_navigate(targetId, "https://example.com")
```

**Click element (Windows)**:

```
mcp_chrome_devtools_win_click(targetId, "button.submit")
mcp_chrome_devtools_win_click(targetId, uid="uid_456")
```

**Click element (Linux/macOS)**:

```
mcp_chrome_devtools_local_click(targetId, "button.submit")
mcp_chrome_devtools_local_click(targetId, uid="uid_456")
```

**Type text (Windows)**:

```
mcp_chrome_devtools_win_type(targetId, "input#search", "search term")
mcp_chrome_devtools_win_type(targetId, uid="uid_789", "input text")
```

**Type text (Linux/macOS)**:

```
mcp_chrome_devtools_local_type(targetId, "input#search", "search term")
mcp_chrome_devtools_local_type(targetId, uid="uid_789", "input text")
```

**Evaluate JavaScript (Windows)**:

```
mcp_chrome_devtools_win_evaluate_script(targetId, "document.title")
mcp_chrome_devtools_win_evaluate_script(targetId, "JSON.stringify({count: document.querySelectorAll('a').length})")
```

**Evaluate JavaScript (Linux/macOS)**:

```
mcp_chrome_devtools_local_evaluate_script(targetId, "document.title")
mcp_chrome_devtools_local_evaluate_script(targetId, "JSON.stringify({count: document.querySelectorAll('a').length})")
```

**Get cookies (Windows)**:

```
mcp_chrome_devtools_win_get_cookies(targetId)
```

**Get cookies (Linux/macOS)**:

```
mcp_chrome_devtools_local_get_cookies(targetId)
```

**Enable & read console (Windows)**:

```
mcp_chrome_devtools_win_console_enable(targetId)
mcp_chrome_devtools_win_console_read(targetId)
```

**Enable & read console (Linux/macOS)**:

```
mcp_chrome_devtools_local_console_enable(targetId)
mcp_chrome_devtools_local_console_read(targetId)
```

**Start performance trace (Windows)**:

```
mcp_chrome_devtools_win_performance_start_trace(targetId)
# ... perform actions ...
mcp_chrome_devtools_win_performance_stop_trace(targetId, filePath="/tmp/trace.json")
```

**Start performance trace (Linux/macOS)**:

```
mcp_chrome_devtools_local_performance_start_trace(targetId)
# ... perform actions ...
mcp_chrome_devtools_local_performance_stop_trace(targetId, filePath="/tmp/trace.json")
```

---

## Additional Resources & Support

### Package Documentation

- Review the official chrome-devtools-mcp package documentation before installing
- Verify the npm package source to ensure security

### Getting Help

If you encounter issues:

1. Provide the agent with the exact error message and operation that failed
2. Share the discovery output so the agent can diagnose server configuration
3. Check that your environment meets the prerequisites (Node.js, browser, remote debugging enabled)
4. Ask the agent to "explain the tools available" to confirm what was discovered

### Trial Run Insights

From successful trial runs, we've observed:

- **Multi-tab scenarios**: Selecting by URL or title is more reliable than ID alone when many tabs are open
- **Path handling in WSL2**: Windows paths (C:\...) need conversion to `/mnt/c/...` for WSL access
- **Snapshot usefulness**: Verbose accessibility snapshots are invaluable for locating elements by UID
- **Safeguard behavior**: Explicit confirmations protect against accidental sensitive data operations

These patterns are reflected throughout this guide and in the Common Operations section.
