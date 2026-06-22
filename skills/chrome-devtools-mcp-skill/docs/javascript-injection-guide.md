---
name: javascript-injection-guide
description: This file teaches agents how to construct JavaScript that actually works when injected into the browser console via `evaluate_script`. Standard JavaScript written for Node.js or normal browser scripts will often fail or behave unexpectedly when injected through the MCP. This guide explains the patterns that make injection reliable.
---
# JavaScript Injection Guide for `evaluate_script`

## Why Standard JavaScript Fails

When you pass code to `evaluate_script`, it executes in the page's global scope — once. Variables declared with `let`, `const`, or `var` inside the injected script are NOT accessible on subsequent `evaluate_script` calls. Each call gets a fresh scope. If you declare a helper function in one call, it's gone by the next call.

**Broken pattern** (DO NOT USE):\

```javascript
// ❌ This variable is lost after evaluate_script returns
var myHelper = function() { return document.title; };
// Later evaluate_script call cannot see myHelper
```

---

## 1. The IIFE Wrapper — Required Syntax

ALL code passed to `evaluate_script` MUST be wrapped in an IIFE (Immediately Invoked Function Expression). This is the ONLY format that the MCP tool accepts reliably.

**Correct IIFE format:**

```javascript
(function functionName(){
    // Your code here
})
```

**Critical rules:**

- NO curly braces `{}` after the closing parenthesis `)`
- NO semicolon `;` after the closing parenthesis `)`
- The function name should match what the script does (e.g., `injectGlobals`, `extractStart`, `scrapeTable`)

**Correct examples:**

```javascript
// ✅ Simple expression
(function getPageTitle(){
    return document.title;
})

// ✅ DOM manipulation
(function highlightLinks(){
    document.querySelectorAll('a').forEach(a => a.style.border = '2px solid red');
    return document.querySelectorAll('a').length;
})

// ✅ Multi-line logic
(function extractTableData(){
    const rows = document.querySelectorAll('table tr');
    const data = [];
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        data.push(Array.from(cells).map(c => c.textContent));
    });
    return data;
})
```

**Wrong formats** (will fail):

```javascript
// ❌ No IIFE wrapper — scope issues
return document.title;

// ❌ Extra braces after IIFE
(function getTitle(){
    return document.title;
}){}   // ← these braces break it

// ❌ Semicolon after IIFE
(function getTitle(){
    return document.title;
});    // ← this semicolon breaks it

// ❌ Arrow function (not wrapped as IIFE)
() => document.title

// ❌ Async IIFE without proper structure
(async () => { return await fetch('/api'); })()
```

---

## 2. Where to Declare Functions & Variables — The `window` Object

Since each `evaluate_script` call gets a fresh scope, you MUST attach anything that needs to persist across calls to the `window` object. The `window` object lives for the lifetime of the page and is shared across all `evaluate_script` calls.

**Pattern: Declare once on `window`, use across calls**

**Step A — Inject globals (do once per page session):**

```javascript
(function injectGlobals(){
    // Attach helper functions to window
    window.__myHelpers = {
        formatDate: function(isoString) {
            return new Date(isoString).toLocaleDateString();
        },
        extractText: function(selector) {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : '';
        }
    };

    // Attach state objects to window
    window.__myState = { status: 'idle', data: null, error: null };

    // Attach action functions to window
    window.__doWork = function(param) {
        window.__myState.status = 'running';
        // ... do work ...
        window.__myState.status = 'done';
        window.__myState.data = result;
    };

    // Attach status checker to window
    window.__checkStatus = function() {
        return window.__myState.status;
    };

    // Attach result getter to window
    window.__getResult = function() {
        return window.__myState.data;
    };
})
```

**Step B — Call into window functions (use in subsequent calls):**

```javascript
(function startWork(){
    return window.__doWork('someParam');
})

(function checkProgress(){
    return window.__checkStatus();
})

(function getResults(){
    return window.__getResult();
})
```

**Naming convention:** Use `__` prefix for all window-level variables to avoid collisions with page scripts. Examples: `window.__extractState`, `window.__myData`, `window.__helpers`.

---

## 3. How to Return Values

The return value of your IIFE becomes the return value of `evaluate_script`. The MCP tool serializes it as JSON.

**Rules for return values:**

- Return simple values directly: strings, numbers, booleans
- Return objects and arrays — they auto-serialize to JSON
- Do NOT return DOM elements — they cannot be serialized
- To return element data, extract properties into plain objects first

**Correct return patterns:**

