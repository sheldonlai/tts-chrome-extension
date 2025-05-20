// background.js

let ttsPopoutWindowId = null;
const PERSISTED_SESSION_KEY = 'persistedTTSSession';

// In-memory session state
let currentTTSSession = {
    chunks: [],
    articleDetails: {},
    currentIndex: 0,
    isActive: false, // Is there an active set of chunks being processed?
    isPlayingInPopup: false, // Is audio currently supposed to be playing in the popup?
    prefetchedAudioDataUrlForNext: null,
    isCurrentlyPrefetching: false
};

// --- Session Persistence Functions ---
async function saveCurrentSession() {
    if (currentTTSSession.isActive || currentTTSSession.chunks.length > 0) { // Only save if there's something meaningful
        console.log("[Service Worker] Saving current TTS session to storage. Index:", currentTTSSession.currentIndex);
        try {
            await chrome.storage.local.set({ [PERSISTED_SESSION_KEY]: currentTTSSession });
        } catch (e) {
            console.error("[Service Worker] Error saving session to storage:", e);
        }
    } else {
        // If session is not active and no chunks, ensure it's cleared from storage
        await clearPersistedSession();
    }
}

async function loadPersistedSession() {
    try {
        const result = await chrome.storage.local.get([PERSISTED_SESSION_KEY]);
        if (result[PERSISTED_SESSION_KEY] && result[PERSISTED_SESSION_KEY].chunks && result[PERSISTED_SESSION_KEY].chunks.length > 0) {
            currentTTSSession = result[PERSISTED_SESSION_KEY];
            // When loaded, assume it's paused until user interacts or popup requests resume
            currentTTSSession.isPlayingInPopup = false;
            currentTTSSession.isCurrentlyPrefetching = false; // Reset prefetch flag
            currentTTSSession.prefetchedAudioDataUrlForNext = null;
            console.log("[Service Worker] Loaded persisted TTS session from storage. Index:", currentTTSSession.currentIndex, "Chunks:", currentTTSSession.chunks.length);
        } else {
            console.log("[Service Worker] No active session found in storage to load.");
            resetTTSSession(false); // Reset in-memory without clearing storage if it's already empty
        }
    } catch (e) {
        console.error("[Service Worker] Error loading session from storage:", e);
        resetTTSSession(false);
    }
}

async function clearPersistedSession() {
    console.log("[Service Worker] Clearing persisted TTS session from storage.");
    try {
        await chrome.storage.local.remove([PERSISTED_SESSION_KEY]);
    } catch (e) {
        console.error("[Service Worker] Error clearing session from storage:", e);
    }
}

// Call loadPersistedSession when the service worker starts
loadPersistedSession();


function setupContextMenu() {
    chrome.contextMenus.remove("processTextForTTS_ContextMenu", () => {
        if (chrome.runtime.lastError) { /* मौन */ }
        chrome.contextMenus.create({
            id: "processTextForTTS_ContextMenu",
            title: "Read selected text aloud (Popout)",
            contexts: ["selection"]
        });
        console.log("[Service Worker] Context menu created/updated.");
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    console.log("[Service Worker] onInstalled event. Reason:", details.reason);
    setupContextMenu();
    chrome.storage.local.get(['ttsHistory'], (result) => { // For audio playback history
        if (!result.ttsHistory) {
            chrome.storage.local.set({ ttsHistory: [] });
        }
    });
    if (details.reason === "install" || details.reason === "update") {
        clearPersistedSession(); // Clear old session on install/update
    }
});

function blobToDataURL(blob) { /* ... remains the same ... */
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (errorEvent) => {
            console.error("[Service Worker] FileReader error:", reader.error);
            reject(reader.error);
        };
        reader.onabort = () => {
            console.warn("[Service Worker] FileReader aborted.");
            reject(new DOMException("Aborted", "AbortError"));
        };
        reader.readAsDataURL(blob);
    });
}

