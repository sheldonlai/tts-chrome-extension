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
    articleDetails: { // Will store title, sourceTabId, sourceUrl, etc.
        sourceTabId: null,
        sourceUrl: null,
        // Other properties like title, simplifiedHtml, excerpt will be added dynamically
    },
    currentIndex: 0,
    isActive: false, // Overall session active status
    isPlayingInPopup: false,
    prefetchedAudioDataUrlForNext: null,
    isCurrentlyPrefetching: false,
    autoAdvanceToNextPage: false
};

let pendingTTSForTab = {}; // { tabId: { isPending: true, url: "expectedUrl" } }

async function saveCurrentSession() {
    if (currentTTSSession.isActive || (currentTTSSession.chunks && currentTTSSession.chunks.length > 0)) {
        try {
            const articleDetailsToSave = { ...currentTTSSession.articleDetails };
            const sessionToSave = {
                chunks: currentTTSSession.chunks,
                articleDetails: articleDetailsToSave,
                currentIndex: currentTTSSession.currentIndex,
                isActive: currentTTSSession.isActive,
                autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage
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
            currentTTSSession.articleDetails = persistedData.articleDetails || { sourceTabId: null, sourceUrl: null };
            if (!currentTTSSession.articleDetails.chunks || currentTTSSession.articleDetails.chunks.length === 0) {
                if (persistedData.chunks) currentTTSSession.articleDetails.chunks = persistedData.chunks;
            }
            currentTTSSession.currentIndex = typeof persistedData.currentIndex === 'number' ? persistedData.currentIndex : 0;
            currentTTSSession.isActive = persistedData.isActive || false;
            currentTTSSession.autoAdvanceToNextPage = persistedData.autoAdvanceToNextPage || false;

            currentTTSSession.isPlayingInPopup = false;
            currentTTSSession.isCurrentlyPrefetching = false;
            currentTTSSession.prefetchedAudioDataUrlForNext = null;

            console.log("[SW] Loaded persisted session. Active:", currentTTSSession.isActive, "AutoAdvance:", currentTTSSession.autoAdvanceToNextPage, "TabID:", currentTTSSession.articleDetails.sourceTabId);
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
        },
        currentIndex: 0,
        isActive: false,
        isPlayingInPopup: false,
        prefetchedAudioDataUrlForNext: null,
        isCurrentlyPrefetching: false,
        autoAdvanceToNextPage: autoAdvanceState
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
                ...currentTTSSession.articleDetails, // Keeps sourceTabId, sourceUrl
                ...responseFromContent.data // Adds title, excerpt, simplifiedHtml etc.
            };
            // Ensure articleDetails also has a reference to chunks if not already there from responseFromContent.data
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
                attemptToPrefetchNextChunk();
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
    if (!currentTTSSession.isActive || !currentTTSSession.chunks || chunkIndex >= currentTTSSession.chunks.length) {
        if (chunkIndex >= (currentTTSSession.chunks ? currentTTSSession.chunks.length : 0) && currentTTSSession.isActive) {
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" }).catch(e => console.warn("Error sending allChunksFinished:", e.message));

            if (currentTTSSession.autoAdvanceToNextPage && currentTTSSession.articleDetails.sourceTabId) {
                console.log("[SW] Session ended, auto-advance is ON. Attempting to find next page.");
                await findAndNavigateToNextPage(currentTTSSession.articleDetails.sourceTabId, currentTTSSession.articleDetails.sourceUrl);
            } else {
                console.log("[SW] Session ended. Auto-advance OFF or no source tab. Resetting session.");
                resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
            }
        } else {
            resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
        }
        return;
    }

    const chunkText = currentTTSSession.chunks[chunkIndex];
    const isLastChunk = chunkIndex === currentTTSSession.chunks.length - 1;
    currentTTSSession.currentIndex = chunkIndex;
    currentTTSSession.isPlayingInPopup = true;

    if (!currentTTSSession.articleDetails) currentTTSSession.articleDetails = {};
    // Ensure articleDetails contains the chunks array for reference in the popup
    currentTTSSession.articleDetails.chunks = currentTTSSession.chunks;
    saveCurrentSession();

    // Construct comprehensive details for this specific chunk, including overall session state
    const articleDetailsForChunk = {
        ...(currentTTSSession.articleDetails), // Base details like title, simplifiedHtml, sourceUrl etc.
        textContent: chunkText, // Specific text for this chunk
        isChunk: currentTTSSession.chunks.length > 1,
        currentChunkIndex: chunkIndex,
        totalChunks: currentTTSSession.chunks.length,
        isLastChunk: isLastChunk,
        // isActiveSession: currentTTSSession.isActive, // Let popup derive this or manage its own view state
        autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage // Pass current auto-advance state
    };

    chrome.runtime.sendMessage({
        action: "processTextForTTS",
        selectedText: chunkText,
        articleDetails: articleDetailsForChunk // Send the comprehensive details for this chunk
    }, response => {
        if (chrome.runtime.lastError) {
            console.warn(`[SW] Error sending 'processTextForTTS' for chunk ${chunkIndex} to popout:`, chrome.runtime.lastError.message);
            currentTTSSession.isPlayingInPopup = false;
            saveCurrentSession();
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
        const cacheKey = typeof generateAudioCacheKey === 'function' ? generateAudioCacheKey(textToPrefetch) : AUDIO_CACHE_PREFIX + textToPrefetch.substring(0, 50);

        const cachedItem = await chrome.storage.local.get([cacheKey]);
        if (cachedItem[cacheKey]) {
            currentTTSSession.prefetchedAudioDataUrlForNext = cachedItem[cacheKey];
            return;
        }
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
                }
            }
        } catch (error) {
            console.error(`[SW] Error during prefetch for chunk index ${nextChunkToPrefetchIndex}:`, error);
        } finally {
            currentTTSSession.isCurrentlyPrefetching = false;
        }
    } else {
        currentTTSSession.prefetchedAudioDataUrlForNext = null;
    }
}

