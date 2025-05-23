// background.js

try {
    importScripts('popup/cacheUtils.js');
} catch (e) {
    console.error("Failed to import cacheUtils.js in background.js. Ensure path is correct.", e);
}

let ttsPopoutWindowId = null;
const PERSISTED_SESSION_KEY = 'persistedTTSSession';
const SELECTED_TEXT_TITLE_LENGTH = 400;

let currentTTSSession = {
    chunks: [],
    articleDetails: {
        sourceTabId: null,
        sourceUrl: null,
        nextPageUrlToVisit: null,
    },
    currentIndex: 0,
    isActive: false,
    isPlayingInPopup: false,
    // prefetchedAudioDataUrlForNext: null, // No longer needed, cache is primary
    isCurrentlyPrefetching: false, // Tracks if an N+1 prefetch is active
    autoAdvanceToNextPage: false,
    isIdentifyingNextPage: false
};

let pendingTTSForTab = {};

async function saveCurrentSession() {
    // Only save if there's something meaningful to persist
    if (currentTTSSession.isActive ||
        (currentTTSSession.chunks && currentTTSSession.chunks.length > 0) ||
        (currentTTSSession.articleDetails && currentTTSSession.articleDetails.nextPageUrlToVisit)) {
        try {
            const articleDetailsToSave = { ...currentTTSSession.articleDetails };
            const sessionToSave = {
                chunks: currentTTSSession.chunks,
                articleDetails: articleDetailsToSave,
                currentIndex: currentTTSSession.currentIndex,
                isActive: currentTTSSession.isActive,
                autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage,
                isIdentifyingNextPage: currentTTSSession.isIdentifyingNextPage
                // isCurrentlyPrefetching is a transient state, not persisted
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

        if (persistedData) {
            currentTTSSession.chunks = persistedData.chunks || [];
            currentTTSSession.articleDetails = persistedData.articleDetails || { sourceTabId: null, sourceUrl: null, nextPageUrlToVisit: null };
            if (!currentTTSSession.articleDetails.chunks || currentTTSSession.articleDetails.chunks.length === 0) {
                if (persistedData.chunks) currentTTSSession.articleDetails.chunks = persistedData.chunks;
            }
            currentTTSSession.currentIndex = typeof persistedData.currentIndex === 'number' ? persistedData.currentIndex : 0;
            currentTTSSession.isActive = persistedData.isActive || false;
            currentTTSSession.autoAdvanceToNextPage = persistedData.autoAdvanceToNextPage || false;
            currentTTSSession.isIdentifyingNextPage = persistedData.isIdentifyingNextPage || false;

            currentTTSSession.isPlayingInPopup = false;
            currentTTSSession.isCurrentlyPrefetching = false;
            // currentTTSSession.prefetchedAudioDataUrlForNext = null; // Reset on load

            console.log("[SW] Loaded persisted session. Active:", currentTTSSession.isActive, "AutoAdvance:", currentTTSSession.autoAdvanceToNextPage, "IdentifyingNext:", currentTTSSession.isIdentifyingNextPage, "NextURL:", currentTTSSession.articleDetails.nextPageUrlToVisit);
        } else {
            console.log("[SW] No valid session found in storage to load. Initializing default session.");
            resetTTSSession(false);
        }
    } catch (e) {
        console.error("[SW] Error loading session from storage:", e);
        resetTTSSession(false);
    }
}

async function clearPersistedSession() {
    console.log("[SW] Clearing persisted TTS session from storage.");
    try {
        await chrome.storage.local.remove([PERSISTED_SESSION_KEY]);
    } catch (e) {
        console.error("[SW] Error clearing session from storage:", e);
    }
}

loadPersistedSession();

function setupContextMenu() {
    chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) { /* Suppress error */ }
        chrome.contextMenus.create({
            id: "processTextForTTS_ContextMenu",
            title: "Read selected text aloud (Popout)",
            contexts: ["selection"]
        });
        chrome.contextMenus.create({
            id: "readEntirePage_ContextMenu",
            title: "Read entire page (Popout)",
            contexts: ["page"]
        });
        console.log("[SW] Context menus created/updated.");
    });
}

