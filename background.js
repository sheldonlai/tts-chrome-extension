// background.js

// Import shared utilities
try {
    importScripts('popup/cacheUtils.js'); // Assuming cacheUtils.js is in popup/
    // AUDIO_CACHE_PREFIX will be available globally here if cacheUtils.js defines it at the top level.
} catch (e) {
    console.error("Failed to import cacheUtils.js in background.js. Ensure path is correct.", e);
}


let ttsPopoutWindowId = null;
const PERSISTED_SESSION_KEY = 'persistedTTSSession';
const SELECTED_TEXT_TITLE_LENGTH = 400; // Define the length for the title snippet

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
        // console.log("[Service Worker] Saving current TTS session to storage. Index:", currentTTSSession.currentIndex, "Active:", currentTTSSession.isActive, "PlayingInPopup:", currentTTSSession.isPlayingInPopup);
        try {
            const sessionToSave = {
                chunks: currentTTSSession.chunks,
                articleDetails: currentTTSSession.articleDetails,
                currentIndex: currentTTSSession.currentIndex,
                isActive: currentTTSSession.isActive,
                // Do not save isPlayingInPopup, prefetchedAudioDataUrlForNext, isCurrentlyPrefetching
            };
            await chrome.storage.local.set({ [PERSISTED_SESSION_KEY]: sessionToSave });
        } catch (e) {
            console.error("[Service Worker] Error saving session to storage:", e);
        }
    } else {
        await clearPersistedSession(); // If not active and no chunks, clear persisted.
    }
}