async function findAndNavigateToNextPage(sourceTabId, currentSourceUrl) {
    if (!sourceTabId) {
        console.warn("[SW] findAndNavigateToNextPage called without sourceTabId.");
        if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: "Original tab information lost." });
        return;
    }
    console.log(`[SW] Finding next page for tab ${sourceTabId} (current URL: ${currentSourceUrl})`);
    try {
        const tab = await chrome.tabs.get(sourceTabId);
        if (!tab || tab.url !== currentSourceUrl) {
            console.warn(`[SW] Tab ${sourceTabId} URL changed or tab closed. Current: ${tab ? tab.url : 'N/A'}. Expected: ${currentSourceUrl}. Aborting next page.`);
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: "Original page context changed." });
            resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
            return;
        }

        const linksResponse = await chrome.tabs.sendMessage(sourceTabId, { action: "extractPageLinks" });
        if (!linksResponse || !linksResponse.success || !linksResponse.data) {
            console.error("[SW] Failed to extract page links from content script:", linksResponse ? linksResponse.error : "No response");
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: (linksResponse && linksResponse.error) || "Could not extract links." });
            return;
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
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: `API Error: ${apiFetchResponse.status}` });
            return;
        }

        const nextPageData = await apiFetchResponse.json();
        console.log("[SW] Received from next page API:", nextPageData);

        if (nextPageData.nextLinkFound && nextPageData.nextLinkUrl) {
            console.log(`[SW] Next page found: ${nextPageData.nextLinkUrl}. Navigating tab ${sourceTabId}.`);
            pendingTTSForTab[sourceTabId] = { isPending: true, url: nextPageData.nextLinkUrl };

            if (currentTTSSession.articleDetails) {
                currentTTSSession.articleDetails.sourceUrl = nextPageData.nextLinkUrl;
                currentTTSSession.articleDetails.title = `Navigating to: ${nextPageData.nextLinkText || "Next Page"}`;
            }
            currentTTSSession.chunks = [];
            currentTTSSession.currentIndex = 0;
            currentTTSSession.isActive = true;
            saveCurrentSession();

            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: true, navigating: true, url: nextPageData.nextLinkUrl, message: `Navigating to: ${nextPageData.nextLinkText || nextPageData.nextLinkUrl}` });
            await chrome.tabs.update(sourceTabId, { url: nextPageData.nextLinkUrl });
        } else {
            console.log("[SW] No next page link found by API. Reasoning:", nextPageData.reasoning);
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: nextPageData.reasoning || "No next page identified." });
            resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
        }
    } catch (error) {
        console.error("[SW] Error in findAndNavigateToNextPage:", error);
        if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "nextPageResult_Popup", success: false, navigating: false, reasoning: `Error: ${error.message}` });
        resetTTSSession(true, currentTTSSession.autoAdvanceToNextPage);
    }
}