chrome.runtime.onInstalled.addListener((details) => {
    console.log("[SW] onInstalled event. Reason:", details.reason);
    setupContextMenu();
    chrome.storage.local.get(['ttsHistory'], (result) => {
        if (!result.ttsHistory) chrome.storage.local.set({ ttsHistory: [] });
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
            url: popoutUrl, type: "popup", width: 400, height: 600, focused: true
        });
        ttsPopoutWindowId = newWindow.id;
        chrome.windows.onRemoved.addListener(function specificWindowRemovedListener(removedWindowId) {
            if (removedWindowId === ttsPopoutWindowId) {
                ttsPopoutWindowId = null;
                if (currentTTSSession.isActive) {
                    currentTTSSession.isPlayingInPopup = false;
                    saveCurrentSession();
                }
                chrome.windows.onRemoved.removeListener(specificWindowRemovedListener);
            }
        });
        return ttsPopoutWindowId;
    } catch (winError) {
        console.error("[SW] Error creating TTS popout window:", winError);
        ttsPopoutWindowId = null;
        throw winError;
    }
}

function resetTTSSession(clearStorage = true, preserveAutoAdvance = false) {
    console.log("[SW] Resetting TTS session. Clear storage:", clearStorage, "Preserve AutoAdvance:", preserveAutoAdvance);
    const autoAdvanceState = preserveAutoAdvance ? currentTTSSession.autoAdvanceToNextPage : false;
    const oldSourceTabId = currentTTSSession.articleDetails ? currentTTSSession.articleDetails.sourceTabId : null;
    const oldSourceUrl = currentTTSSession.articleDetails ? currentTTSSession.articleDetails.sourceUrl : null;

    currentTTSSession = {
        chunks: [],
        articleDetails: {
            sourceTabId: preserveAutoAdvance ? oldSourceTabId : null,
            sourceUrl: preserveAutoAdvance ? oldSourceUrl : null,
            nextPageUrlToVisit: null,
        },
        currentIndex: 0,
        isActive: false,
        isPlayingInPopup: false,
        // prefetchedAudioDataUrlForNext: null, // Removed
        isCurrentlyPrefetching: false,
        autoAdvanceToNextPage: autoAdvanceState,
        isIdentifyingNextPage: false
    };

    if (clearStorage) {
        clearPersistedSession();
    }
}


async function initiateTTSForPage(tabId, isContinuation = false) {
    console.log(`[SW] Initiating TTS for page in tab ${tabId}. Is continuation: ${isContinuation}`);
    const previousAutoAdvanceState = currentTTSSession.autoAdvanceToNextPage;

    await clearPersistedSession();
    resetTTSSession(false, isContinuation);

    if (isContinuation) {
        currentTTSSession.autoAdvanceToNextPage = previousAutoAdvanceState;
    }
    currentTTSSession.isIdentifyingNextPage = false;
    if (currentTTSSession.articleDetails) currentTTSSession.articleDetails.nextPageUrlToVisit = null;


    try {
        if (!tabId) {
            console.error("[SW] No tabId provided for initiateTTSForPage");
            return { success: false, error: "No active tab found for TTS." };
        }
        const tab = await chrome.tabs.get(tabId);
        if (!tab) {
            console.error(`[SW] Could not get tab details for tabId: ${tabId}`);
            return { success: false, error: `Could not get tab details for tabId: ${tabId}` };
        }

        currentTTSSession.articleDetails.sourceTabId = tabId;
        currentTTSSession.articleDetails.sourceUrl = tab.url;

        if (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("https://chrome.google.com/webstore"))) {
            console.warn(`[SW] Cannot extract content from restricted page: ${tab.url}`);
            return { success: false, error: "Cannot extract content from restricted pages." };
        }

        const responseFromContent = await chrome.tabs.sendMessage(tabId, { action: "extractReadablePageContent" });
        if (responseFromContent && responseFromContent.success && responseFromContent.data && responseFromContent.data.textContentChunks) {
            currentTTSSession.chunks = responseFromContent.data.textContentChunks;
            currentTTSSession.articleDetails = {
                ...currentTTSSession.articleDetails,
                ...responseFromContent.data,
                nextPageUrlToVisit: null
            };
            if (!currentTTSSession.articleDetails.chunks) {
                currentTTSSession.articleDetails.chunks = currentTTSSession.chunks;
            }

            if (!currentTTSSession.articleDetails.title && currentTTSSession.chunks.length > 0) {
                currentTTSSession.articleDetails.title = currentTTSSession.chunks[0].substring(0, SELECTED_TEXT_TITLE_LENGTH) +
                    (currentTTSSession.chunks[0].length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");
            } else if (!currentTTSSession.articleDetails.title) {
                currentTTSSession.articleDetails.title = tab.title || "Page Content";
            }

            currentTTSSession.currentIndex = 0;
            currentTTSSession.isActive = true;

            await openOrFocusTTSPopout();
            if (ttsPopoutWindowId) {
                await new Promise(resolve => setTimeout(resolve, 700));
                processAndSendChunkToPopup(currentTTSSession.currentIndex);
                saveCurrentSession();
                return { success: true, message: "Chunked content processing initiated for page." };
            } else {
                resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
                return { success: false, error: "Could not open TTS popout for page reading." };
            }
        } else {
            resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
            return { success: false, error: (responseFromContent && responseFromContent.error) || "No valid chunked data received from content script for page." };
        }
    } catch (error) {
        console.error("[SW] Error in 'initiateTTSForPage':", error);
        resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
        return { success: false, error: error.message };
    }
}