```javascript
// ✅ Return a primitive
(function getCount(){
    return document.querySelectorAll('.item').length;
})

// ✅ Return a plain object
(function getPageInfo(){
    return {
        title: document.title,
        url: window.location.href,
        linkCount: document.querySelectorAll('a').length
    };
})

// ✅ Return an array of plain objects
(function extractLinks(){
    return Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim(),
        href: a.href
    }));
})

// ✅ Return a stringified complex value (belt and suspenders)
(function getState(){
    return JSON.stringify(window.__myState);
})
```

**Wrong return patterns:**

```javascript
// ❌ Returns a DOM element — cannot serialize
(function getElement(){
    return document.querySelector('.main');
})

// ❌ Returns a NodeList — cannot serialize
(function getElements(){
    return document.querySelectorAll('li');
})

// ❌ Returns undefined — no useful data
(function doSomething(){
    console.log('done');  // console.log output is NOT captured as return value
})
```

---

## 4. The Separation Pattern for Long-Running Tasks

When a task takes more than a few seconds (scrolling, waiting for network, processing large data), you MUST separate it into non-blocking pieces. If your injected script runs too long, the MCP tool will time out.

The separation pattern, as demonstrated in `teams-extractor-skill`:

| Script File        | Purpose                                | Pattern                                   |
| ------------------ | -------------------------------------- | ----------------------------------------- |
| `injectGlobals.js` | Declare everything on `window`         | Full IIFE, run once                       |
| `extractStart.js`  | Kick off async work, return immediately| Thin wrapper → calls `window.__start()`   |
| `extractStatus.js` | Poll for completion                    | Thin wrapper → calls `window.__status()`  |
| `extractResult.js` | Retrieve final data                    | Thin wrapper → returns `window.__result`  |

**How it works under the hood:**

The "globals" script sets up a Promise-based runner on `window`:

```javascript
(function injectGlobals(){
    // The heavy async work
    window.__heavyTask = async function(param) {
        let results = [];
        for (let i = 0; i < 100; i++) {
            // ... scroll, wait, collect ...
            await new Promise(r => setTimeout(r, 50));
        }
        return results;
    };

    // State management
    window.__taskState = { status: 'idle', result: null, error: null };

    // Non-blocking start — kicks off the promise and returns immediately
    window.__startTask = function(param) {
        if (window.__taskState.status === 'running') return window.__taskState;
        window.__taskState = { status: 'running', startedAt: Date.now() };
        window.__taskPromise = window.__heavyTask(param)
            .then(res => {
                window.__taskState.status = 'done';
                window.__taskState.result = res;
            })
            .catch(err => {
                window.__taskState.status = 'error';
                window.__taskState.error = String(err);
            });
        return window.__taskState;
    };

    // Status check — returns instantly
    window.__checkTask = function() {
        return window.__taskState;
    };
})
```

The thin wrappers (in separate `evaluate_script` calls):

```javascript
// Start — returns immediately, work happens in background
(function startTask(){
    return window.__startTask('paramValue');
})

// Poll — returns status instantly
(function checkTask(){
    return window.__checkTask();
})

// Retrieve — only when status === 'done'
(function getTaskResult(){
    return window.__taskState.result;
})
```

**Agent polling workflow:**

1. Call `evaluate_script` with the start wrapper → returns `{status: 'running'}`
2. Wait 1-2 seconds
3. Call `evaluate_script` with the status wrapper → if `{status: 'running'}`, go to step 2
4. When `{status: 'done'}`, call `evaluate_script` with the result wrapper
5. If `{status: 'error'}`, read `window.__taskState.error`

---

## 5. Dummy Examples: Converting Standard JavaScript to Injection-Ready Code

Each example below shows: (A) the original standard JS, (B) why it fails when injected, and (C) the corrected injection-ready version.

---

### Example 1: Scraping a Table