async function openOrFocusTTSPopout() {
    const popoutUrl = chrome.runtime.getURL("popup.html");
    if (ttsPopoutWindowId !== null) {
        try {
            const existingWindow = await chrome.windows.get(ttsPopoutWindowId);
            if (existingWindow) {
                await chrome.windows.update(ttsPopoutWindowId, { focused: true });
                console.log("[Service Worker] Focused existing TTS popout window:", ttsPopoutWindowId);
                return ttsPopoutWindowId;
            } else {
                ttsPopoutWindowId = null;
            }
        } catch (e) {
            ttsPopoutWindowId = null;
        }
    }
    try {
        const newWindow = await chrome.windows.create({
            url: popoutUrl, type: "popup", width: 400, height: 550, focused: true // Make popout focused by default
        });
        ttsPopoutWindowId = newWindow.id;
        console.log("[Service Worker] New TTS popout window created. ID:", ttsPopoutWindowId);
        chrome.windows.onRemoved.addListener(function specificWindowRemovedListener(removedWindowId) {
            if (removedWindowId === ttsPopoutWindowId) {
                console.log("[Service Worker] TTS popout window (ID:", ttsPopoutWindowId, ") was closed.");
                ttsPopoutWindowId = null;
                if (currentTTSSession.isActive) {
                    currentTTSSession.isPlayingInPopup = false; // Mark as not actively playing in a popup
                    saveCurrentSession(); // Save the paused state
                    console.log("[Service Worker] TTS session marked as paused due to popout close.");
                }
            }
        });
        return ttsPopoutWindowId;
    } catch (winError) {
        console.error("[Service Worker] Error creating TTS popout window:", winError);
        ttsPopoutWindowId = null;
        throw winError;
    }
}

function resetTTSSession(clearStorage = true) {
    console.log("[Service Worker] Resetting TTS session queue. Clear storage:", clearStorage);
    currentTTSSession.chunks = [];
    currentTTSSession.articleDetails = {};
    currentTTSSession.currentIndex = 0;
    currentTTSSession.isActive = false;
    currentTTSSession.isPlayingInPopup = false;
    currentTTSSession.prefetchedAudioDataUrlForNext = null;
    currentTTSSession.isCurrentlyPrefetching = false;
    if (clearStorage) {
        clearPersistedSession();
    }
}

async function processAndSendChunkToPopup(chunkIndex) {
    if (!currentTTSSession.isActive || chunkIndex >= currentTTSSession.chunks.length) {
        console.log("[Service Worker] Session not active or chunk index out of bounds.", chunkIndex, currentTTSSession.chunks.length);
        if (chunkIndex >= currentTTSSession.chunks.length && currentTTSSession.isActive) {
            console.log("[Service Worker] All chunks processed for current session.");
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" });
        }
        resetTTSSession(); // This will clear storage by default
        return;
    }

    const chunkText = currentTTSSession.chunks[chunkIndex];
    const isLastChunk = chunkIndex === currentTTSSession.chunks.length - 1;
    currentTTSSession.currentIndex = chunkIndex; // Update current index
    currentTTSSession.isPlayingInPopup = true; // Assume it will start playing
    saveCurrentSession(); // Save updated index and playing state

    console.log(`[Service Worker] Processing chunk ${chunkIndex + 1}/${currentTTSSession.chunks.length} for popup: "${chunkText.substring(0, 50)}..."`);

    const articleDetailsForChunk = { /* ... same as before ... */
        title: currentTTSSession.articleDetails.title || "Reading Page Content",
        textContent: chunkText,
        isChunk: true,
        currentChunkIndex: chunkIndex,
        totalChunks: currentTTSSession.chunks.length,
        isLastChunk: isLastChunk,
        simplifiedHtml: currentTTSSession.articleDetails.simplifiedHtml,
        excerpt: currentTTSSession.articleDetails.excerpt,
        length: currentTTSSession.articleDetails.length
    };

    chrome.runtime.sendMessage({
        action: "processTextForTTS",
        selectedText: chunkText,
        articleDetails: articleDetailsForChunk
    }, response => { /* ... error handling ... */
        if (chrome.runtime.lastError) {
            console.warn(`[Service Worker] Error sending 'processTextForTTS' for chunk ${chunkIndex} to popout:`, chrome.runtime.lastError.message);
            currentTTSSession.isPlayingInPopup = false; // Failed to send
            saveCurrentSession();
        } else {
            console.log(`[Service Worker] 'processTextForTTS' for chunk ${chunkIndex} sent to popout. Popup response:`, response);
        }
    });
}