async function processAndSendChunkToPopup(chunkIndex) {
    if (!currentTTSSession.isActive || !currentTTSSession.chunks || chunkIndex < 0) {
        resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
        return;
    }

    if (chunkIndex >= currentTTSSession.chunks.length) {
        if (ttsPopoutWindowId) {
            chrome.runtime.sendMessage({ action: "allChunksFinished" })
                .catch(e => console.warn("Error sending allChunksFinished:", e.message));
        }
        console.log("[SW] All chunks processed for current page. Waiting for audio to finish.");
        return;
    }

    const chunkText = currentTTSSession.chunks[chunkIndex];
    const isLastChunkOfCurrentPage = chunkIndex === currentTTSSession.chunks.length - 1;
    currentTTSSession.currentIndex = chunkIndex;
    currentTTSSession.isPlayingInPopup = true;

    if (!currentTTSSession.articleDetails) currentTTSSession.articleDetails = {};
    currentTTSSession.articleDetails.chunks = currentTTSSession.chunks;
    saveCurrentSession();

    if (currentTTSSession.autoAdvanceToNextPage &&
        currentTTSSession.chunks.length > 1 &&
        chunkIndex === currentTTSSession.chunks.length - 2 &&
        !currentTTSSession.isIdentifyingNextPage &&
        currentTTSSession.articleDetails.sourceTabId) {
        console.log("[SW] Second to last chunk started, auto-advance is ON. Proactively identifying next page URL.");
        identifyAndStoreNextPageUrl(currentTTSSession.articleDetails.sourceTabId, currentTTSSession.articleDetails.sourceUrl)
            .catch(e => console.error("[SW] Proactive identifyAndStoreNextPageUrl failed:", e));
    }

    const articleDetailsForChunk = {
        ...(currentTTSSession.articleDetails),
        textContent: chunkText,
        isChunk: currentTTSSession.chunks.length > 1,
        currentChunkIndex: chunkIndex,
        totalChunks: currentTTSSession.chunks.length,
        isLastChunk: isLastChunkOfCurrentPage,
        autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage,
        isActiveSession: currentTTSSession.isActive
    };

    chrome.runtime.sendMessage({
        action: "processTextForTTS",
        selectedText: chunkText,
        articleDetails: articleDetailsForChunk
    }, response => {
        if (chrome.runtime.lastError) {
            console.warn(`[SW] Error sending 'processTextForTTS' for chunk ${chunkIndex} to popout:`, chrome.runtime.lastError.message);
            currentTTSSession.isPlayingInPopup = false;
            saveCurrentSession();
        }
    });

    attemptToPrefetchNextChunk();
}