**Standard JS (won't work when injected):**

```javascript
function scrapeTable() {
    const rows = document.querySelectorAll('table.users tr');
    const users = [];
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        users.push({
            name: cells[0].textContent,
            email: cells[1].textContent
        });
    });
    console.log(users);
    return users;
}
scrapeTable();
```

**Why it fails:** No IIFE wrapper. The `scrapeTable` function is declared but not callable from subsequent `evaluate_script` calls.

**Injection-ready version:**

```javascript
(function scrapeUsersTable(){
    const rows = document.querySelectorAll('table.users tr');
    const users = [];
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
            users.push({
                name: cells[0].textContent.trim(),
                email: cells[1].textContent.trim()
            });
        }
    });
    return users;
})
```

---

### Example 2: Form Data Extraction (Multi-Step)

**Scenario:** You need to extract form data, then later submit it.

**Standard JS approach (won't work across calls):**

```javascript
// Call 1
let formData = {};
document.querySelectorAll('input').forEach(i => formData[i.name] = i.value);

// Call 2 — ERROR: formData is undefined
console.log(formData);
```

**Injection-ready version:**

*Inject globals (call once):*

```javascript
(function injectFormHelpers(){
    window.__formExtractor = {
        // Extract all form fields into a plain object
        extract: function(formSelector) {
            const form = document.querySelector(formSelector);
            if (!form) return { error: 'Form not found' };
            const data = {};
            form.querySelectorAll('input, select, textarea').forEach(el => {
                if (el.name) data[el.name] = el.value;
            });
            window.__formExtractor.cached = data;
            return data;
        },

        // Get specific field
        getField: function(name) {
            return window.__formExtractor.cached ? window.__formExtractor.cached[name] : null;
        },

        // Set a field value
        setField: function(name, value) {
            const el = document.querySelector(`[name="${name}"]`);
            if (el) {
                // Use native value setter to trigger React/Angular bindings
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ).set;
                nativeSetter.call(el, value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (window.__formExtractor.cached) {
                window.__formExtractor.cached[name] = value;
            }
        },

        cached: null
    };

    return 'Form helpers injected';
})
```

*Extract form (subsequent call):*

```javascript
(function extractForm(){
    return window.__formExtractor.extract('#checkout-form');
})
```

*Modify a field (subsequent call):*

```javascript
(function updateEmail(){
    window.__formExtractor.setField('email', 'new@example.com');
    return window.__formExtractor.getField('email');
})
```

---

### Example 3: Auto-Scroll Collection (Separation Pattern)

**Scenario:** Collect items from an infinite-scroll feed. This takes time — needs the separation pattern.

**Standard JS (will timeout if injected directly):**

```javascript
async function collectAllItems() {
    const items = [];
    for (let i = 0; i < 50; i++) {
        document.querySelectorAll('.feed-item').forEach(el => {
            items.push(el.textContent);
        });
        window.scrollBy(0, 500);
        await new Promise(r => setTimeout(r, 200));
    }
    return items;
}
collectAllItems().then(console.log);
```

**Why it fails:** The async loop runs inside `evaluate_script` and will exceed the MCP timeout. The promise resolves, but the tool already gave up waiting.

**Injection-ready version — using separation:**

*Step 1: Inject globals (do once):*

```javascript
(function injectScrollCollector(){
    window.__scrollState = { status: 'idle', items: [], error: null };

    window.__collectOnScroll = async function(itemSelector, maxScrolls, scrollPx, waitMs) {
        const seen = new Set();
        const items = [];

        for (let i = 0; i < maxScrolls; i++) {
            document.querySelectorAll(itemSelector).forEach(el => {
                const text = el.textContent.trim();
                if (text && !seen.has(text)) {
                    seen.add(text);
                    items.push(text);
                }
            });

            const before = window.scrollY;
            window.scrollBy(0, scrollPx);
            await new Promise(r => setTimeout(r, waitMs));

            // Stop if we hit the bottom (no more scroll progress)
            if (Math.abs(window.scrollY - before) < 5) break;
        }
        return items;
    };

    window.__startScrollCollect = function(itemSelector, maxScrolls, scrollPx, waitMs) {
        if (window.__scrollState.status === 'running') return window.__scrollState;
        window.__scrollState = { status: 'running', items: [], error: null };
        window.__scrollCollectPromise = window.__collectOnScroll(
            itemSelector || '.feed-item',
            maxScrolls || 50,
            scrollPx || 500,
            waitMs || 200
        ).then(res => {
            window.__scrollState.status = 'done';
            window.__scrollState.items = res;
        }).catch(err => {
            window.__scrollState.status = 'error';
            window.__scrollState.error = String(err);
        });
        return window.__scrollState;
    };

    window.__checkScrollCollect = function() {
        return window.__scrollState;
    };

    return 'Scroll collector injected';
})
```

*Step 2: Start collection (subsequent call):*

```javascript
(function startCollect(){
    return window.__startScrollCollect('.feed-item', 50, 500, 200);
})
// Returns immediately: {status: 'running', items: [], error: null}
```

*Step 3: Poll until done (repeated calls):*

```javascript
(function checkCollect(){
    return window.__checkScrollCollect();
})
// Returns: {status: 'running', ...}  or  {status: 'done', items: [...]}
```

*Step 4: Retrieve results (when done):*

```javascript
(function getCollected(){
    return window.__scrollState.items;
})
```

---

### Example 4: DOM State Snapshot (Before/After Comparison)

**Scenario:** Capture DOM state before clicking, click, then diff the changes.

**Standard JS (state lost between calls):**

```javascript
// Call 1
const before = document.querySelectorAll('.notification').length; // e.g., 3

// [agent clicks something via another tool]

// Call 2 — ERROR: 'before' is undefined
const after = document.querySelectorAll('.notification').length;
console.log(after - before); // fails
```

**Injection-ready version:**

*Capture before state:*

```javascript
(function captureBefore(){
    window.__domSnapshot = {
        notificationCount: document.querySelectorAll('.notification').length,
        visibleText: document.querySelector('.status')?.textContent?.trim() || '',
        capturedAt: Date.now()
    };
    return window.__domSnapshot;
})
```

*After agent clicks/changes the page, compare:*

```javascript
(function captureAndDiff(){
    const after = {
        notificationCount: document.querySelectorAll('.notification').length,
        visibleText: document.querySelector('.status')?.textContent?.trim() || '',
        capturedAt: Date.now()
    };
    const before = window.__domSnapshot || {};
    return {
        before: before,
        after: after,
        diff: {
            notificationDelta: after.notificationCount - (before.notificationCount || 0),
            textChanged: before.visibleText !== after.visibleText
        }
    };
})
```

---

### Example 5: Polling Until a Condition Is Met

**Scenario:** Wait for a loading spinner to disappear, then extract data.

**Standard JS (naive polling - will timeout):**

```javascript
async function waitAndExtract() {
    while (document.querySelector('.spinner')) {
        await new Promise(r => setTimeout(r, 500));
    }
    return document.querySelector('.result').textContent;
}
waitAndExtract().then(console.log);
```

**Injection-ready version — leveraging the agent's polling loop:**

*Inject state + checker (once):*

```javascript
(function injectSpinnerWatcher(){
    window.__waitState = { done: false, result: null };

    window.__checkSpinnerAndExtract = function() {
        if (document.querySelector('.spinner')) {
            return { done: false, reason: 'Spinner still present' };
        }
        const resultEl = document.querySelector('.result');
        if (!resultEl) {
            return { done: false, reason: 'No result element yet' };
        }
        window.__waitState.done = true;
        window.__waitState.result = resultEl.textContent.trim();
        return { done: true, result: window.__waitState.result };
    };

    return 'Spinner watcher injected';
})
```

*Agent polls in a loop using repeated evaluate_script calls:*

```javascript
// This is what the agent calls every 500ms:
(function checkReady(){
    return window.__checkSpinnerAndExtract();
})
// Returns {done: false, reason: 'Spinner still present'} until ready
// Then returns {done: true, result: 'Extracted text content'}
```

---

## 6. Common Pitfalls & Their Fixes

| Pitfall | Why It Happens | Fix |
| --- | --- | --- |
| **`variable is not defined` on second call** | Variables declared inside one IIFE are not visible to the next | Attach to `window.__variableName` |
| **`await is only valid in async functions`** | Top-level IIFE is not async | Wrap async code in a `window.__asyncFn` and call it from a sync IIFE that returns a value |
| **Return value is `undefined`** | Forgot to `return` in the IIFE, or returned a DOM element | Always return plain objects/primitives; add an explicit `return` statement |
| **MCP timeout on long operations** | Script runs too long inside `evaluate_script` | Use the separation pattern: kick off a background Promise, poll with thin wrappers |
| **`JSON.stringify` circular reference error** | Trying to return objects that reference DOM nodes | Extract only serializable properties into plain objects |
| **IIFE syntax error** | Extra `{}` or `;` after the closing `)` | Follow the exact format: `(function name(){ ... })` — nothing after `)` |
| **Functions lost after page navigation** | `window` is cleared on navigation/reload | Re-inject globals after any navigation or page reload |
| **React/Angular inputs don't update** | Setting `.value` directly doesn't trigger framework bindings | Use the native setter + dispatch `input` event (see Example 2) |

---

## 7. Quick Reference: Injection Checklist

Before writing any `evaluate_script` call, verify:

- [ ] Code is wrapped in `(function descriptiveName(){ ... })` — no trailing `{}` or `;`
- [ ] Values that need to persist across calls are on `window.__something`
- [ ] Return values are plain objects, arrays, or primitives (no DOM nodes)
- [ ] Long-running work uses the separation pattern (start/poll/retrieve)
- [ ] IIFE has an explicit `return` statement for the data you want back
- [ ] `window.__` prefix used for all global state to avoid page collisions
- [ ] After page navigation, globals are re-injected

---