async function loadPersistedSession() {
    try {
        const result = await chrome.storage.local.get([PERSISTED_SESSION_KEY]);
        const persistedData = result[PERSISTED_SESSION_KEY];

        if (persistedData && persistedData.chunks && persistedData.chunks.length > 0 && typeof persistedData.currentIndex === 'number') {
            currentTTSSession.chunks = persistedData.chunks;
            currentTTSSession.articleDetails = persistedData.articleDetails || {};
            // Ensure articleDetails.chunks is consistent if it was part of persistedData.articleDetails
            if (!currentTTSSession.articleDetails.chunks || currentTTSSession.articleDetails.chunks.length === 0) {
                currentTTSSession.articleDetails.chunks = persistedData.chunks;
            }
            currentTTSSession.currentIndex = persistedData.currentIndex;
            currentTTSSession.isActive = persistedData.isActive; // Restore active state

            // Reset transient states
            currentTTSSession.isPlayingInPopup = false;
            currentTTSSession.isCurrentlyPrefetching = false;
            currentTTSSession.prefetchedAudioDataUrlForNext = null;

            console.log("[Service Worker] Loaded persisted TTS session from storage. Index:", currentTTSSession.currentIndex, "Chunks:", currentTTSSession.chunks.length, "Active:", currentTTSSession.isActive);
        } else {
            console.log("[Service Worker] No valid/active session found in storage to load.");
            resetTTSSession(false); // Don't clear storage again if nothing was loaded
        }
    } catch (e) {
        console.error("[Service Worker] Error loading session from storage:", e);
        resetTTSSession(false); // Don't clear storage on load error
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

// Load session when service worker starts
loadPersistedSession();


function setupContextMenu() {
    chrome.contextMenus.remove("processTextForTTS_ContextMenu", () => {
        if (chrome.runtime.lastError) { /* Suppress error if menu item doesn't exist */ }
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
    // Initialize ttsHistory if it doesn't exist
    chrome.storage.local.get(['ttsHistory'], (result) => {
        if (!result.ttsHistory) {
            chrome.storage.local.set({ ttsHistory: [] });
        }
    });
    // On fresh install or update, clear any old persisted session to start clean
    if (details.reason === "install" || details.reason === "update") {
        clearPersistedSession(); // This also resets currentTTSSession via loadPersistedSession if it was empty
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
                // Window ID was stored, but window doesn't exist (e.g., closed by user)
                ttsPopoutWindowId = null;
            }
        } catch (e) {
            // Error likely means window doesn't exist
            console.warn("[Service Worker] Error getting existing window, assuming closed:", e.message);
            ttsPopoutWindowId = null;
        }
    }

    // If we're here, either ttsPopoutWindowId was null or the window didn't exist. Create a new one.
    try {
        const newWindow = await chrome.windows.create({
            url: popoutUrl, type: "popup", width: 400, height: 600, focused: true // Ensure it's focused
        });
        ttsPopoutWindowId = newWindow.id;
        console.log("[Service Worker] New TTS popout window created. ID:", ttsPopoutWindowId, "Height: 600");

        // Add a listener specifically for this window ID
        chrome.windows.onRemoved.addListener(function specificWindowRemovedListener(removedWindowId) {
            if (removedWindowId === ttsPopoutWindowId) {
                console.log("[Service Worker] TTS popout window (ID:", ttsPopoutWindowId, ") was closed.");
                ttsPopoutWindowId = null; // Reset the ID
                if (currentTTSSession.isActive) {
                    // If a session was active, mark it as paused (not playing in popup)
                    // but don't reset the whole session, just its playback state.
                    currentTTSSession.isPlayingInPopup = false;
                    saveCurrentSession(); // Persist this state change
                    console.log("[Service Worker] TTS session marked as paused due to popout close.");
                }
                // Important: Remove this specific listener to avoid memory leaks
                chrome.windows.onRemoved.removeListener(specificWindowRemovedListener);
            }
        });
        return ttsPopoutWindowId;
    } catch (winError) {
        console.error("[Service Worker] Error creating TTS popout window:", winError);
        ttsPopoutWindowId = null; // Ensure reset on error
        throw winError; // Re-throw to be handled by caller
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
        clearPersistedSession(); // This only clears the specific session key
    }
}

async function processAndSendChunkToPopup(chunkIndex) {
    if (!currentTTSSession.isActive || !currentTTSSession.chunks || chunkIndex >= currentTTSSession.chunks.length) {
        console.log("[Service Worker] Session not active or chunk index out of bounds for processing.",
            "Index:", chunkIndex, "Chunks length:", currentTTSSession.chunks ? currentTTSSession.chunks.length : 'N/A');
        if (chunkIndex >= (currentTTSSession.chunks ? currentTTSSession.chunks.length : 0) && currentTTSSession.isActive) {
            console.log("[Service Worker] All chunks processed for current session.");
            // Inform popup that all chunks are finished
            if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" }).catch(e => console.warn("Error sending allChunksFinished:", e.message));
        }
        resetTTSSession(); // This will also clear persisted session if it was the last chunk
        return;
    }

    const chunkText = currentTTSSession.chunks[chunkIndex];
    const isLastChunk = chunkIndex === currentTTSSession.chunks.length - 1;
    currentTTSSession.currentIndex = chunkIndex;
    currentTTSSession.isPlayingInPopup = true; // Assume it will play in popup

    // Ensure articleDetails has chunks array for consistency
    if (!currentTTSSession.articleDetails) currentTTSSession.articleDetails = {};
    currentTTSSession.articleDetails.chunks = currentTTSSession.chunks; // Make sure this is always up-to-date

    saveCurrentSession(); // Save state before sending to popup

    console.log(`[Service Worker] Processing chunk ${chunkIndex + 1}/${currentTTSSession.chunks.length} for popup: "${chunkText.substring(0, 50)}..."`);

    const articleDetailsForChunk = {
        title: currentTTSSession.articleDetails.title || "Reading Page Content",
        textContent: chunkText,
        isChunk: currentTTSSession.chunks.length > 1,
        currentChunkIndex: chunkIndex,
        totalChunks: currentTTSSession.chunks.length,
        isLastChunk: isLastChunk,
        // Pass other relevant details if available
        simplifiedHtml: currentTTSSession.articleDetails.simplifiedHtml,
        excerpt: currentTTSSession.articleDetails.excerpt,
        length: currentTTSSession.articleDetails.length,
        chunks: currentTTSSession.chunks // Send the full list of chunks
    };

    // Send to popup (which might be the same window or a different one)
    chrome.runtime.sendMessage({
        action: "processTextForTTS",
        selectedText: chunkText,
        articleDetails: articleDetailsForChunk
    }, response => {
        if (chrome.runtime.lastError) {
            console.warn(`[Service Worker] Error sending 'processTextForTTS' for chunk ${chunkIndex} to popout:`, chrome.runtime.lastError.message);
            // If error sending, assume it's not playing in popup
            currentTTSSession.isPlayingInPopup = false;
            saveCurrentSession(); // Update persisted state
        } else {
            console.log(`[Service Worker] 'processTextForTTS' for chunk ${chunkIndex} sent to popout. Popup response:`, response);
        }
    });
}

async function attemptToPrefetchNextChunk() {
    if (!currentTTSSession.isActive || currentTTSSession.isCurrentlyPrefetching) {
        return; // Don't prefetch if session isn't active or already prefetching
    }
    const nextChunkToPrefetchIndex = currentTTSSession.currentIndex + 1;

    if (nextChunkToPrefetchIndex < currentTTSSession.chunks.length) {
        const textToPrefetch = currentTTSSession.chunks[nextChunkToPrefetchIndex];
        // Check cache first (using the function from cacheUtils.js)
        const cacheKey = typeof generateAudioCacheKey === 'function' ? generateAudioCacheKey(textToPrefetch) : AUDIO_CACHE_PREFIX + textToPrefetch.substring(0, 50); // Fallback if not imported

        const cachedItem = await chrome.storage.local.get([cacheKey]);
        if (cachedItem[cacheKey]) {
            console.log(`[Service Worker] Audio for next chunk (index ${nextChunkToPrefetchIndex}) already in cache. Skipping prefetch.`);
            currentTTSSession.prefetchedAudioDataUrlForNext = cachedItem[cacheKey];
            return; // Already cached, no need to prefetch from server
        }

        console.log(`[Service Worker] Attempting to prefetch audio for chunk index ${nextChunkToPrefetchIndex} (display number ${nextChunkToPrefetchIndex + 1})`);
        currentTTSSession.isCurrentlyPrefetching = true;
        currentTTSSession.prefetchedAudioDataUrlForNext = null; // Clear any old prefetched data

        try {
            const ttsUrl = 'http://localhost:8080/synthesize'; // Make sure this is your actual TTS server URL
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
                    // Optionally, cache this prefetched audio now
                    // await chrome.storage.local.set({ [cacheKey]: currentTTSSession.prefetchedAudioDataUrlForNext });
                } else {
                    console.warn(`[Service Worker] Prefetch failed: Blob for chunk index ${nextChunkToPrefetchIndex} is invalid or empty.`);
                }
            } else {
                console.warn(`[Service Worker] Prefetch TTS server error for chunk index ${nextChunkToPrefetchIndex}: ${fetchResponse.status}`);
            }
        } catch (error) {
            console.error(`[Service Worker] Error during prefetch for chunk index ${nextChunkToPrefetchIndex}:`, error);
        } finally {
            currentTTSSession.isCurrentlyPrefetching = false; // Reset flag
        }
    } else {
        // No more chunks to prefetch
        currentTTSSession.prefetchedAudioDataUrlForNext = null;
    }
}