async function attemptToPrefetchNextChunk() {
    if (!currentTTSSession.isActive || currentTTSSession.isCurrentlyPrefetching) {
        if (!currentTTSSession.isActive) console.log("[SW-Prefetch] Session not active, skipping prefetch.");
        if (currentTTSSession.isCurrentlyPrefetching) console.log("[SW-Prefetch] Already prefetching another chunk, skipping.");
        return;
    }

    // Target chunk N+1 relative to the current playing chunk N
    const nextChunkToPrefetchIndex = currentTTSSession.currentIndex + 1;

    if (nextChunkToPrefetchIndex < currentTTSSession.chunks.length) {
        const textToPrefetch = currentTTSSession.chunks[nextChunkToPrefetchIndex];
        const cacheKey = typeof generateAudioCacheKey === 'function' ? generateAudioCacheKey(textToPrefetch) : AUDIO_CACHE_PREFIX + textToPrefetch.substring(0, 50);

        try {
            const cachedItem = await chrome.storage.local.get([cacheKey]);
            if (cachedItem[cacheKey]) {
                console.log(`[SW] Audio for target prefetch chunk ${nextChunkToPrefetchIndex} (text: "${textToPrefetch.substring(0, 20)}...") already in cache. Prefetch not needed.`);
                return;
            }
        } catch (e) {
            console.error(`[SW-Prefetch] Error checking cache for chunk ${nextChunkToPrefetchIndex}:`, e);
        }

        currentTTSSession.isCurrentlyPrefetching = true;
        console.log(`[SW] Attempting to prefetch audio for chunk index ${nextChunkToPrefetchIndex} (text: "${textToPrefetch.substring(0, 30)}..."). Current playing: ${currentTTSSession.currentIndex}`);
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
                    const audioDataUrl = await blobToDataURL(audioBlob);
                    await chrome.storage.local.set({ [cacheKey]: audioDataUrl });
                    console.log(`[SW] Successfully prefetched and cached audio for chunk index ${nextChunkToPrefetchIndex}.`);
                } else {
                    console.warn(`[SW] Prefetch for chunk ${nextChunkToPrefetchIndex} resulted in empty blob.`);
                }
            } else {
                console.warn(`[SW] Prefetch API call for chunk ${nextChunkToPrefetchIndex} failed: ${fetchResponse.status}`);
            }
        } catch (error) {
            console.error(`[SW] Error during prefetch for chunk index ${nextChunkToPrefetchIndex}:`, error);
        } finally {
            currentTTSSession.isCurrentlyPrefetching = false;
        }
    } else {
        console.log(`[SW-Prefetch] No chunk at index ${nextChunkToPrefetchIndex} to prefetch (Current: ${currentTTSSession.currentIndex}, Total: ${currentTTSSession.chunks.length}).`);
    }
}

async function identifyAndStoreNextPageUrl(sourceTabId, currentSourceUrl) {
    if (currentTTSSession.isIdentifyingNextPage) {
        console.log("[SW] Already in the process of identifying the next page URL. Aborting duplicate call.");
        return false;
    }
    if (!sourceTabId) {
        console.warn("[SW] identifyAndStoreNextPageUrl called without sourceTabId.");
        return false;
    }

    currentTTSSession.isIdentifyingNextPage = true;
    if (currentTTSSession.articleDetails) currentTTSSession.articleDetails.nextPageUrlToVisit = null;
    saveCurrentSession();
    console.log(`[SW] Identifying next page URL for tab ${sourceTabId} (current URL: ${currentSourceUrl})`);
    let nextPageDataForFinally;

    try {
        const tab = await chrome.tabs.get(sourceTabId);
        if (!tab || tab.url !== currentSourceUrl) {
            console.warn(`[SW] Tab ${sourceTabId} URL changed or tab closed. Current: ${tab ? tab.url : 'N/A'}. Expected: ${currentSourceUrl}. Aborting next page identification.`);
            return false;
        }

        const linksResponse = await chrome.tabs.sendMessage(sourceTabId, { action: "extractPageLinks" });
        if (!linksResponse || !linksResponse.success || !linksResponse.data) {
            console.error("[SW] Failed to extract page links from content script:", linksResponse ? linksResponse.error : "No response");
            return false;
        }

        const nextPageApiUrl = 'http://localhost:8080/get-next-page-data';
        const apiFetchResponse = await fetch(nextPageApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(linksResponse.data)
        });

        if (!apiFetchResponse.ok) {
            const errorText = await apiFetchResponse.text();
            console.error(`[SW] Next page API error: ${apiFetchResponse.status} - ${errorText}`);
            return false;
        }

        const nextPageData = await apiFetchResponse.json();
        nextPageDataForFinally = nextPageData;
        console.log("[SW] Received from next page API for identification:", nextPageData);

        if (nextPageData.nextLinkFound && nextPageData.nextLinkUrl) {
            if (currentTTSSession.articleDetails) {
                currentTTSSession.articleDetails.nextPageUrlToVisit = nextPageData.nextLinkUrl;
                console.log(`[SW] Next page URL identified and stored: ${nextPageData.nextLinkUrl}`);
                saveCurrentSession();
                return true;
            }
        } else {
            console.log("[SW] No next page link identified by API. Reasoning:", nextPageData.reasoning);
        }
    } catch (error) {
        console.error("[SW] Error in identifyAndStoreNextPageUrl:", error);
    } finally {
        currentTTSSession.isIdentifyingNextPage = false;
        saveCurrentSession();
    }
    return false;
}


