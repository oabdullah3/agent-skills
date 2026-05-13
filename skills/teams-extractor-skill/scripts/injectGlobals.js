(function injectGlobals(){
    window.extractTeamsChat = async function(rangeMode) {
        console.log(`[TeamsExtractor] Starting autonomous extraction for mode: "${rangeMode}"`);

        let START_DATE, END_DATE;
        let needsScroll = true;
        const now = new Date();

        if (rangeMode === 'currentlyLoaded') {
            needsScroll = false;
            START_DATE = new Date(0); 
            END_DATE = new Date(8640000000000000); 
        } else if (rangeMode === 'last24hours') {
            END_DATE = now;
            START_DATE = new Date(now.getTime() - (24 * 60 * 60 * 1000));
        } else if (rangeMode === 'last7days') {
            END_DATE = now;
            START_DATE = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
        } else if (rangeMode === 'last30days') {
            END_DATE = now;
            START_DATE = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
        } else if (rangeMode === 'last3months') {
            END_DATE = now;
            const d = new Date(now);
            d.setMonth(d.getMonth() - 3);
            START_DATE = d;
        } else if (rangeMode === 'allMessages') {
            END_DATE = now;
            START_DATE = new Date(0); 
        } else if (rangeMode.includes(' to ')) {
            const parts = rangeMode.split(' to ');
            START_DATE = new Date(parts[0].trim() + 'T00:00:00');
            END_DATE = new Date(parts[1].trim() + 'T23:59:59.999');
        } else {
            console.log(`[TeamsExtractor] ❌ Invalid parameter format.`);
            return [];
        }

        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const SELECTORS = {
            chatList: ['[data-tid="message-pane-list-runway"]', '[class^="fui-Chat ___"]', '#chat-pane-list'],
            messageBody: ['[data-tid="chat-pane-message"]', '[class^="fui-ChatMessage__body"]', '[id^="message-body-"]'],
            timestamp: ['[class^="fui-ChatMessage__timestamp ___"]', '[id^="timestamp-"]', 'time[datetime]', '[data-tid="message-timestamp"]'],
            content: ['[data-message-content]', '[id^="message-body-"] [id^="content-"]'],
            author: ['[id^="author-"]', '[data-tid="message-author-name"]'],
            animatedGif: ['[aria-label*="GIF"]', '[aria-label*="GIF Image"]'],
            mentionBlock: ['*:has(> span[itemtype="http://schema.skype.com/Mention"])', 'div[aria-label^="Mentioned"]', 'span[itemtype="http://schema.skype.com/Mention"]'],
            quotedReply: ['div[data-track-action-scenario="messageQuotedReplyDeeplink"]', '*:has(>div[data-tid="quoted-reply-card"])', 'div[data-track-module-name="messageQuotedReply"]']
        };

        function queryOne(node, key) {
            for (let sel of SELECTORS[key]) {
                try {
                    let match = node.querySelector(sel);
                    if (match) return match;
                } catch (e) {}
            }
            return null;
        }

        // Helper to fetch arrays of elements (like multiple mentions) ---
        function queryAll(node, key) {
            for (let sel of SELECTORS[key]) {
                try {
                    let matches = node.querySelectorAll(sel);
                    if (matches.length > 0) return Array.from(matches);
                } catch (e) {}
            }
            return [];
        }

        const list = queryOne(document, 'chatList');
        if (!list) {
            console.log('[TeamsExtractor] ❌ Extraction failed: Chat list container not found.');
            return [];
        }

        function findScrollContainer(el) {
            let current = el;
            while (current && current !== document.documentElement) {
                const style = getComputedStyle(current);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return current;
                current = current.parentElement;
            }
            return el;
        }

        const scrollContainer = findScrollContainer(list);
        let collected = [];
        let seenIds = new Set();
        let currentDomDate = null; 

        function resolveTimestamp(node) {
            const timeEl = queryOne(node, 'timestamp');
            if (!timeEl) return null;
            const ts = timeEl.getAttribute('datetime') || timeEl.getAttribute('data-timestamp') || timeEl.getAttribute('title') || '';
            const parsed = new Date(ts);
            return Number.isNaN(parsed.getTime()) ? null : { value: ts, date: parsed };
        }

        function getMessageUniqueId(node) {
            const msgBody = queryOne(node, 'messageBody');
            const mId = msgBody ? (msgBody.id ? msgBody.id.replace('message-body-', '') : (msgBody.getAttribute('data-message-id') || '')) : '';
            if (mId) return mId;
            const ts = resolveTimestamp(node);
            const content = queryOne(node, 'content');
            const text = content ? content.innerText.substring(0, 30) : '';
            return ts ? `${ts.value}|${text}` : `UNKNOWN|${text}`;
        }

        function getCurrentBounds() {
            let oldest = null, newest = null;
            Array.from(list.children).forEach(node => {
                const ts = resolveTimestamp(node);
                if (ts && ts.date) {
                    if (!oldest || ts.date < oldest) oldest = ts.date;
                    if (!newest || ts.date > newest) newest = ts.date;
                }
            });
            return { oldest, newest };
        }

        const collect = async function () {
            for (let poll = 0; poll < 4; poll++) {
                let pending = Array.from(list.querySelectorAll('img')).some(img => {
                    let isNoise = img.className.includes('avatar') || (img.alt && img.alt.includes('Profile')) || img.closest('.fui-Card, [data-tid*="card"]') || img.hasAttribute('itemtype');
                    return !isNoise && (!img.complete || img.naturalWidth <= 1);
                });
                if (!pending) break;
                await sleep(100);
            }

            Array.from(list.children).forEach(n => {
                if (!queryOne(n, 'messageBody') && !queryOne(n, 'content')) return;
                const id = getMessageUniqueId(n);
                const resolved = resolveTimestamp(n);
                if (resolved && resolved.date) currentDomDate = resolved.date;

                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    const effectiveDate = resolved ? resolved.date : currentDomDate;
                    
                    if (!effectiveDate) return; 
                    if (effectiveDate < START_DATE || effectiveDate > END_DATE) return;
                    
                    collected.push(n.cloneNode(true));
                }
            });
        };

        async function seekAndCollect(direction, targetDate, isCollectMode) {
            let noChangeCount = 0;
            let domStallCount = 0;
            let prevBoundaryTime = null;

            for (let i = 0; i < 500; i++) {
                if (isCollectMode) await collect();
                
                const before = scrollContainer.scrollTop;
                if (direction === 'up') scrollContainer.scrollTop -= scrollContainer.clientHeight * 1;
                else scrollContainer.scrollTop += scrollContainer.clientHeight * 1;
                
                await sleep(400);
                
                const after = scrollContainer.scrollTop;
                if (Math.abs(after - before) <= 2) {
                    noChangeCount++;
                    if (noChangeCount >= 4) break; 
                } else {
                    noChangeCount = 0;
                }
                
                const b = getCurrentBounds();
                const currentBoundaryTime = direction === 'up' ? (b.oldest ? b.oldest.getTime() : null) : (b.newest ? b.newest.getTime() : null);
                
                if (currentBoundaryTime && currentBoundaryTime === prevBoundaryTime) {
                    domStallCount++;
                    if (domStallCount >= 5) {
                        if (isCollectMode) await collect();
                        break;
                    }
                } else {
                    domStallCount = 0;
                }
                prevBoundaryTime = currentBoundaryTime;

                if (direction === 'up' && b.oldest && b.oldest.getTime() <= targetDate.getTime()) {
                    if (isCollectMode) await collect();
                    break;
                }
                if (direction === 'down' && b.newest && b.newest.getTime() >= targetDate.getTime()) {
                    if (isCollectMode) await collect();
                    break;
                }
            }
        }

        if (needsScroll) {
            const b = getCurrentBounds();
            const bOld = b.oldest ? b.oldest.getTime() : 0;
            const bNew = b.newest ? b.newest.getTime() : Date.now();
            const tStart = START_DATE.getTime();
            const tEnd = END_DATE.getTime();

            const bNewEndOfDay = b.newest ? new Date(b.newest).setHours(23, 59, 59, 999) : bNew;

            const initOldStr = b.oldest ? b.oldest.toLocaleString() : 'Unknown';
            const initNewStr = b.newest ? b.newest.toLocaleString() : 'Unknown';
            console.log(`[TeamsExtractor] Initial DOM view contains messages from [${initOldStr}] to [${initNewStr}]`);

            if (tStart >= bOld && tEnd <= bNewEndOfDay) {
                console.log('[TeamsExtractor] Scenario 0: Perfect Fit -> Collecting');
                await collect();
            } else if (tEnd >= bOld && tEnd <= bNewEndOfDay && tStart < bOld) {
                console.log('[TeamsExtractor] Scenario 1: End inside, Start older -> Collecting UP');
                await seekAndCollect('up', START_DATE, true);
            } else if (tEnd < bOld) {
                console.log('[TeamsExtractor] Scenario 2: Both older -> Seeking UP to End, Collecting UP to Start');
                await seekAndCollect('up', END_DATE, false);
                collected = []; seenIds.clear(); currentDomDate = null; 
                await seekAndCollect('up', START_DATE, true);
            } else if (tStart >= bOld && tStart <= bNewEndOfDay && tEnd > bNewEndOfDay) {
                console.log('[TeamsExtractor] Scenario 3: Start inside, End younger -> Collecting DOWN');
                await seekAndCollect('down', END_DATE, true);
            } else if (tStart > bNewEndOfDay) {
                console.log('[TeamsExtractor] Scenario 4: Both younger -> Seeking DOWN to Start, Collecting DOWN to End');
                await seekAndCollect('down', START_DATE, false);
                collected = []; seenIds.clear(); currentDomDate = null; 
                await seekAndCollect('down', END_DATE, true);
            } else {
                console.log('[TeamsExtractor] Scenario 5: DOM in middle');
                if (Math.abs(bNewEndOfDay - tEnd) < Math.abs(bOld - tStart)) {
                    await seekAndCollect('down', END_DATE, false);
                    collected = []; seenIds.clear(); currentDomDate = null; 
                    await seekAndCollect('up', START_DATE, true);
                } else {
                    await seekAndCollect('up', START_DATE, false);
                    collected = []; seenIds.clear(); currentDomDate = null; 
                    await seekAndCollect('down', END_DATE, true);
                }
            }
        } else {
            console.log('[TeamsExtractor] Mode: currentlyLoaded -> Collecting visible messages only');
            await collect();
        }

        const results = [];
        let finalDomDate = null; 
        
        collected.forEach(n => {
            const msg = queryOne(n, 'messageBody');
            if (msg && !queryOne(n, 'animatedGif')) {
                const authorEl = queryOne(n, 'author');
                const contentEl = queryOne(n, 'content');
                
                const resolved = resolveTimestamp(n);
                if (resolved && resolved.date) finalDomDate = resolved.date; 
                const effectiveDate = resolved ? resolved.date : finalDomDate;
                
                // 1. Mentions
                const mentionNodes = queryAll(n, 'mentionBlock');
                const mentions = mentionNodes.map(m => m.innerText.trim());

                // 2. Replies
                const replyNode = queryOne(n, 'quotedReply');
                const isReply = !!replyNode;
                let replyTo = null;
                if (isReply) {
                    // Flatten the quoted text to a single line for clean JSON formatting
                    replyTo = replyNode.innerText.trim().replace(/\n+/g, ' | '); 
                }

                // 3. Images (Filtering out avatars, UI icons, and emojis)
                const imageNodes = Array.from(n.querySelectorAll('img')).filter(img => {
                    const isNoise = img.className.includes('avatar') || 
                                    (img.alt && img.alt.includes('Profile')) || 
                                    img.hasAttribute('itemtype'); 
                    return !isNoise;
                });
                const hasImages = imageNodes.length > 0;

                // 4. Videos (Native video tags or Teams video players)
                const videoNodes = n.querySelectorAll('video, iframe, [data-tid="video-player"]');
                const hasVideos = videoNodes.length > 0;

                results.push({
                    id: getMessageUniqueId(n),
                    date: effectiveDate, 
                    timestamp: resolved ? resolved.value : null,
                    author: authorEl ? authorEl.innerText.trim() : 'Unknown',
                    content: contentEl ? contentEl.innerText.trim() : '',
                    // Appending new metadata
                    metadata: {
                        hasMentions: mentions.length > 0,
                        mentions: mentions,
                        isReply: isReply,
                        replyTo: replyTo,
                        hasImages: hasImages,
                        hasVideos: hasVideos,
                        hasGif: !!queryOne(n, 'animatedGif')
                    }
                });
            }
        });

        results.sort((a, b) => (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0));

        if (results.length > 0) {
            const actualStart = results[0].date ? results[0].date.toLocaleString() : 'Unknown';
            const actualEnd = results[results.length - 1].date ? results[results.length - 1].date.toLocaleString() : 'Unknown';
            console.log(`[TeamsExtractor] 🎉 Extraction successful! Extracted ${results.length} messages ranging from [${actualStart}] to [${actualEnd}].`);
            
            // Dump the fully hydrated array directly into the console ---
            console.log(results);
        } else {
            console.log(`[TeamsExtractor] ⚠️ Extraction finished, but 0 messages were found in the target date range.`);
        }

        return results;
    };

    window.__extractState = { status: 'idle', startedAt: null, finishedAt: null, count: 0, error: null };
    window.__extractResult = null;

    window.__extractStart = (rangeMode) => {
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
            return res;
        })
        .catch(err => {
            window.__extractState.status = 'error';
            window.__extractState.error = String(err);
        });

        return window.__extractState;
    };

    window.__extractStatus = () => window.__extractState;
})