async function attemptToPrefetchNextChunk() { /* ... remains largely the same, ensure it uses currentTTSSession.currentIndex ... */
    if (!currentTTSSession.isActive || currentTTSSession.isCurrentlyPrefetching) {
        return;
    }
    const nextChunkToPrefetchIndex = currentTTSSession.currentIndex + 1; // Based on the chunk *currently being processed*

    if (nextChunkToPrefetchIndex < currentTTSSession.chunks.length) {
        console.log(`[Service Worker] Attempting to prefetch chunk ${nextChunkToPrefetchIndex + 1}`);
        currentTTSSession.isCurrentlyPrefetching = true;
        currentTTSSession.prefetchedAudioDataUrlForNext = null;

        const textToPrefetch = currentTTSSession.chunks[nextChunkToPrefetchIndex];
        try {
            const ttsUrl = 'http://localhost:8080/synthesize';
            const fetchResponse = await fetch(ttsUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textToPrefetch })
            });
            if (fetchResponse.ok) {
                const audioBlob = await fetchResponse.blob();
                if (audioBlob && audioBlob.size > 0) {
                    currentTTSSession.prefetchedAudioDataUrlForNext = await blobToDataURL(audioBlob);
                    console.log(`[Service Worker] Successfully prefetched audio for chunk ${nextChunkToPrefetchIndex + 1}.`);
                } else {
                    console.warn(`[Service Worker] Prefetch failed: Blob for chunk ${nextChunkToPrefetchIndex + 1} is invalid or empty.`);
                }
            } else {
                console.warn(`[Service Worker] Prefetch TTS server error for chunk ${nextChunkToPrefetchIndex + 1}: ${fetchResponse.status}`);
            }
        } catch (error) {
            console.error(`[Service Worker] Error during prefetch for chunk ${nextChunkToPrefetchIndex + 1}:`, error);
        } finally {
            currentTTSSession.isCurrentlyPrefetching = false;
            // Note: We don't save the session here just for prefetch, 
            // as prefetchedAudioDataUrlForNext is transient.
        }
    } else {
        currentTTSSession.prefetchedAudioDataUrlForNext = null;
    }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "processTextForTTS_ContextMenu" && info.selectionText) {
        console.log("[Service Worker] Context menu: 'Read selected text'.");
        resetTTSSession(); // Clears old session from memory and storage
        currentTTSSession.chunks = [info.selectionText];
        currentTTSSession.articleDetails = { /* ... basic details ... */
            title: "Selected Text",
            textContent: info.selectionText,
            simplifiedHtml: `<p>${info.selectionText.replace(/\n/g, '</p><p>')}</p>`,
            excerpt: info.selectionText.substring(0, 150) + (info.selectionText.length > 150 ? "..." : ""),
            length: info.selectionText.length
        };
        currentTTSSession.currentIndex = 0;
        currentTTSSession.isActive = true;
        // isPlayingInPopup will be set by processAndSendChunkToPopup
        try {
            await openOrFocusTTSPopout();
            if (ttsPopoutWindowId) {
                await new Promise(resolve => setTimeout(resolve, 700));
                processAndSendChunkToPopup(currentTTSSession.currentIndex);
            } else { resetTTSSession(); }
        } catch (error) { console.error("[SW] Error opening popout from context menu:", error); resetTTSSession(); }
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("[Service Worker] Message received. Action:", request.action);

    if (request.action === "openTTSWindow") { /* ... remains the same ... */
        (async () => {
            try {
                await openOrFocusTTSPopout();
                sendResponse({ status: "ttsWindowOpened" });
            } catch (error) { sendResponse({ status: "errorOpeningTTSWindow", error: error.message }); }
        })();
        return true;
    }

    if (request.action === "getSimplifiedContentForTTS") { /* ... */
        (async () => {
            resetTTSSession(); // Clear old session from memory and storage
            try {
                const lastFocusedNormalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
                if (!lastFocusedNormalWindow) {
                    sendResponse({ success: false, error: "No suitable browser window found." }); return;
                }
                const [activeTab] = await chrome.tabs.query({ active: true, windowId: lastFocusedNormalWindow.id });
                if (activeTab && activeTab.id) {
                    if (activeTab.url && (activeTab.url.startsWith("chrome://") || activeTab.url.startsWith("https://chrome.google.com/webstore"))) {
                        sendResponse({ success: false, error: "Cannot extract content from restricted pages." }); return;
                    }
                    const responseFromContent = await chrome.tabs.sendMessage(activeTab.id, { action: "extractReadablePageContent" });
                    if (responseFromContent && responseFromContent.success && responseFromContent.data && responseFromContent.data.textContentChunks) {
                        currentTTSSession.chunks = responseFromContent.data.textContentChunks;
                        currentTTSSession.articleDetails = responseFromContent.data;
                        currentTTSSession.currentIndex = 0;
                        currentTTSSession.isActive = true;
                        // isPlayingInPopup will be set by processAndSendChunkToPopup
                        await openOrFocusTTSPopout();
                        if (ttsPopoutWindowId) {
                            await new Promise(resolve => setTimeout(resolve, 700));
                            processAndSendChunkToPopup(currentTTSSession.currentIndex);
                            sendResponse({ success: true, message: "Chunked content processing initiated." });
                        } else { resetTTSSession(); sendResponse({ success: false, error: "Could not open TTS popout." }); }
                    } else { sendResponse({ success: false, error: responseFromContent.error || "No valid chunked data." }); }
                } else { sendResponse({ success: false, error: "No active tab found." }); }
            } catch (error) { console.error("[SW] Error in 'getSimplifiedContentForTTS':", error); sendResponse({ success: false, error: error.message }); }
        })();
        return true;
    }

    if (request.action === "fetchTTSFromServer" && request.textToSynthesize) { /* ... */
        const textToSynth = request.textToSynthesize;
        const requestedChunkIndex = currentTTSSession.chunks.indexOf(textToSynth);
        console.log(`[Service Worker] 'fetchTTSFromServer' for text (chunk index ${requestedChunkIndex}): "${textToSynth.substring(0, 50)}..."`);

        (async () => {
            try {
                const ttsUrl = 'http://localhost:8080/synthesize';
                const fetchResponse = await fetch(ttsUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: textToSynth })
                });
                if (!fetchResponse.ok) { /* ... error handling ... */
                    const errorText = await fetchResponse.text();
                    const errorMessage = `TTS server error: ${fetchResponse.status} - ${errorText || fetchResponse.statusText}`;
                    chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: errorMessage });
                    sendResponse({ success: false, error: errorMessage }); return;
                }
                const audioBlob = await fetchResponse.blob();
                if (!(audioBlob && audioBlob.size > 0)) { /* ... error handling ... */
                    const blobError = "Fetched audioBlob is not valid or is empty.";
                    chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: blobError });
                    sendResponse({ success: false, error: blobError }); return;
                }
                const audioDataUrl = await blobToDataURL(audioBlob);
                console.log("[Service Worker] Sending audio to popup for playback.");

                const isLastChunkForThisAudio = currentTTSSession.isActive ? (requestedChunkIndex === currentTTSSession.chunks.length - 1) : true;
                const articleDetailsForThisChunk = {
                    title: currentTTSSession.articleDetails.title || "Reading Page Content",
                    isChunk: true,
                    currentChunkIndex: requestedChunkIndex,
                    totalChunks: currentTTSSession.chunks.length,
                    isLastChunk: isLastChunkForThisAudio // This is crucial for popup.js
                };

                chrome.runtime.sendMessage({
                    action: "playAudioDataUrl",
                    audioDataUrl: audioDataUrl,
                    originalText: textToSynth,
                    articleDetails: articleDetailsForThisChunk
                });
                sendResponse({ success: true, message: "DataURL sent for playback." });

                if (currentTTSSession.isActive && requestedChunkIndex !== -1 && requestedChunkIndex === currentTTSSession.currentIndex) {
                    attemptToPrefetchNextChunk();
                }

            } catch (error) { /* ... error handling ... */
                console.error("[SW] Error during 'fetchTTSFromServer':", error);
                chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: `Server fetch error: ${error.message}` });
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    if (request.action === "requestNextAudioChunk") { /* ... */
        console.log("[Service Worker] Received 'requestNextAudioChunk' from popup.");
        if (currentTTSSession.isActive) {
            const nextIndex = currentTTSSession.currentIndex + 1; // Calculate next potential index
            if (nextIndex < currentTTSSession.chunks.length) {
                currentTTSSession.currentIndex = nextIndex; // Update current index *before* processing
                currentTTSSession.isPlayingInPopup = true; // Assume it will play
                // saveCurrentSession(); // Save before potential async operations

                if (currentTTSSession.prefetchedAudioDataUrlForNext) {
                    console.log(`[Service Worker] Using prefetched audio for chunk ${currentTTSSession.currentIndex + 1}`);
                    const textOfPrefetchedChunk = currentTTSSession.chunks[currentTTSSession.currentIndex];
                    const isLastChunkForPrefetched = currentTTSSession.currentIndex === currentTTSSession.chunks.length - 1;
                    const articleDetailsForPrefetchedChunk = { /* ... construct details ... */
                        title: currentTTSSession.articleDetails.title || "Reading Page Content",
                        isChunk: true,
                        currentChunkIndex: currentTTSSession.currentIndex,
                        totalChunks: currentTTSSession.chunks.length,
                        isLastChunk: isLastChunkForPrefetched
                    };
                    chrome.runtime.sendMessage({
                        action: "playAudioDataUrl",
                        audioDataUrl: currentTTSSession.prefetchedAudioDataUrlForNext,
                        originalText: textOfPrefetchedChunk,
                        articleDetails: articleDetailsForPrefetchedChunk
                    });
                    currentTTSSession.prefetchedAudioDataUrlForNext = null;
                    sendResponse({ status: "sentPrefetchedAudio", nextIndex: currentTTSSession.currentIndex });
                    attemptToPrefetchNextChunk();
                } else {
                    console.log(`[Service Worker] No prefetched audio for chunk ${currentTTSSession.currentIndex + 1}. Telling popup to request it.`);
                    processAndSendChunkToPopup(currentTTSSession.currentIndex); // This will save session
                    sendResponse({ status: "processingNextChunk", nextIndex: currentTTSSession.currentIndex });
                }
            } else { // No more chunks
                console.log("[Service Worker] All chunks finished after requestNextAudioChunk.");
                if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" });
                resetTTSSession();
                sendResponse({ status: "allChunksFinished" });
            }
        } else {
            console.log("[Service Worker] No active TTS session for 'requestNextAudioChunk'.");
            sendResponse({ status: "noActiveSession" });
        }
        return true;
    }

    // NEW: Handler for popup requesting initial state
    if (request.action === "requestInitialSessionState") {
        console.log("[Service Worker] Popup requested initial session state.");
        // Respond with a copy of the current session, ensuring sensitive/transient parts are handled
        const sessionDataForPopup = {
            isActive: currentTTSSession.isActive,
            currentIndex: currentTTSSession.currentIndex,
            totalChunks: currentTTSSession.chunks.length,
            // Only send articleDetails if session is active, and maybe only title/excerpt
            articleDetails: currentTTSSession.isActive ? {
                title: currentTTSSession.articleDetails.title,
                isChunk: currentTTSSession.chunks.length > 1, // Simplified isChunk logic
                currentChunkIndex: currentTTSSession.currentIndex,
                totalChunks: currentTTSSession.chunks.length,
                // isPlayingInPopup is more of an internal background state, popup can infer
            } : null
        };
        sendResponse({ action: "activeSessionState", sessionData: sessionDataForPopup });
        return false; // Synchronous response
    }

    // NEW: Handler for popup resuming a session
    if (request.action === "resumeTTSSession" && typeof request.resumeFromChunkIndex === 'number') {
        console.log("[Service Worker] Popup requested to resume session from chunk index:", request.resumeFromChunkIndex);
        if (currentTTSSession.chunks.length > 0 && request.resumeFromChunkIndex < currentTTSSession.chunks.length) {
            currentTTSSession.isActive = true;
            currentTTSSession.isPlayingInPopup = true; // Assume it will start playing
            currentTTSSession.currentIndex = request.resumeFromChunkIndex;
            // No need to save session here, processAndSendChunkToPopup will do it

            (async () => {
                await openOrFocusTTSPopout(); // Ensure popup is open and focused
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 300)); // Short delay
                    processAndSendChunkToPopup(currentTTSSession.currentIndex);
                    sendResponse({ success: true, message: "Resuming session." });
                } else {
                    console.error("[Service Worker] Cannot resume, TTS popout window not available.");
                    resetTTSSession();
                    sendResponse({ success: false, error: "TTS window not available to resume." });
                }
            })();
        } else {
            console.warn("[Service Worker] Cannot resume: No valid session or invalid chunk index.");
            resetTTSSession(); // Clear potentially inconsistent state
            sendResponse({ success: false, error: "No valid session to resume or invalid index." });
        }
        return true; // Asynchronous
    }

    return false;
});

console.log("[Service Worker] Event listeners registered.");