// --- Context Menu Handler ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "processTextForTTS_ContextMenu" && info.selectionText) {
        console.log("[SW] Context menu: 'Read selected text'. Tab ID:", tab.id);
        const previousAutoAdvance = currentTTSSession.autoAdvanceToNextPage;
        await clearPersistedSession();
        resetTTSSession(false, true);
        currentTTSSession.autoAdvanceToNextPage = previousAutoAdvance;
        currentTTSSession.isIdentifyingNextPage = false;
        if (currentTTSSession.articleDetails) currentTTSSession.articleDetails.nextPageUrlToVisit = null;


        const selectedText = info.selectionText.trim();
        const titleSnippet = selectedText.substring(0, SELECTED_TEXT_TITLE_LENGTH) +
            (selectedText.length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");

        currentTTSSession.chunks = [selectedText];
        currentTTSSession.articleDetails = {
            ...currentTTSSession.articleDetails,
            title: titleSnippet,
            textContent: selectedText,
            simplifiedHtml: `<p>${selectedText.replace(/\n/g, '</p><p>')}</p>`,
            excerpt: selectedText.substring(0, 150) + (selectedText.length > 150 ? "..." : ""),
            length: selectedText.length,
            chunks: [selectedText],
            sourceTabId: tab.id,
            sourceUrl: tab.url,
            nextPageUrlToVisit: null
        };
        currentTTSSession.currentIndex = 0;
        currentTTSSession.isActive = true;

        try {
            await openOrFocusTTSPopout();
            if (ttsPopoutWindowId) {
                await new Promise(resolve => setTimeout(resolve, 700));
                processAndSendChunkToPopup(currentTTSSession.currentIndex);
                saveCurrentSession();
            } else { resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage); }
        } catch (error) { console.error("[SW] Error opening popout from context menu:", error); resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage); }

    } else if (info.menuItemId === "readEntirePage_ContextMenu") {
        console.log("[SW] Context menu: 'Read entire page'. Tab ID:", tab.id);
        if (tab && tab.id) {
            const result = await initiateTTSForPage(tab.id, false);
            if (!result.success) {
                console.error("[SW] Failed to initiate TTS from context menu:", result.error);
                if (ttsPopoutWindowId) {
                    chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: result.error || "Failed to read page." })
                        .catch(e => console.warn("Error sending ttsErrorPopup for page read failure:", e.message));
                }
            }
        } else {
            console.error("[SW] Context menu 'Read entire page' clicked but no valid tab information.");
        }
    }
});