// --- Event and Message Listeners ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "processTextForTTS_ContextMenu" && info.selectionText) {
        console.log("[Service Worker] Context menu: 'Read selected text'.");
        await clearPersistedSession(); // Clear any old session
        resetTTSSession(false); // Reset current session state without clearing storage again

        const selectedText = info.selectionText.trim();
        const titleSnippet = selectedText.substring(0, SELECTED_TEXT_TITLE_LENGTH) +
            (selectedText.length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");

        currentTTSSession.chunks = [selectedText]; // Single chunk for selected text
        currentTTSSession.articleDetails = {
            title: titleSnippet,
            textContent: selectedText, // Full text for this single "chunk"
            simplifiedHtml: `<p>${selectedText.replace(/\n/g, '</p><p>')}</p>`, // Basic HTML representation
            excerpt: selectedText.substring(0, 150) + (selectedText.length > 150 ? "..." : ""),
            length: selectedText.length,
            chunks: [selectedText] // Explicitly set chunks here too
        };
        currentTTSSession.currentIndex = 0;
        currentTTSSession.isActive = true; // Mark session as active

        try {
            await openOrFocusTTSPopout(); // Open or focus the popout
            if (ttsPopoutWindowId) { // Ensure popout is open
                // Wait a brief moment for the popup to be ready (if newly created)
                await new Promise(resolve => setTimeout(resolve, 700)); // Adjust delay if needed
                processAndSendChunkToPopup(currentTTSSession.currentIndex); // Send the text to the popup
                // No prefetch needed for single selected text.
            } else { resetTTSSession(); /* If popout failed, reset */ }
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
        return true; // Indicates async response
    }

    if (request.action === "clearPersistedTTSSession_Background") {
        (async () => {
            await clearPersistedSession(); // Clears the main session key from storage.local
            resetTTSSession(false);      // Resets the in-memory currentTTSSession state
            console.log("[Service Worker] Persisted TTS session cleared by popup request.");

            // Clear all audio caches
            try {
                const allStorageItems = await chrome.storage.local.get(null);
                const cacheKeysToRemove = [];
                // AUDIO_CACHE_PREFIX should be available if cacheUtils.js was imported correctly
                const prefix = typeof AUDIO_CACHE_PREFIX !== 'undefined' ? AUDIO_CACHE_PREFIX : "tts_audio_cache_";

                for (const key in allStorageItems) {
                    if (key.startsWith(prefix)) {
                        cacheKeysToRemove.push(key);
                    }
                }
                if (cacheKeysToRemove.length > 0) {
                    await chrome.storage.local.remove(cacheKeysToRemove);
                    console.log("[Service Worker] Cleared audio cache items:", cacheKeysToRemove.length);
                } else {
                    console.log("[Service Worker] No audio cache items to clear.");
                }
            } catch (e) {
                console.error("[Service Worker] Error clearing audio cache:", e);
            }

            // Notify the popup that the session (and now caches) have been cleared
            if (ttsPopoutWindowId) { // Check if popup window is open
                chrome.runtime.sendMessage({ action: "sessionClearedByBackground" })
                    .catch(e => console.warn("Error sending sessionClearedByBackground to popup:", e.message));
            }
            sendResponse({ status: "persistedSessionAndCacheCleared" }); // Updated status
        })();
        return true; // Indicates async response
    }


    if (request.action === "getSimplifiedContentForTTS") {
        (async () => {
            await clearPersistedSession(); // Start fresh
            resetTTSSession(false);
            try {
                // Find the last focused normal window to get the active tab from
                const lastFocusedNormalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
                if (!lastFocusedNormalWindow) {
                    sendResponse({ success: false, error: "No suitable browser window found." }); return;
                }
                const [activeTab] = await chrome.tabs.query({ active: true, windowId: lastFocusedNormalWindow.id });

                if (activeTab && activeTab.id) {
                    // Prevent processing on restricted URLs
                    if (activeTab.url && (activeTab.url.startsWith("chrome://") || activeTab.url.startsWith("https://chrome.google.com/webstore"))) {
                        sendResponse({ success: false, error: "Cannot extract content from restricted pages." }); return;
                    }

                    const responseFromContent = await chrome.tabs.sendMessage(activeTab.id, { action: "extractReadablePageContent" });
                    if (responseFromContent && responseFromContent.success && responseFromContent.data && responseFromContent.data.textContentChunks) {
                        currentTTSSession.chunks = responseFromContent.data.textContentChunks;
                        currentTTSSession.articleDetails = responseFromContent.data; // Store all details from Readability
                        // Ensure articleDetails.chunks is consistent
                        if (!currentTTSSession.articleDetails.chunks) {
                            currentTTSSession.articleDetails.chunks = currentTTSSession.chunks;
                        }
                        // Ensure title is present, fallback if Readability didn't provide one
                        if (!currentTTSSession.articleDetails.title && currentTTSSession.chunks.length > 0) {
                            currentTTSSession.articleDetails.title = currentTTSSession.chunks[0].substring(0, SELECTED_TEXT_TITLE_LENGTH) +
                                (currentTTSSession.chunks[0].length > SELECTED_TEXT_TITLE_LENGTH ? "..." : "");
                        } else if (!currentTTSSession.articleDetails.title) {
                            currentTTSSession.articleDetails.title = "Page Content"; // Generic fallback
                        }

                        currentTTSSession.currentIndex = 0;
                        currentTTSSession.isActive = true;

                        await openOrFocusTTSPopout();
                        if (ttsPopoutWindowId) {
                            await new Promise(resolve => setTimeout(resolve, 700)); // Wait for popup
                            processAndSendChunkToPopup(currentTTSSession.currentIndex);
                            attemptToPrefetchNextChunk(); // Start prefetching the next one
                            sendResponse({ success: true, message: "Chunked content processing initiated." });
                        } else { resetTTSSession(); sendResponse({ success: false, error: "Could not open TTS popout." }); }
                    } else { sendResponse({ success: false, error: responseFromContent.error || "No valid chunked data received from content script." }); }
                } else { sendResponse({ success: false, error: "No active tab found." }); }
            } catch (error) { console.error("[SW] Error in 'getSimplifiedContentForTTS':", error); sendResponse({ success: false, error: error.message }); }
        })();
        return true; // Async
    }


    if (request.action === "fetchTTSFromServer" && request.textToSynthesize) {
        const textToSynth = request.textToSynthesize;
        // Determine the chunk index if this text is part of the current session
        const requestedChunkIndex = currentTTSSession.isActive && currentTTSSession.chunks ? currentTTSSession.chunks.indexOf(textToSynth) : -1;
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
                    // Send error to popup for display
                    if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: errorMessage }).catch(e => console.warn("Error sending ttsErrorPopup", e.message));
                    sendResponse({ success: false, error: errorMessage }); return;
                }
                const audioBlob = await fetchResponse.blob();
                if (!(audioBlob && audioBlob.size > 0)) {
                    const blobError = "Fetched audioBlob is not valid or is empty.";
                    if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: blobError }).catch(e => console.warn("Error sending ttsErrorPopup", e.message));
                    sendResponse({ success: false, error: blobError }); return;
                }
                const audioDataUrl = await blobToDataURL(audioBlob);
                console.log("[Service Worker] Sending audio to popup for playback.");

                // Prepare article details for this specific audio playback
                const isLastChunkForThisAudio = currentTTSSession.isActive ? (requestedChunkIndex === currentTTSSession.chunks.length - 1) : true;
                const articleDetailsForThisChunk = {
                    title: currentTTSSession.articleDetails.title || "Reading Page Content",
                    textContent: textToSynth,
                    isChunk: currentTTSSession.isActive && currentTTSSession.chunks.length > 1,
                    currentChunkIndex: requestedChunkIndex, // Can be -1 if not part of active session
                    totalChunks: currentTTSSession.isActive ? currentTTSSession.chunks.length : 1,
                    isLastChunk: isLastChunkForThisAudio,
                    chunks: currentTTSSession.isActive ? currentTTSSession.chunks : [textToSynth] // Provide chunks context
                };

                // Send audio to popup
                if (ttsPopoutWindowId) {
                    chrome.runtime.sendMessage({
                        action: "playAudioDataUrl",
                        audioDataUrl: audioDataUrl,
                        originalText: textToSynth,
                        articleDetails: articleDetailsForThisChunk // Send refined details
                    }).catch(e => console.warn("Error sending playAudioDataUrl to popup", e.message));
                }
                sendResponse({ success: true, message: "DataURL sent for playback." });

                // If this was the current chunk of an active session, try to prefetch next
                if (currentTTSSession.isActive && requestedChunkIndex !== -1 && requestedChunkIndex === currentTTSSession.currentIndex) {
                    attemptToPrefetchNextChunk();
                }

            } catch (error) {
                console.error("[SW] Error during 'fetchTTSFromServer':", error);
                if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "ttsErrorPopup", error: `Server fetch error: ${error.message}` }).catch(e => console.warn("Error sending ttsErrorPopup", e.message));
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Async
    }


    if (request.action === "requestNextAudioChunk") {
        console.log("[Service Worker] Received 'requestNextAudioChunk' from popup.");
        if (currentTTSSession.isActive) {
            const nextIndexToPlay = currentTTSSession.currentIndex + 1;

            if (nextIndexToPlay < currentTTSSession.chunks.length) {
                currentTTSSession.currentIndex = nextIndexToPlay; // Update current index
                currentTTSSession.isPlayingInPopup = true; // Assume it will play

                // Check if the next chunk's audio was prefetched
                if (currentTTSSession.prefetchedAudioDataUrlForNext &&
                    currentTTSSession.chunks[currentTTSSession.currentIndex]) { // Ensure chunk text exists

                    console.log(`[Service Worker] Using prefetched audio for chunk index ${currentTTSSession.currentIndex} (display ${currentTTSSession.currentIndex + 1})`);
                    const textOfPrefetchedChunk = currentTTSSession.chunks[currentTTSSession.currentIndex];
                    const isLastChunkForPrefetched = currentTTSSession.currentIndex === currentTTSSession.chunks.length - 1;
                    const articleDetailsForPrefetchedChunk = {
                        title: currentTTSSession.articleDetails.title || "Reading Page Content",
                        textContent: textOfPrefetchedChunk,
                        isChunk: true, // It's part of a chunked session
                        currentChunkIndex: currentTTSSession.currentIndex,
                        totalChunks: currentTTSSession.chunks.length,
                        isLastChunk: isLastChunkForPrefetched,
                        chunks: currentTTSSession.chunks
                    };
                    if (ttsPopoutWindowId) {
                        chrome.runtime.sendMessage({
                            action: "playAudioDataUrl",
                            audioDataUrl: currentTTSSession.prefetchedAudioDataUrlForNext,
                            originalText: textOfPrefetchedChunk,
                            articleDetails: articleDetailsForPrefetchedChunk
                        }).catch(e => console.warn("Error sending prefetched playAudioDataUrl to popup", e.message));
                    }
                    currentTTSSession.prefetchedAudioDataUrlForNext = null; // Consume the prefetched data
                    sendResponse({ status: "sentPrefetchedAudio", nextIndex: currentTTSSession.currentIndex });
                    attemptToPrefetchNextChunk(); // Prefetch the *next* next one
                } else {
                    // No prefetched audio, or text missing (should not happen if logic is correct)
                    // Tell popup to request it normally (which involves cache check then server fetch)
                    console.log(`[Service Worker] No prefetched audio for chunk index ${currentTTSSession.currentIndex}. Telling popup to request it.`);
                    processAndSendChunkToPopup(currentTTSSession.currentIndex); // This will trigger cache check in popup
                    sendResponse({ status: "processingNextChunk", nextIndex: currentTTSSession.currentIndex });
                    // attemptToPrefetchNextChunk() will be called after this chunk is processed/played if needed
                }
            } else {
                // All chunks finished
                console.log("[Service Worker] All chunks finished after requestNextAudioChunk.");
                if (ttsPopoutWindowId) chrome.runtime.sendMessage({ action: "allChunksFinished" }).catch(e => console.warn("Error sending allChunksFinished to popup", e.message));
                resetTTSSession(); // Reset session as it's complete
                sendResponse({ status: "allChunksFinished" });
            }
        } else {
            console.log("[Service Worker] No active TTS session for 'requestNextAudioChunk'.");
            sendResponse({ status: "noActiveSession" });
        }
        return true; // Async
    }


    if (request.action === "requestInitialSessionState") {
        console.log("[Service Worker] Popup requested initial session state.");
        // Prepare the article details to send, ensuring all relevant fields are present
        const articleDetailsForPopup = currentTTSSession.isActive
            ? {
                ...currentTTSSession.articleDetails, // Spread existing details
                chunks: currentTTSSession.chunks, // Ensure chunks array is included
                isChunk: currentTTSSession.chunks && currentTTSSession.chunks.length > 1,
                currentChunkIndex: currentTTSSession.currentIndex,
                totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
                // isPlaying: currentTTSSession.isPlayingInPopup // Could be useful for initial UI state
            }
            : null; // No active session, no details

        const sessionDataForPopup = {
            isActive: currentTTSSession.isActive,
            currentIndex: currentTTSSession.currentIndex,
            totalChunks: currentTTSSession.chunks ? currentTTSSession.chunks.length : 0,
            articleDetails: articleDetailsForPopup,
            // isPlayingInPopup: currentTTSSession.isPlayingInPopup // Send if popup needs to know if audio was playing
        };
        sendResponse({ action: "activeSessionState", sessionData: sessionDataForPopup });
        return false; // Synchronous response here is fine as data is in memory
    }


    if (request.action === "resumeTTSSession" && typeof request.resumeFromChunkIndex === 'number') {
        console.log("[Service Worker] Popup requested to resume session from chunk index:", request.resumeFromChunkIndex);
        if (currentTTSSession.chunks && currentTTSSession.chunks.length > 0 && request.resumeFromChunkIndex < currentTTSSession.chunks.length) {
            currentTTSSession.isActive = true; // Ensure session is marked active
            currentTTSSession.currentIndex = request.resumeFromChunkIndex; // Set the index to resume from

            (async () => {
                await openOrFocusTTSPopout(); // Ensure popup is open
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 300)); // Brief delay for popup readiness
                    processAndSendChunkToPopup(currentTTSSession.currentIndex); // Process the chunk to resume
                    sendResponse({ success: true, message: "Resuming session." });
                } else {
                    console.error("[Service Worker] Cannot resume, TTS popout window not available.");
                    resetTTSSession(); // Reset if popout cannot be opened
                    sendResponse({ success: false, error: "TTS window not available to resume." });
                }
            })();
        } else {
            console.warn("[Service Worker] Cannot resume: No valid session or invalid chunk index.");
            resetTTSSession(); // Reset if cannot resume
            sendResponse({ success: false, error: "No valid session to resume or invalid index." });
        }
        return true; // Async
    }

    if (request.action === "jumpToChunk" && typeof request.jumpToChunkIndex === 'number') {
        const jumpToIndex = request.jumpToChunkIndex;
        console.log(`[Service Worker] Popup requested to jump to chunk index: ${jumpToIndex}`);
        if (currentTTSSession.isActive && currentTTSSession.chunks && jumpToIndex >= 0 && jumpToIndex < currentTTSSession.chunks.length) {
            currentTTSSession.currentIndex = jumpToIndex;
            currentTTSSession.isPlayingInPopup = true; // Assume it will play
            // Reset prefetch state as we are jumping
            currentTTSSession.prefetchedAudioDataUrlForNext = null;
            currentTTSSession.isCurrentlyPrefetching = false;

            (async () => {
                await openOrFocusTTSPopout(); // Ensure popup is open
                if (ttsPopoutWindowId) {
                    await new Promise(resolve => setTimeout(resolve, 100)); // Shorter delay for jump
                    processAndSendChunkToPopup(currentTTSSession.currentIndex); // Process the target chunk
                    attemptToPrefetchNextChunk(); // Attempt to prefetch after this new current chunk
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
        return true; // Async
    }


    // Default: if no action matched, return false or nothing
    return false; // Indicates synchronous response or no response needed for unhandled actions
});

console.log("[Service Worker] Event listeners registered.");
