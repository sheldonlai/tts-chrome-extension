// background.js

// Import shared utilities
try {
    importScripts('popup/cacheUtils.js'); // Assuming cacheUtils.js is in popup/
} catch (e) {
    console.error("Failed to import cacheUtils.js in background.js. Ensure path is correct.", e);
}


let ttsPopoutWindowId = null;
const PERSISTED_SESSION_KEY = 'persistedTTSSession';
const SELECTED_TEXT_TITLE_LENGTH = 60; // Define the length for the title snippet

// In-memory session state
let currentTTSSession = {
    chunks: [],
    articleDetails: {},
    currentIndex: 0,
    isActive: false,
    isPlayingInPopup: false,
    prefetchedAudioDataUrlForNext: null,
    isCurrentlyPrefetching: false
};

// --- Session Persistence Functions ---
async function saveCurrentSession() {
    if (currentTTSSession.isActive || (currentTTSSession.chunks && currentTTSSession.chunks.length > 0)) {
        console.log("[Service Worker] Saving current TTS session to storage. Index:", currentTTSSession.currentIndex, "Active:", currentTTSSession.isActive, "PlayingInPopup:", currentTTSSession.isPlayingInPopup);
        try {
            const sessionToSave = {
                chunks: currentTTSSession.chunks,
                articleDetails: currentTTSSession.articleDetails,
                currentIndex: currentTTSSession.currentIndex,
                isActive: currentTTSSession.isActive,
            };
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
        const persistedData = result[PERSISTED_SESSION_KEY];

        if (persistedData && persistedData.chunks && persistedData.chunks.length > 0 && typeof persistedData.currentIndex === 'number') {
            currentTTSSession.chunks = persistedData.chunks;
            currentTTSSession.articleDetails = persistedData.articleDetails || {};
            if (!currentTTSSession.articleDetails.chunks || currentTTSSession.articleDetails.chunks.length === 0) {
                currentTTSSession.articleDetails.chunks = persistedData.chunks;
            }
            currentTTSSession.currentIndex = persistedData.currentIndex;
            currentTTSSession.isActive = persistedData.isActive;

            currentTTSSession.isPlayingInPopup = false;
            currentTTSSession.isCurrentlyPrefetching = false;
            currentTTSSession.prefetchedAudioDataUrlForNext = null;

            console.log("[Service Worker] Loaded persisted TTS session from storage. Index:", currentTTSSession.currentIndex, "Chunks:", currentTTSSession.chunks.length, "Active:", currentTTSSession.isActive);
        } else {
            console.log("[Service Worker] No valid/active session found in storage to load.");
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
            console.warn("[Service Worker] Error getting existing window, assuming closed:", e.message);
            ttsPopoutWindowId = null;
        }
    }
    try {
        const newWindow = await chrome.windows.create({
            url: popoutUrl, type: "popup", width: 400, height: 600, focused: true
        });
        ttsPopoutWindowId = newWindow.id;
        console.log("[Service Worker] New TTS popout window created. ID:", ttsPopoutWindowId, "Height: 600");

        chrome.windows.onRemoved.addListener(function specificWindowRemovedListener(removedWindowId) {
            if (removedWindowId === ttsPopoutWindowId) {
                console.log("[Service Worker] TTS popout window (ID:", ttsPopoutWindowId, ") was closed.");
                ttsPopoutWindowId = null;
                if (currentTTSSession.isActive) {
                    currentTTSSession.isPlayingInPopup = false;
                    saveCurrentSession();
                    console.log("[Service Worker] TTS session marked as paused due to popout close.");
                }
                chrome.windows.onRemoved.removeListener(specificWindowRemovedListener);
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
    if (!currentTTSSession.isActive || !currentTTSSession.chunks || chunkIndex >= currentTTSSession.chunks.length) {
        console.log("[Service Worker] Session not active or chunk index out of bounds for processing.",
            "Index:", chunkIndex, "Chunks length:", currentTTSSession.chunks ? currentTTSSession.chunks.length : 'N/A');
        if (chunkIndex >= (currentTTSSession.chunks ? currentTTSSession.chunks.length : 0) && currentTTSSession.isActive) {
            console.log("[Service Worker] All chunks processed for current session.");
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" }).catch(e => console.warn("Error sending allChunksFinished:", e.message));
        }
        resetTTSSession();
        return;
    }

    const chunkText = currentTTSSession.chunks[chunkIndex];
    const isLastChunk = chunkIndex === currentTTSSession.chunks.length - 1;
    currentTTSSession.currentIndex = chunkIndex;
    currentTTSSession.isPlayingInPopup = true;

    if (!currentTTSSession.articleDetails) currentTTSSession.articleDetails = {};
    currentTTSSession.articleDetails.chunks = currentTTSSession.chunks;
    saveCurrentSession();

    console.log(`[Service Worker] Processing chunk ${chunkIndex + 1}/${currentTTSSession.chunks.length} for popup: "${chunkText.substring(0, 50)}..."`);

    const articleDetailsForChunk = {
        title: currentTTSSession.articleDetails.title || "Reading Page Content", // Use the title from currentTTSSession
        textContent: chunkText,
        isChunk: currentTTSSession.chunks.length > 1,
        currentChunkIndex: chunkIndex,
        totalChunks: currentTTSSession.chunks.length,
        isLastChunk: isLastChunk,
        simplifiedHtml: currentTTSSession.articleDetails.simplifiedHtml,
        excerpt: currentTTSSession.articleDetails.excerpt,
        length: currentTTSSession.articleDetails.length,
        chunks: currentTTSSession.chunks
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

async function attemptToPrefetchNextChunk() {
    if (!currentTTSSession.isActive || currentTTSSession.isCurrentlyPrefetching) {
        return;
    }
    const nextChunkToPrefetchIndex = currentTTSSession.currentIndex + 1;

    if (nextChunkToPrefetchIndex < currentTTSSession.chunks.length) {
        const textToPrefetch = currentTTSSession.chunks[nextChunkToPrefetchIndex];
        const cacheKey = generateAudioCacheKey(textToPrefetch);

        const cachedItem = await chrome.storage.local.get([cacheKey]);
        if (cachedItem[cacheKey]) {
            console.log(`[Service Worker] Audio for next chunk (index ${nextChunkToPrefetchIndex}) already in cache. Skipping prefetch.`);
            currentTTSSession.prefetchedAudioDataUrlForNext = cachedItem[cacheKey];
            return;
        }

        console.log(`[Service Worker] Attempting to prefetch audio for chunk index ${nextChunkToPrefetchIndex} (display number ${nextChunkToPrefetchIndex + 1})`);
        currentTTSSession.isCurrentlyPrefetching = true;
        currentTTSSession.prefetchedAudioDataUrlForNext = null;

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
        }
    } else {
        currentTTSSession.prefetchedAudioDataUrlForNext = null;
    }
}

// --- Event and Message Listeners ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "processTextForTTS_ContextMenu" && info.selectionText) {
        console.log("[Service Worker] Context menu: 'Read selected text'.");
        await clearPersistedSession();
        resetTTSSession(false);

        const selectedText = info.selectionText.trim();
        // MODIFIED: Set title to a snippet of the selected text
        const titleSnippet = selectedText.substring(0, SELECTED_TEXT_TITLE_LENGTH) +
            (selectedText.length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");

        currentTTSSession.chunks = [selectedText];
        currentTTSSession.articleDetails = {
            title: titleSnippet, // Use the generated snippet as the title
            textContent: selectedText,
            simplifiedHtml: `<p>${selectedText.replace(/\n/g, '</p><p>')}</p>`,
            excerpt: selectedText.substring(0, 150) + (selectedText.length > 150 ? "..." : ""),
            length: selectedText.length,
            chunks: [selectedText]
        };
        currentTTSSession.currentIndex = 0;
        currentTTSSession.isActive = true;
        try {
            await openOrFocusTTSPopout();
            if (ttsPopoutWindowId) {
                await new Promise(resolve => setTimeout(resolve, 700));
                processAndSendChunkToPopup(currentTTSSession.currentIndex);
                // attemptToPrefetchNextChunk(); // Not typically needed for single selected text
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

    if (request.action === "clearPersistedTTSSession_Background") {
        (async () => {
            await clearPersistedSession();
            resetTTSSession(false);
            console.log("[Service Worker] Persisted TTS session cleared by popup request.");
            if (ttsPopoutWindowId) {
                chrome.runtime.sendMessage({ action: "sessionClearedByBackground" })
                    .catch(e => console.warn("Error sending sessionClearedByBackground to popup:", e.message));
            }
            sendResponse({ status: "persistedSessionCleared" });
        })();
        return true;
    }

    if (request.action === "getSimplifiedContentForTTS") {
        (async () => {
            await clearPersistedSession();
            resetTTSSession(false);
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
                        if (!currentTTSSession.articleDetails.chunks) {
                            currentTTSSession.articleDetails.chunks = currentTTSSession.chunks;
                        }
                        // Ensure title is present, fallback if Readability didn't provide one
                        if (!currentTTSSession.articleDetails.title && currentTTSSession.chunks.length > 0) {
                            currentTTSSession.articleDetails.title = currentTTSSession.chunks[0].substring(0, SELECTED_TEXT_TITLE_LENGTH) +
                                (currentTTSSession.chunks[0].length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");
                        } else if (!currentTTSSession.articleDetails.title) {
                            currentTTSSession.articleDetails.title = "Page Content";
                        }

                        currentTTSSession.currentIndex = 0;
                        currentTTSSession.isActive = true;

                        await openOrFocusTTSPopout();
                        if (ttsPopoutWindowId) {
                            await new Promise(resolve => setTimeout(resolve, 700));
                            processAndSendChunkToPopup(currentTTSSession.currentIndex);
                            attemptToPrefetchNextChunk();
                            sendResponse({ success: true, message: "Chunked content processing initiated." });
                        } else { resetTTSSession(); sendResponse({ success: false, error: "Could not open TTS popout." }); }
                    } else { sendResponse({ success: false, error: responseFromContent.error || "No valid chunked data received from content script." }); }
                } else { sendResponse({ success: false, error: "No active tab found." }); }
            } catch (error) { console.error("[SW] Error in 'getSimplifiedContentForTTS':", error); sendResponse({ success: false, error: error.message }); }
        })();
        return true;
    }

    if (request.action === "fetchTTSFromServer" && request.textToSynthesize) {
        const textToSynth = request.textToSynthesize;
        const requestedChunkIndex = currentTTSSession.chunks ? currentTTSSession.chunks.indexOf(textToSynth) : -1;
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
                    chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: errorMessage }).catch(e => console.warn("Error sending ttsErrorPopup", e.message));
                    sendResponse({ success: false, error: errorMessage }); return;
                }
                const audioBlob = await fetchResponse.blob();
                if (!(audioBlob && audioBlob.size > 0)) {
                    const blobError = "Fetched audioBlob is not valid or is empty.";
                    chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: blobError }).catch(e => console.warn("Error sending ttsErrorPopup", e.message));
                    sendResponse({ success: false, error: blobError }); return;
                }
                const audioDataUrl = await blobToDataURL(audioBlob);
                console.log("[Service Worker] Sending audio to popup for playback.");

                const isLastChunkForThisAudio = currentTTSSession.isActive ? (requestedChunkIndex === currentTTSSession.chunks.length - 1) : true;
                const articleDetailsForThisChunk = {
                    title: currentTTSSession.articleDetails.title || "Reading Page Content",
                    textContent: textToSynth,
                    isChunk: currentTTSSession.chunks.length > 1,
                    currentChunkIndex: requestedChunkIndex,
                    totalChunks: currentTTSSession.chunks.length,
                    isLastChunk: isLastChunkForThisAudio,
                    chunks: currentTTSSession.chunks
                };

                chrome.runtime.sendMessage({
                    action: "playAudioDataUrl",
                    audioDataUrl: audioDataUrl,
                    originalText: textToSynth,
                    articleDetails: articleDetailsForThisChunk
                }).catch(e => console.warn("Error sending playAudioDataUrl to popup", e.message));
                sendResponse({ success: true, message: "DataURL sent for playback." });

                if (currentTTSSession.isActive && requestedChunkIndex !== -1 && requestedChunkIndex === currentTTSSession.currentIndex) {
                    attemptToPrefetchNextChunk();
                }

            } catch (error) {
                console.error("[SW] Error during 'fetchTTSFromServer':", error);
                chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: `Server fetch error: ${error.message}` }).catch(e => console.warn("Error sending ttsErrorPopup", e.message));
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
                currentTTSSession.currentIndex = nextIndexToPlay;
                currentTTSSession.isPlayingInPopup = true;

                if (currentTTSSession.prefetchedAudioDataUrlForNext &&
                    currentTTSSession.chunks[currentTTSSession.currentIndex]) {

                    console.log(`[Service Worker] Using prefetched audio for chunk index ${currentTTSSession.currentIndex} (display ${currentTTSSession.currentIndex + 1})`);
                    const textOfPrefetchedChunk = currentTTSSession.chunks[currentTTSSession.currentIndex];
                    const isLastChunkForPrefetched = currentTTSSession.currentIndex === currentTTSSession.chunks.length - 1;
                    const articleDetailsForPrefetchedChunk = {
                        title: currentTTSSession.articleDetails.title || "Reading Page Content",
                        textContent: textOfPrefetchedChunk,
                        isChunk: true,
                        currentChunkIndex: currentTTSSession.currentIndex,
                        totalChunks: currentTTSSession.chunks.length,
                        isLastChunk: isLastChunkForPrefetched,
                        chunks: currentTTSSession.chunks
                    };
                    chrome.runtime.sendMessage({
                        action: "playAudioDataUrl",
                        audioDataUrl: currentTTSSession.prefetchedAudioDataUrlForNext,
                        originalText: textOfPrefetchedChunk,
                        articleDetails: articleDetailsForPrefetchedChunk
                    }).catch(e => console.warn("Error sending prefetched playAudioDataUrl to popup", e.message));
                    currentTTSSession.prefetchedAudioDataUrlForNext = null;
                    sendResponse({ status: "sentPrefetchedAudio", nextIndex: currentTTSSession.currentIndex });
                    attemptToPrefetchNextChunk();
                } else {
                    console.log(`[Service Worker] No prefetched audio for chunk index ${currentTTSSession.currentIndex}. Telling popup to request it.`);
                    processAndSendChunkToPopup(currentTTSSession.currentIndex);
                    sendResponse({ status: "processingNextChunk", nextIndex: currentTTSSession.currentIndex });
                }
            } else {
                console.log("[Service Worker] All chunks finished after requestNextAudioChunk.");
                if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" }).catch(e => console.warn("Error sending allChunksFinished to popup", e.message));
                resetTTSSession();
                sendResponse({ status: "allChunksFinished" });
            }
        } else {
            console.log("[Service Worker] No active TTS session for 'requestNextAudioChunk'.");
            sendResponse({ status: "noActiveSession" });
        }
        return true;
    }

    if (request.action === "requestInitialSessionState") {
        console.log("[Service Worker] Popup requested initial session state.");
        const articleDetailsForPopup = currentTTSSession.isActive
            ? {
                ...currentTTSSession.articleDetails,
                chunks: currentTTSSession.chunks,
                isChunk: currentTTSSession.chunks && currentTTSSession.chunks.length > 1,
                currentChunkIndex: currentTTSSession.currentIndex,
                totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0
            }
            : null;

        const sessionDataForPopup = {
            isActive: currentTTSSession.isActive,
            currentIndex: currentTTSSession.currentIndex,
            totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
            articleDetails: articleDetailsForPopup,
        };
        sendResponse({ action: "activeSessionState", sessionData: sessionDataForPopup });
        return false;
    }

    if (request.action === "resumeTTSSession" && typeof request.resumeFromChunkIndex === 'number') {
        console.log("[Service Worker] Popup requested to resume session from chunk index:", request.resumeFromChunkIndex);
        if (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 && request.resumeFromChunkIndex < currentTTSSession.chunks.length) {
            currentTTSSession.isActive = true;
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

    if (request.action === "jumpToChunk" && typeof request.jumpToChunkIndex === 'number') {
        const jumpToIndex = request.jumpToChunkIndex;
        console.log(`[Service Worker] Popup requested to jump to chunk index: ${jumpToIndex}`);
        if (currentTTSSession.isActive && currentTTSSession.chunks && jumpToIndex >= 0 && jumpToIndex < currentTTSSession.chunks.length) {
            currentTTSSession.currentIndex = jumpToIndex;
            currentTTSSession.isPlayingInPopup = true;
            currentTTSSession.prefetchedAudioDataUrlForNext = null;
            currentTTSSession.isCurrentlyPrefetching = false;

            (async () => {
                await openOrFocusTTSPopout();
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    processAndSendChunkToPopup(currentTTSSession.currentIndex);
                    attemptToPrefetchNextChunk();
                    sendResponse({ success: true, message: `Jumping to chunk ${jumpToIndex + 1}` });
                } else {
                    console.error("[Service Worker] Cannot jump to chunk, TTS popout window not available.");
                    resetTTSSession();
                    sendResponse({ success: false, error: "TTS window not available for chunk jump." });
                }
            })();
        } else {
            console.warn("[Service Worker] Cannot jump to chunk: No active session or invalid index.");
            sendResponse({ success: false, error: "No active session or invalid chunk index for jump." });
        }
        return true;
    }

    return false;
});

console.log("[Service Worker] Event listeners registered.");