// --- Context Menu Handler ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "processTextForTTS_ContextMenu" && info.selectionText) {
        console.log("[SW] Context menu: 'Read selected text'. Tab ID:", tab.id);
        const previousAutoAdvance = currentTTSSession.autoAdvanceToNextPage;
        await clearPersistedSession();
        resetTTSSession(false, true);
        currentTTSSession.autoAdvanceToNextPage = previousAutoAdvance;

        const selectedText = info.selectionText.trim();
        const titleSnippet = selectedText.substring(0, SELECTED_TEXT_TITLE_LENGTH) +
            (selectedText.length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");

        currentTTSSession.chunks = [selectedText];
        currentTTSSession.articleDetails = { // Reset and repopulate articleDetails
            title: titleSnippet,
            textContent: selectedText, // For single chunk, textContent is the chunk itself
            simplifiedHtml: `<p>${selectedText.replace(/\n/g, '</p><p>')}</p>`,
            excerpt: selectedText.substring(0, 150) + (selectedText.length > 150 ? "..." : ""),
            length: selectedText.length,
            chunks: [selectedText], // Explicitly set chunks here too
            sourceTabId: tab.id,
            sourceUrl: tab.url
            // autoAdvanceToNextPage will be set from currentTTSSession shortly
        };
        currentTTSSession.currentIndex = 0;
        currentTTSSession.isActive = true;
        // autoAdvanceToNextPage is already preserved in currentTTSSession

        try {
            await openOrFocusTTSPopout();
            if (ttsPopoutWindowId) {
                await new Promise(resolve => setTimeout(resolve, 700));
                processAndSendChunkToPopup(currentTTSSession.currentIndex); // This will use the updated currentTTSSession
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
    // console.log("[SW] Message received. Action:", request.action);

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
        const requestedChunkIndex = currentTTSSession.isActive && currentTTSSession.chunks ? currentTTSSession.chunks.indexOf(textToSynth) : -1;
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
                const isLastChunkForThisAudio = currentTTSSession.isActive ? (requestedChunkIndex === currentTTSSession.chunks.length - 1) : true;

                // Use the originalArticleDetails passed from the popup if available, otherwise construct from currentTTSSession
                const baseDetails = request.originalArticleDetails || currentTTSSession.articleDetails || {};
                const articleDetailsForThisChunk = {
                    ...baseDetails,
                    title: baseDetails.title || "Reading Page Content",
                    textContent: textToSynth,
                    isChunk: (request.originalArticleDetails && request.originalArticleDetails.isChunk !== undefined) ? request.originalArticleDetails.isChunk : (currentTTSSession.isActive && currentTTSSession.chunks.length > 1),
                    currentChunkIndex: requestedChunkIndex !== -1 ? requestedChunkIndex : (currentTTSSession.isActive ? currentTTSSession.currentIndex : 0),
                    totalChunks: (request.originalArticleDetails && request.originalArticleDetails.chunks) ? request.originalArticleDetails.chunks.length : (currentTTSSession.isActive ? currentTTSSession.chunks.length : 1),
                    isLastChunk: isLastChunkForThisAudio,
                    chunks: (request.originalArticleDetails && request.originalArticleDetails.chunks) ? request.originalArticleDetails.chunks : (currentTTSSession.isActive ? currentTTSSession.chunks : [textToSynth]),
                    autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage // Always use current session's autoAdvance
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
                if (currentTTSSession.isActive && requestedChunkIndex !== -1 && requestedChunkIndex === currentTTSSession.currentIndex) {
                    attemptToPrefetchNextChunk();
                }
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
            if (nextIndexToPlay < currentTTSSession.chunks.length) {
                currentTTSSession.currentIndex = nextIndexToPlay;
                currentTTSSession.isPlayingInPopup = true;
                if (currentTTSSession.prefetchedAudioDataUrlForNext && currentTTSSession.chunks[currentTTSSession.currentIndex]) {
                    const textOfPrefetchedChunk = currentTTSSession.chunks[currentTTSSession.currentIndex];
                    const isLastChunkForPrefetched = currentTTSSession.currentIndex === currentTTSSession.chunks.length - 1;
                    const articleDetailsForPrefetchedChunk = {
                        ...(currentTTSSession.articleDetails || {}),
                        title: (currentTTSSession.articleDetails && currentTTSSession.articleDetails.title) || "Reading Page Content",
                        textContent: textOfPrefetchedChunk,
                        isChunk: true,
                        currentChunkIndex: currentTTSSession.currentIndex,
                        totalChunks: currentTTSSession.chunks.length,
                        isLastChunk: isLastChunkForPrefetched,
                        chunks: currentTTSSession.chunks,
                        autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage
                    };
                    if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "playAudioDataUrl", audioDataUrl: currentTTSSession.prefetchedAudioDataUrlForNext, originalText: textOfPrefetchedChunk, articleDetails: articleDetailsForPrefetchedChunk }).catch(e => { });
                    currentTTSSession.prefetchedAudioDataUrlForNext = null;
                    sendResponse({ status: "sentPrefetchedAudio", nextIndex: currentTTSSession.currentIndex });
                    attemptToPrefetchNextChunk();
                } else {
                    processAndSendChunkToPopup(currentTTSSession.currentIndex);
                    sendResponse({ status: "processingNextChunk", nextIndex: currentTTSSession.currentIndex });
                }
            } else {
                // All chunks finished, logic moved to processAndSendChunkToPopup
            }
        } else {
            sendResponse({ status: "noActiveSession" });
        }
        return true;
    }

    if (request.action === "requestInitialSessionState") {
        // Construct a comprehensive articleDetails for the popup
        const comprehensiveArticleDetailsForPopup = {
            ...(currentTTSSession.articleDetails || {}),
            title: (currentTTSSession.articleDetails && currentTTSSession.articleDetails.title) ? currentTTSSession.articleDetails.title : (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 ? "Reading Content" : "No Active Content"),
            isChunk: currentTTSSession.chunks && currentTTSSession.chunks.length > 1,
            currentChunkIndex: currentTTSSession.currentIndex, // This is on currentTTSSession directly
            totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
            chunks: currentTTSSession.chunks || [],
            isActiveSession: currentTTSSession.isActive, // This is the overall session active status
            autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage,
            // Add textContent for the current chunk if active
            textContent: (currentTTSSession.isActive && currentTTSSession.chunks && currentTTSSession.chunks.length > currentTTSSession.currentIndex) ? currentTTSSession.chunks[currentTTSSession.currentIndex] : ""
        };

        const sessionDataForPopup = {
            isActive: currentTTSSession.isActive,
            currentIndex: currentTTSSession.currentIndex, // Redundant if in comprehensiveArticleDetailsForPopup.currentChunkIndex
            chunks: currentTTSSession.chunks, // Redundant if in comprehensiveArticleDetailsForPopup.chunks
            articleDetails: comprehensiveArticleDetailsForPopup,
        };
        sendResponse({ action: "activeSessionState", sessionData: sessionDataForPopup });
        return false;
    }


    if (request.action === "resumeTTSSession" && typeof request.resumeFromChunkIndex === 'number') {
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
        currentTTSSession.autoAdvanceToNextPage = request.enable;
        saveCurrentSession();
        console.log("[SW] Auto-advance toggled to:", currentTTSSession.autoAdvanceToNextPage);
        sendResponse({ success: true, autoAdvanceEnabled: currentTTSSession.autoAdvanceToNextPage });

        if (ttsPopoutWindowId) {
            // Construct a comprehensive articleDetails object for the popup
            const comprehensiveArticleDetailsForToggle = {
                ...(currentTTSSession.articleDetails || {}),
                title: (currentTTSSession.articleDetails && currentTTSSession.articleDetails.title) ? currentTTSSession.articleDetails.title : (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 ? "Reading Content" : "No Active Content"),
                isChunk: currentTTSSession.chunks && currentTTSSession.chunks.length > 1,
                currentChunkIndex: currentTTSSession.currentIndex,
                totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
                chunks: currentTTSSession.chunks || [],
                isActiveSession: currentTTSSession.isActive, // CRITICAL: Include current session's active status
                autoAdvanceToNextPage: currentTTSSession.autoAdvanceToNextPage, // The new state
                sourceTabId: currentTTSSession.articleDetails ? currentTTSSession.articleDetails.sourceTabId : null,
                sourceUrl: currentTTSSession.articleDetails ? currentTTSSession.articleDetails.sourceUrl : null,
                simplifiedHtml: currentTTSSession.articleDetails ? currentTTSSession.articleDetails.simplifiedHtml : null,
                excerpt: currentTTSSession.articleDetails ? currentTTSSession.articleDetails.excerpt : null,
                length: currentTTSSession.articleDetails ? currentTTSSession.articleDetails.length : 0,
                textContent: (currentTTSSession.chunks && currentTTSSession.chunks.length > currentTTSSession.currentIndex) ? currentTTSSession.chunks[currentTTSSession.currentIndex] : ""
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
            console.log("[SW] Received sessionFinishedCheckAutoAdvance. Current autoAdvance state:", currentTTSSession.autoAdvanceToNextPage);
            if (currentTTSSession.autoAdvanceToNextPage && currentTTSSession.articleDetails && currentTTSSession.articleDetails.sourceTabId) {
                console.log("[SW] Auto-advance is ON. Attempting to find next page for tab:", currentTTSSession.articleDetails.sourceTabId);
                await findAndNavigateToNextPage(currentTTSSession.articleDetails.sourceTabId, currentTTSSession.articleDetails.sourceUrl);
                sendResponse({ status: "Auto-advance triggered" });
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

        if (ttsPendingState.isPending) {
            const result = await initiateTTSForPage(tabId, true);
            if (!result.success && ttsPopoutWindowId) {
                chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: result.error || "Failed to read next page." })
                    .catch(e => console.warn("Error sending ttsErrorPopup for next page read failure:", e.message));
            }
        }
    } else if (pendingTTSForTab[tabId] && changeInfo.status === 'complete' && tab.url !== pendingTTSForTab[tabId].url) {
        console.warn(`[SW] Tab ${tabId} completed loading but URL ${tab.url} does not match pending TTS URL ${pendingTTSForTab[tabId].url}. Clearing flag.`);
        delete pendingTTSForTab[tabId];
    }
});

console.log("[SW] Event listeners registered. Initial AutoAdvance:", currentTTSSession.autoAdvanceToNextPage);