// --- Message Listeners from Popup/Content ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // console.log("[SW] Message received. Action:", request.action, "Request data:", request);

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
            try {
                const allStorageItems = await chrome.storage.local.get(null);
                const cacheKeysToRemove = [];
                const prefix = typeof AUDIO_CACHE_PREFIX !== 'undefined' ? AUDIO_CACHE_PREFIX : "tts_audio_cache_";
                for (const key in allStorageItems) {
                    if (key.startsWith(prefix)) cacheKeysToRemove.push(key);
                }
                if (cacheKeysToRemove.length > 0) await chrome.storage.local.remove(cacheKeysToRemove);
            } catch (e) { console.error("[SW] Error clearing audio cache:", e); }
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "sessionClearedByBackground" }).catch(e => { });
            sendResponse({ status: "persistedSessionAndCacheCleared" });
        })();
        return true;
    }

    if (request.action === "getSimplifiedContentForTTS") {
        (async () => {
            const lastFocusedNormalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
            if (!lastFocusedNormalWindow) {
                sendResponse({ success: false, error: "No suitable browser window found." }); return;
            }
            const [activeTab] = await chrome.tabs.query({ active: true, windowId: lastFocusedNormalWindow.id });
            if (activeTab && activeTab.id) {
                const result = await initiateTTSForPage(activeTab.id, false);
                sendResponse(result);
            } else {
                sendResponse({ success: false, error: "No active tab found for TTS." });
            }
        })();
        return true;
    }

    if (request.action === "fetchTTSFromServer" && request.textToSynthesize) {
        const textToSynth = request.textToSynthesize;
        const finalRequestedChunkIndex = (request.originalArticleDetails && typeof request.originalArticleDetails.currentChunkIndex === 'number') ?
            request.originalArticleDetails.currentChunkIndex :
            currentTTSSession.chunks.indexOf(textToSynth);

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
                    if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: errorMessage }).catch(e => { });
                    sendResponse({ success: false, error: errorMessage }); return;
                }
                const audioBlob = await fetchResponse.blob();
                if (!(audioBlob && audioBlob.size > 0)) {
                    const blobError = "Fetched audioBlob is not valid or is empty.";
                    if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: blobError }).catch(e => { });
                    sendResponse({ success: false, error: blobError }); return;
                }
                const audioDataUrl = await blobToDataURL(audioBlob);

                const isLastChunkForThisAudio = currentTTSSession.isActive && finalRequestedChunkIndex !== -1 ?
                    (finalRequestedChunkIndex === currentTTSSession.chunks.length - 1) : true;

                const baseDetails = request.originalArticleDetails || currentTTSSession.articleDetails || {};
                const articleDetailsForThisChunk = {
                    ...baseDetails,
                    title: baseDetails.title || "Reading Page Content",
                    textContent: textToSynth,
                    isChunk: (request.originalArticleDetails && request.originalArticleDetails.isChunk !== undefined) ? request.originalArticleDetails.isChunk : (currentTTSSession.isActive && currentTTSSession.chunks.length > 1),
                    currentChunkIndex: finalRequestedChunkIndex,
                    totalChunks: (request.originalArticleDetails && request.originalArticleDetails.chunks) ? request.originalArticleDetails.chunks.length : (currentTTSSession.isActive ? currentTTSSession.chunks.length : 1),
                    isLastChunk: isLastChunkForThisAudio,
                    chunks: (request.originalArticleDetails && request.originalArticleDetails.chunks) ? request.originalArticleDetails.chunks : (currentTTSSession.isActive ? currentTTSSession.chunks : [textToSynth]),
                    autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage,
                    isActiveSession: currentTTSSession.isActive
                };

                if (ttsPopoutWindowId) {
                    chrome.runtime.sendMessage({
                        action: "playAudioDataUrl",
                        audioDataUrl: audioDataUrl,
                        originalText: textToSynth,
                        articleDetails: articleDetailsForThisChunk
                    }).catch(e => { });
                }
                sendResponse({ success: true, message: "DataURL sent for playback." });
            } catch (error) {
                console.error("[SW] Error during 'fetchTTSFromServer':", error);
                if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: `Server fetch error: ${error.message}` }).catch(e => { });
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    if (request.action === "requestNextAudioChunk") {
        if (currentTTSSession.isActive) {
            const nextIndexToPlay = currentTTSSession.currentIndex + 1;
            processAndSendChunkToPopup(nextIndexToPlay);
            sendResponse({ status: "processingNextChunkOrFinished", nextIndex: nextIndexToPlay });
        } else {
            sendResponse({ status: "noActiveSession" });
        }
        return true;
    }


    if (request.action === "requestInitialSessionState") {
        const comprehensiveArticleDetailsForPopup = {
            ...(currentTTSSession.articleDetails || {}),
            title: (currentTTSSession.articleDetails && currentTTSSession.articleDetails.title) ? currentTTSSession.articleDetails.title : (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 ? "Reading Content" : "No Active Content"),
            isChunk: currentTTSSession.chunks && currentTTSSession.chunks.length > 1,
            currentChunkIndex: currentTTSSession.currentIndex,
            totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
            chunks: currentTTSSession.chunks || [],
            isActiveSession: currentTTSSession.isActive,
            autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage,
            textContent: (currentTTSSession.isActive && currentTTSSession.chunks && currentTTSSession.chunks.length > currentTTSSession.currentIndex) ? currentTTSSession.chunks[currentTTSSession.currentIndex] : ""
        };

        const sessionDataForPopup = {
            isActive: currentTTSSession.isActive,
            articleDetails: comprehensiveArticleDetailsForPopup,
        };
        sendResponse({ action: "activeSessionState", sessionData: sessionDataForPopup });
        return false;
    }


    if (request.action === "resumeTTSSession" && typeof request.resumeFromChunkIndex === 'number') {
        if (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 && request.resumeFromChunkIndex < currentTTSSession.chunks.length) {
            currentTTSSession.isActive = true;
            currentTTSSession.isIdentifyingNextPage = false;
            if (currentTTSSession.articleDetails) currentTTSSession.articleDetails.nextPageUrlToVisit = null;

            (async () => {
                await openOrFocusTTSPopout();
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    processAndSendChunkToPopup(request.resumeFromChunkIndex);
                    sendResponse({ success: true, message: "Resuming session." });
                } else {
                    resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
                    sendResponse({ success: false, error: "TTS window not available to resume." });
                }
            })();
        } else {
            resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
            sendResponse({ success: false, error: "No valid session to resume or invalid index." });
        }
        return true;
    }

    if (request.action === "jumpToChunk" && typeof request.jumpToChunkIndex === 'number') {
        const jumpToIndex = request.jumpToChunkIndex;
        if (currentTTSSession.isActive && currentTTSSession.chunks && jumpToIndex >= 0 && jumpToIndex < currentTTSSession.chunks.length) {
            currentTTSSession.isPlayingInPopup = true;
            currentTTSSession.isCurrentlyPrefetching = false;
            currentTTSSession.isIdentifyingNextPage = false;
            if (currentTTSSession.articleDetails) currentTTSSession.articleDetails.nextPageUrlToVisit = null;

            (async () => {
                await openOrFocusTTSPopout();
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    processAndSendChunkToPopup(jumpToIndex);
                    sendResponse({ success: true, message: `Jumping to chunk ${jumpToIndex + 1}` });
                } else {
                    resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
                    sendResponse({ success: false, error: "TTS window not available for chunk jump." });
                }
            })();
        } else {
            sendResponse({ success: false, error: "No active session or invalid chunk index for jump." });
        }
        return true;
    }

    if (request.action === "toggleAutoAdvance") {
        const oldAutoAdvanceState = currentTTSSession.autoAdvanceToNextPage;
        currentTTSSession.autoAdvanceToNextPage = request.enable;
        saveCurrentSession();
        console.log("[SW] Auto-advance toggled to:", currentTTSSession.autoAdvanceToNextPage);
        sendResponse({ success: true, autoAdvanceEnabled: currentTTSSession.autoAdvanceToNextPage });

        if (currentTTSSession.autoAdvanceToNextPage && !oldAutoAdvanceState &&
            currentTTSSession.isActive &&
            currentTTSSession.chunks.length > 1 &&
            currentTTSSession.currentIndex === currentTTSSession.chunks.length - 2 &&
            !currentTTSSession.isIdentifyingNextPage &&
            currentTTSSession.articleDetails.sourceTabId) {

            console.log("[SW] Auto-advance just enabled on second-to-last chunk. Proactively identifying next page URL.");
            identifyAndStoreNextPageUrl(currentTTSSession.articleDetails.sourceTabId, currentTTSSession.articleDetails.sourceUrl)
                .catch(e => console.error("[SW] Proactive identifyAndStoreNextPageUrl (on toggle) failed:", e));
        }

        if (ttsPopoutWindowId) {
            const comprehensiveArticleDetailsForToggle = {
                ...(currentTTSSession.articleDetails || {}),
                title: (currentTTSSession.articleDetails && currentTTSSession.articleDetails.title) ? currentTTSSession.articleDetails.title : (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 ? "Reading Content" : "No Active Content"),
                isChunk: currentTTSSession.chunks && currentTTSSession.chunks.length > 1,
                currentChunkIndex: currentTTSSession.currentIndex,
                totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
                chunks: currentTTSSession.chunks || [],
                isActiveSession: currentTTSSession.isActive,
                autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage,
                textContent: (currentTTSSession.isActive && currentTTSSession.chunks && currentTTSSession.chunks.length > currentTTSSession.currentIndex) ? currentTTSSession.chunks[currentTTSSession.currentIndex] : ""
            };

            chrome.runtime.sendMessage({
                action: "autoAdvanceStateChanged",
                enabled: currentTTSSession.autoAdvanceToNextPage,
                articleDetails: comprehensiveArticleDetailsForToggle
            }).catch(e => console.warn("Error sending autoAdvanceStateChanged to popup:", e.message));
        }
        return false;
    }


    if (request.action === "sessionFinishedCheckAutoAdvance") {
        (async () => {
            console.log("[SW] Received sessionFinishedCheckAutoAdvance. AutoAdvance:", currentTTSSession.autoAdvanceToNextPage, "IdentifyingNext:", currentTTSSession.isIdentifyingNextPage, "StoredNextURL:", (currentTTSSession.articleDetails ? currentTTSSession.articleDetails.nextPageUrlToVisit : 'N/A'));

            if (currentTTSSession.autoAdvanceToNextPage && currentTTSSession.articleDetails && currentTTSSession.articleDetails.sourceTabId) {
                let identifiedUrl = currentTTSSession.articleDetails.nextPageUrlToVisit;
                if (!identifiedUrl && !currentTTSSession.isIdentifyingNextPage) {
                    console.log("[SW] Next page URL not yet identified. Attempting to identify now.");
                    await identifyAndStoreNextPageUrl(currentTTSSession.articleDetails.sourceTabId, currentTTSSession.articleDetails.sourceUrl);
                    identifiedUrl = currentTTSSession.articleDetails.nextPageUrlToVisit;
                }

                if (identifiedUrl) {
                    console.log(`[SW] Navigating to stored/identified next page URL: ${identifiedUrl}`);
                    pendingTTSForTab[currentTTSSession.articleDetails.sourceTabId] = { isPending: true, url: identifiedUrl };

                    const sourceTabIdForNav = currentTTSSession.articleDetails.sourceTabId;

                    if (currentTTSSession.articleDetails) {
                        currentTTSSession.articleDetails.sourceUrl = identifiedUrl;
                        currentTTSSession.articleDetails.title = `Navigating to next page...`;
                        currentTTSSession.articleDetails.nextPageUrlToVisit = null;
                    }
                    currentTTSSession.chunks = [];
                    currentTTSSession.currentIndex = 0;
                    currentTTSSession.isActive = true;
                    currentTTSSession.isIdentifyingNextPage = false;

                    if (ttsPopoutWindowId) {
                        chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: true, navigating: true, url: identifiedUrl, message: `Navigating to next page...` })
                            .catch(e => console.warn("Error sending nextPageResult_Popup:", e.message));
                    }
                    saveCurrentSession();
                    await chrome.tabs.update(sourceTabIdForNav, { url: identifiedUrl });
                    sendResponse({ status: "Navigation to next page initiated" });

                } else if (currentTTSSession.isIdentifyingNextPage) {
                    console.log("[SW] Still identifying next page. Navigation will occur if successful.");
                    sendResponse({ status: "Identification in progress, will navigate if successful" });
                } else {
                    console.log("[SW] No next page URL could be identified. Auto-advance sequence ends.");
                    if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: "Could not identify a next page." });
                    resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
                    sendResponse({ status: "No next page identified, session ended" });
                }
            } else {
                console.log("[SW] Auto-advance is OFF or no source tab. Session truly ended.");
                resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
                sendResponse({ status: "Auto-advance not triggered, session ended" });
            }
        })();
        return true;
    }

    return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (pendingTTSForTab[tabId] && changeInfo.status === 'complete' && tab.url === pendingTTSForTab[tabId].url) {
        console.log(`[SW] Tab ${tabId} updated to ${tab.url} and matches pending TTS. Initiating read (continuation).`);
        const ttsPendingState = { ...pendingTTSForTab[tabId] };
        delete pendingTTSForTab[tabId];
        currentTTSSession.isIdentifyingNextPage = false;

        if (ttsPendingState.isPending) {
            const autoAdvanceForNewPage = currentTTSSession.autoAdvanceToNextPage;
            const result = await initiateTTSForPage(tabId, true);

            if (result.success) {
                currentTTSSession.autoAdvanceToNextPage = autoAdvanceForNewPage;
                saveCurrentSession();
            } else if (ttsPopoutWindowId) {
                chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: result.error || "Failed to read next page." })
                    .catch(e => console.warn("Error sending ttsErrorPopup for next page read failure:", e.message));
            }
        }
    } else if (pendingTTSForTab[tabId] && changeInfo.status === 'complete' && tab.url !== pendingTTSForTab[tabId].url) {
        console.warn(`[SW] Tab ${tabId} completed loading but URL ${tab.url} does not match pending TTS URL ${pendingTTSForTab[tabId].url}. Clearing pending flag.`);
        delete pendingTTSForTab[tabId];
        currentTTSSession.isIdentifyingNextPage = false;
        resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
        saveCurrentSession();
    } else if (changeInfo.status === 'loading' && pendingTTSForTab[tabId] && tabId === currentTTSSession.articleDetails?.sourceTabId) {
        if (tab.url !== pendingTTSForTab[tabId].url) {
            console.warn(`[SW] Monitored tab ${tabId} started loading a different URL (${tab.url}) than expected (${pendingTTSForTab[tabId].url}). Clearing pending TTS.`);
            delete pendingTTSForTab[tabId];
            currentTTSSession.isIdentifyingNextPage = false;
            resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
            saveCurrentSession();
        }
    }
});


chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (pendingTTSForTab[tabId]) {
        console.log(`[SW] Tab ${tabId} with pending TTS was removed. Clearing pending flag.`);
        delete pendingTTSForTab[tabId];
    }
    if (currentTTSSession.articleDetails && currentTTSSession.articleDetails.sourceTabId === tabId) {
        console.log(`[SW] Active TTS source tab ${tabId} was removed. Resetting session.`);
        resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
        if (ttsPopoutWindowId) {
            chrome.runtime.sendMessage({ action: "stopAndResetAudio", reason: "Source tab closed." })
                .catch(e => console.warn("Error sending stopAndResetAudio to popup on tab removal:", e.message));
        }
    }
    currentTTSSession.isIdentifyingNextPage = false;
    saveCurrentSession();
});


console.log("[SW] Event listeners registered. Initial AutoAdvance:", currentTTSSession.autoAdvanceToNextPage);
