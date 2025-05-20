// background.js

let ttsPopoutWindowId = null;
const PERSISTED_SESSION_KEY = 'persistedTTSSession';

// In-memory session state
let currentTTSSession = {
    chunks: [],
    articleDetails: {},
    currentIndex: 0,
    isActive: false,
    isPlayingInPopup: false,
    prefetchedAudioDataUrlForNext: null, // For the *next* chunk (currentIndex + 1)
    isCurrentlyPrefetching: false      // To prevent multiple prefetch attempts
};

// --- Session Persistence Functions ---
async function saveCurrentSession() {
    if (currentTTSSession.isActive || currentTTSSession.chunks.length > 0) {
        console.log("[Service Worker] Saving current TTS session to storage. Index:", currentTTSSession.currentIndex);
        try {
            // Don't save prefetchedAudioDataUrlForNext as it's transient for the current browser session
            const sessionToSave = { ...currentTTSSession, prefetchedAudioDataUrlForNext: null, isCurrentlyPrefetching: false };
            await chrome.storage.local.set({ [PERSISTED_SESSION_KEY]: sessionToSave });
        } catch (e) {
            console.error("[Service Worker] Error saving session to storage:", e);
        }
    } else {
        await clearPersistedSession();
    }
}

async function loadPersistedSession() {
    try {
        const result = await chrome.storage.local.get([PERSISTED_SESSION_KEY]);
        if (result[PERSISTED_SESSION_KEY] && result[PERSISTED_SESSION_KEY].chunks && result[PERSISTED_SESSION_KEY].chunks.length > 0) {
            currentTTSSession = result[PERSISTED_SESSION_KEY];
            currentTTSSession.isPlayingInPopup = false;
            currentTTSSession.isCurrentlyPrefetching = false;
            currentTTSSession.prefetchedAudioDataUrlForNext = null; // Always reset on load
            console.log("[Service Worker] Loaded persisted TTS session from storage. Index:", currentTTSSession.currentIndex, "Chunks:", currentTTSSession.chunks.length);
        } else {
            console.log("[Service Worker] No active session found in storage to load.");
            resetTTSSession(false);
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
    chrome.storage.local.get(['ttsHistory'], (result) => {
        if (!result.ttsHistory) {
            chrome.storage.local.set({ ttsHistory: [] });
        }
    });
    if (details.reason === "install" || details.reason === "update") {
        clearPersistedSession();
    }
});

function blobToDataURL(blob) {
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
    const popoutUrl = chrome.runtime.getURL("popup/popup.html");
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
            url: popoutUrl, type: "popup", width: 400, height: 550, focused: true
        });
        ttsPopoutWindowId = newWindow.id;
        console.log("[Service Worker] New TTS popout window created. ID:", ttsPopoutWindowId);
        chrome.windows.onRemoved.addListener(function specificWindowRemovedListener(removedWindowId) {
            if (removedWindowId === ttsPopoutWindowId) {
                console.log("[Service Worker] TTS popout window (ID:", ttsPopoutWindowId, ") was closed.");
                ttsPopoutWindowId = null;
                if (currentTTSSession.isActive) {
                    currentTTSSession.isPlayingInPopup = false;
                    saveCurrentSession();
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
    currentTTSSession.prefetchedAudioDataUrlForNext = null; // Reset prefetch
    currentTTSSession.isCurrentlyPrefetching = false;    // Reset prefetch flag
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
        resetTTSSession();
        return;
    }

    const chunkText = currentTTSSession.chunks[chunkIndex];
    const isLastChunk = chunkIndex === currentTTSSession.chunks.length - 1;
    currentTTSSession.currentIndex = chunkIndex;
    currentTTSSession.isPlayingInPopup = true;
    saveCurrentSession();

    console.log(`[Service Worker] Processing chunk ${chunkIndex + 1}/${currentTTSSession.chunks.length} for popup: "${chunkText.substring(0, 50)}..."`);

    const articleDetailsForChunk = {
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
    }, response => {
        if (chrome.runtime.lastError) {
            console.warn(`[Service Worker] Error sending 'processTextForTTS' for chunk ${chunkIndex} to popout:`, chrome.runtime.lastError.message);
            currentTTSSession.isPlayingInPopup = false;
            saveCurrentSession();
        } else {
            console.log(`[Service Worker] 'processTextForTTS' for chunk ${chunkIndex} sent to popout. Popup response:`, response);
        }
    });
}

// Re-added prefetch logic
async function attemptToPrefetchNextChunk() {
    if (!currentTTSSession.isActive || currentTTSSession.isCurrentlyPrefetching) {
        return;
    }
    // Prefetch for the chunk *after* the one currently being processed/played (currentTTSSession.currentIndex)
    const nextChunkToPrefetchIndex = currentTTSSession.currentIndex + 1;

    if (nextChunkToPrefetchIndex < currentTTSSession.chunks.length) {
        console.log(`[Service Worker] Attempting to prefetch audio for chunk index ${nextChunkToPrefetchIndex} (display number ${nextChunkToPrefetchIndex + 1})`);
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
                    console.log(`[Service Worker] Successfully prefetched audio for chunk index ${nextChunkToPrefetchIndex}.`);
                } else {
                    console.warn(`[Service Worker] Prefetch failed: Blob for chunk index ${nextChunkToPrefetchIndex} is invalid or empty.`);
                }
            } else {
                console.warn(`[Service Worker] Prefetch TTS server error for chunk index ${nextChunkToPrefetchIndex}: ${fetchResponse.status}`);
            }
        } catch (error) {
            console.error(`[Service Worker] Error during prefetch for chunk index ${nextChunkToPrefetchIndex}:`, error);
        } finally {
            currentTTSSession.isCurrentlyPrefetching = false;
            // Do not save session here, prefetchedAudioDataUrlForNext is transient
        }
    } else {
        console.log("[Service Worker] No more chunks to prefetch (already at or past the last chunk).");
        currentTTSSession.prefetchedAudioDataUrlForNext = null;
    }
}


chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "processTextForTTS_ContextMenu" && info.selectionText) {
        console.log("[Service Worker] Context menu: 'Read selected text'.");
        resetTTSSession();
        currentTTSSession.chunks = [info.selectionText];
        currentTTSSession.articleDetails = {
            title: "Selected Text",
            textContent: info.selectionText,
            simplifiedHtml: `<p>${info.selectionText.replace(/\n/g, '</p><p>')}</p>`,
            excerpt: info.selectionText.substring(0, 150) + (info.selectionText.length > 150 ? "..." : ""),
            length: info.selectionText.length
        };
        currentTTSSession.currentIndex = 0;
        currentTTSSession.isActive = true;
        try {
            await openOrFocusTTSPopout();
            if (ttsPopoutWindowId) {
                await new Promise(resolve => setTimeout(resolve, 700));
                processAndSendChunkToPopup(currentTTSSession.currentIndex);
                // For a single chunk from context menu, prefetching isn't strictly necessary
                // but attemptToPrefetchNextChunk will correctly do nothing if there's no next chunk.
                attemptToPrefetchNextChunk();
            } else { resetTTSSession(); }
        } catch (error) { console.error("[SW] Error opening popout from context menu:", error); resetTTSSession(); }
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("[Service Worker] Message received. Action:", request.action);

    if (request.action === "openTTSWindow") {
        (async () => {
            try {
                await openOrFocusTTSPopout();
                sendResponse({ status: "ttsWindowOpened" });
            } catch (error) { sendResponse({ status: "errorOpeningTTSWindow", error: error.message }); }
        })();
        return true;
    }

    if (request.action === "getSimplifiedContentForTTS") {
        (async () => {
            resetTTSSession();
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
                        await openOrFocusTTSPopout();
                        if (ttsPopoutWindowId) {
                            await new Promise(resolve => setTimeout(resolve, 700));
                            processAndSendChunkToPopup(currentTTSSession.currentIndex);
                            // After sending the first chunk for processing, attempt to prefetch the next one
                            attemptToPrefetchNextChunk();
                            sendResponse({ success: true, message: "Chunked content processing initiated." });
                        } else { resetTTSSession(); sendResponse({ success: false, error: "Could not open TTS popout." }); }
                    } else { sendResponse({ success: false, error: responseFromContent.error || "No valid chunked data." }); }
                } else { sendResponse({ success: false, error: "No active tab found." }); }
            } catch (error) { console.error("[SW] Error in 'getSimplifiedContentForTTS':", error); sendResponse({ success: false, error: error.message }); }
        })();
        return true;
    }

    if (request.action === "fetchTTSFromServer" && request.textToSynthesize) {
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
                if (!fetchResponse.ok) {
                    const errorText = await fetchResponse.text();
                    const errorMessage = `TTS server error: ${fetchResponse.status} - ${errorText || fetchResponse.statusText}`;
                    chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: errorMessage });
                    sendResponse({ success: false, error: errorMessage }); return;
                }
                const audioBlob = await fetchResponse.blob();
                if (!(audioBlob && audioBlob.size > 0)) {
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
                    isLastChunk: isLastChunkForThisAudio
                };

                chrome.runtime.sendMessage({
                    action: "playAudioDataUrl",
                    audioDataUrl: audioDataUrl,
                    originalText: textToSynth,
                    articleDetails: articleDetailsForThisChunk
                });
                sendResponse({ success: true, message: "DataURL sent for playback." });

                // After successfully sending current chunk's audio, attempt to prefetch next
                // Ensure this is the chunk the session is currently focused on before prefetching
                if (currentTTSSession.isActive && requestedChunkIndex !== -1 && requestedChunkIndex === currentTTSSession.currentIndex) {
                    attemptToPrefetchNextChunk();
                }

            } catch (error) {
                console.error("[SW] Error during 'fetchTTSFromServer':", error);
                chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: `Server fetch error: ${error.message}` });
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    if (request.action === "requestNextAudioChunk") {
        console.log("[Service Worker] Received 'requestNextAudioChunk' from popup.");
        if (currentTTSSession.isActive) {
            const nextIndexToPlay = currentTTSSession.currentIndex + 1;

            if (nextIndexToPlay < currentTTSSession.chunks.length) {
                currentTTSSession.currentIndex = nextIndexToPlay; // Update the main index
                currentTTSSession.isPlayingInPopup = true;
                // saveCurrentSession(); // processAndSendChunkToPopup or the prefetched path will save

                if (currentTTSSession.prefetchedAudioDataUrlForNext &&
                    currentTTSSession.chunks[currentTTSSession.currentIndex] /* Ensure chunk exists */) {

                    console.log(`[Service Worker] Using prefetched audio for chunk index ${currentTTSSession.currentIndex} (display ${currentTTSSession.currentIndex + 1})`);
                    const textOfPrefetchedChunk = currentTTSSession.chunks[currentTTSSession.currentIndex];
                    const isLastChunkForPrefetched = currentTTSSession.currentIndex === currentTTSSession.chunks.length - 1;
                    const articleDetailsForPrefetchedChunk = {
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
                    attemptToPrefetchNextChunk(); // Prefetch the *new* next one
                } else {
                    console.log(`[Service Worker] No prefetched audio for chunk index ${currentTTSSession.currentIndex}. Telling popup to request it.`);
                    processAndSendChunkToPopup(currentTTSSession.currentIndex);
                    sendResponse({ status: "processingNextChunk", nextIndex: currentTTSSession.currentIndex });
                }
            } else {
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

    if (request.action === "requestInitialSessionState") { /* ... remains the same ... */
        console.log("[Service Worker] Popup requested initial session state.");
        const sessionDataForPopup = {
            isActive: currentTTSSession.isActive,
            currentIndex: currentTTSSession.currentIndex,
            totalChunks: currentTTSSession.chunks.length,
            articleDetails: currentTTSSession.isActive ? {
                title: currentTTSSession.articleDetails.title,
                isChunk: currentTTSSession.chunks.length > 1,
                currentChunkIndex: currentTTSSession.currentIndex,
                totalChunks: currentTTSSession.chunks.length,
            } : null,
        };
        sendResponse({ action: "activeSessionState", sessionData: sessionDataForPopup });
        return false;
    }

    if (request.action === "resumeTTSSession" && typeof request.resumeFromChunkIndex === 'number') { /* ... */
        console.log("[Service Worker] Popup requested to resume session from chunk index:", request.resumeFromChunkIndex);
        if (currentTTSSession.chunks.length > 0 && request.resumeFromChunkIndex < currentTTSSession.chunks.length) {
            currentTTSSession.isActive = true;
            // isPlayingInPopup will be set by processAndSendChunkToPopup
            currentTTSSession.currentIndex = request.resumeFromChunkIndex;

            (async () => {
                await openOrFocusTTSPopout();
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 300));
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
            resetTTSSession();
            sendResponse({ success: false, error: "No valid session to resume or invalid index." });
        }
        return true;
    }

    return false;
});

console.log("[Service Worker] Event listeners registered.");
