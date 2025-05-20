// popup.js (Main Orchestrator)

// Assumes uiHelpers.js functions (showLoader, hideLoader, updateSessionInfoDisplay, renderSessionQueue, setupCollapsibleLists) 
// are globally available because uiHelpers.js is loaded first in popup.html.
// Assumes AudioController and HistoryManager objects are globally available from their respective IIFE modules loaded in popup.html.

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const domElements = {
        audioPlayer: document.getElementById('popupAudioPlayer'),
        statusMessage: document.getElementById('statusMessage'),
        loadingIndicator: document.getElementById('loadingIndicator'),
        historyListElement: document.getElementById('historyList'),
        clearHistoryBtn: document.getElementById('clearHistoryBtn'),
        currentSessionInfoDiv: document.getElementById('currentSessionInfo'),
        currentSessionTitleSpan: document.getElementById('currentSessionTitle'),
        currentSessionChunkInfoSpan: document.getElementById('currentSessionChunkInfo'),
        resumeButton: document.getElementById('resumeButton'),
        sessionQueueContainer: document.getElementById('sessionQueueContainer'),
        sessionQueueList: document.getElementById('sessionQueueList'),
        toggleSessionQueueBtn: document.getElementById('toggleSessionQueue'),
        toggleHistoryListBtn: document.getElementById('toggleHistoryList')
    };

    // Shared State (passed as objects to allow modules to modify by reference)
    const sharedState = {
        isAudioPlaying: { value: false },
        currentPlayingText: { value: "" },
        currentArticleDetails: { value: null },
        isHandlingAudioError: { value: false },
        isCurrentlySeeking: { value: false }
    };

    console.log("[Popup Main] DOMContentLoaded. Initializing modules.");

    if (!domElements.audioPlayer || !domElements.statusMessage || !domElements.resumeButton) {
        console.error("[Popup Main] One or more critical UI elements not found! Check popup.html IDs.", domElements);
        if (domElements.statusMessage) domElements.statusMessage.textContent = "Error: Popup UI critical elements missing.";
        return;
    }
    domElements.statusMessage.textContent = "Popup ready.";
    if (domElements.currentSessionInfoDiv) domElements.currentSessionInfoDiv.style.display = 'none';
    if (domElements.resumeButton) domElements.resumeButton.style.display = 'none';
    if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';


    // Initialize Audio Controller
    if (typeof AudioController !== 'undefined' && typeof AudioController.init === 'function') {
        AudioController.init(
            { audioPlayer: domElements.audioPlayer, statusMessage: domElements.statusMessage },
            sharedState,
            {
                updateSessionInfoDisplay: () => updateSessionInfoDisplay(sharedState.currentArticleDetails.value, sharedState.isAudioPlaying.value),
                showLoader: showLoader,
                hideLoader: hideLoader,
                renderSessionQueue: () => {
                    if (sharedState.currentArticleDetails.value && sharedState.currentArticleDetails.value.isChunk) {
                        renderSessionQueue(
                            sharedState.currentArticleDetails.value.chunks,
                            sharedState.currentArticleDetails.value.currentChunkIndex,
                            handleChunkItemClick
                        );
                    } else if (domElements.sessionQueueContainer) {
                        domElements.sessionQueueContainer.style.display = 'none';
                    }
                }
            }
        );
    } else {
        console.error("[Popup Main] AudioController or its init function is not defined!");
    }

    // Initialize History Manager
    if (typeof HistoryManager !== 'undefined' && typeof HistoryManager.init === 'function') {
        HistoryManager.init(
            { historyListElement: domElements.historyListElement, clearHistoryBtn: domElements.clearHistoryBtn },
            {
                playAudioFromHistory: AudioController.playAudio,
                stopAndResetAudioPlayer: AudioController.stopAndResetAudioPlayer,
                showLoader: showLoader
            }
        );
    } else {
        console.error("[Popup Main] HistoryManager or its init function is not defined!");
    }

    if (typeof setupCollapsibleLists === 'function') {
        setupCollapsibleLists();
    } else {
        console.error("[Popup Main] setupCollapsibleLists function not found (expected from uiHelpers.js).");
    }

    function handleChunkItemClick(chunkIndex) {
        console.log(`[Popup Main] Chunk item ${chunkIndex + 1} clicked.`);
        const details = sharedState.currentArticleDetails.value;
        if (details && details.isActiveSession && typeof chunkIndex === 'number' && details.chunks && chunkIndex < details.chunks.length) {
            showLoader(`Jumping to chunk ${chunkIndex + 1}...`);
            AudioController.stopAndResetAudioPlayer("Changing chunk...");

            chrome.runtime.sendMessage({
                action: "jumpToChunk",
                jumpToChunkIndex: chunkIndex
            }, response => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Main] Error sending jumpToChunk:", chrome.runtime.lastError.message);
                    domElements.statusMessage.textContent = "Error changing chunk.";
                    hideLoader();
                    updateSessionInfoDisplay(details, sharedState.isAudioPlaying.value);
                } else {
                    console.log("[Popup Main] jumpToChunk request sent. Response:", response);
                }
            });
        } else {
            console.warn("[Popup Main] Cannot handle chunk item click. Invalid state or chunkIndex.", details, chunkIndex);
        }
    }

    // --- Message Handling ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("[Popup Main] Message received:", request);
        const detailsRef = sharedState.currentArticleDetails;

        if (request.action === "stopAndResetAudio") {
            console.log("[Popup Main] Received 'stopAndResetAudio' command.");
            AudioController.stopAndResetAudioPlayer("Audio stopped. Ready for new input.");
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            sendResponse({ status: "Audio player reset" });
            return false;
        }

        if (request.action === "activeSessionState") {
            console.log("[Popup Main] Received 'activeSessionState':", request.sessionData);
            if (request.sessionData && request.sessionData.isActive) {
                detailsRef.value = request.sessionData.articleDetails;
                if (detailsRef.value) {
                    detailsRef.value.isActiveSession = true;
                    detailsRef.value.currentChunkIndex = request.sessionData.currentIndex;
                    detailsRef.value.chunks = request.sessionData.chunks || (detailsRef.value.chunks || []);
                    detailsRef.value.totalChunks = detailsRef.value.chunks.length;
                    detailsRef.value.isLastChunk = (detailsRef.value.currentChunkIndex === (detailsRef.value.chunks.length > 0 ? detailsRef.value.chunks.length - 1 : 0));

                    console.log("[Popup Main] Restored active session details for UI:", detailsRef.value);
                    if (detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                        renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
                    } else if (domElements.sessionQueueContainer) {
                        domElements.sessionQueueContainer.style.display = 'none';
                    }
                } else {
                    console.warn("[Popup Main] Active session reported, but articleDetails missing in sessionData.");
                    detailsRef.value = { isActiveSession: true, isChunk: false, title: "Active Session (Details Missing)" };
                    if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
                }
            } else {
                console.log("[Popup Main] No active session reported by background on load.");
                detailsRef.value = { isActiveSession: false };
                if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            }
            updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
            sendResponse({ status: "Session state received by popup" });
            return false;
        }

        if (request.action === "processTextForTTS" && request.selectedText) {
            AudioController.stopAndResetAudioPlayer("Processing new text/chunk...");
            const textToProcess = request.selectedText;
            detailsRef.value = request.articleDetails;
            detailsRef.value.isActiveSession = true;
            sharedState.currentPlayingText.value = textToProcess;

            console.log(`[Popup Main] 'processTextForTTS' for: "${textToProcess.substring(0, 50)}..."`, "Details:", detailsRef.value);
            showLoader(detailsRef.value && detailsRef.value.isChunk ? `Loading chunk ${detailsRef.value.currentChunkIndex + 1}...` : "Checking cache...");

            if (detailsRef.value && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
            } else if (domElements.sessionQueueContainer) {
                domElements.sessionQueueContainer.style.display = 'none';
            }

            const normalizedText = textToProcess.trim();
            const cacheKey = generateAudioCacheKey(normalizedText);

            chrome.storage.local.get([cacheKey], (result) => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Main] Error getting from storage:", chrome.runtime.lastError.message);
                    domElements.statusMessage.textContent = "Storage error. Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText, originalArticleDetails: detailsRef.value });
                    sendResponse({ status: "Storage error, fetching from server" });
                    return;
                }
                if (result[cacheKey]) { // Cache Hit
                    console.log("[Popup Main] Cache hit for chunk:", normalizedText.substring(0, 30) + "...");
                    AudioController.playAudio(result[cacheKey], normalizedText, detailsRef.value);

                    // **FIX: Add to history when playing from cache**
                    let historyDisplayTitle;
                    const HISTORY_ITEM_TARGET_LENGTH = 56;
                    const CHUNK_SUFFIX_APPROX_LENGTH = 10;
                    const genericTitles = ["Reading Page Content", "Selected Text", "Page Content", "Untitled Page"];

                    if (detailsRef.value && detailsRef.value.isChunk) {
                        let baseDisplayPart;
                        const isTitleGeneric = !detailsRef.value.title || genericTitles.includes(detailsRef.value.title);
                        const totalChunks = detailsRef.value.totalChunks != null ? detailsRef.value.totalChunks : 0;
                        if (totalChunks > 1) {
                            let maxBaseLength = HISTORY_ITEM_TARGET_LENGTH - CHUNK_SUFFIX_APPROX_LENGTH;
                            if (maxBaseLength < 15) maxBaseLength = 15;
                            if (!isTitleGeneric) baseDisplayPart = detailsRef.value.title;
                            else baseDisplayPart = normalizedText; // Use chunk text for generic titles
                            if (baseDisplayPart.length > maxBaseLength) baseDisplayPart = baseDisplayPart.substring(0, maxBaseLength).trim() + "...";
                            const chunkNumber = detailsRef.value.currentChunkIndex != null ? detailsRef.value.currentChunkIndex + 1 : '';
                            historyDisplayTitle = `${baseDisplayPart} (${chunkNumber}/${totalChunks})`;
                        } else {
                            if (!isTitleGeneric) baseDisplayPart = detailsRef.value.title;
                            else baseDisplayPart = normalizedText;
                            if (baseDisplayPart.length > HISTORY_ITEM_TARGET_LENGTH) baseDisplayPart = baseDisplayPart.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                            historyDisplayTitle = baseDisplayPart;
                        }
                    } else {
                        let titleToUse = (detailsRef.value && detailsRef.value.title && detailsRef.value.title !== "Selected Text") ? detailsRef.value.title : normalizedText;
                        if (titleToUse.length > HISTORY_ITEM_TARGET_LENGTH) titleToUse = titleToUse.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                        historyDisplayTitle = titleToUse;
                    }
                    HistoryManager.addHistoryItemToDOM(normalizedText, result[cacheKey], true, historyDisplayTitle);
                    // End of FIX

                    sendResponse({ status: "Playing chunk from cache" });
                } else { // Cache Miss
                    console.log("[Popup Main] Cache miss for chunk:", normalizedText.substring(0, 30) + "...", ". Requesting from background.");
                    domElements.statusMessage.textContent = detailsRef.value && detailsRef.value.isChunk ? `Fetching chunk ${detailsRef.value.currentChunkIndex + 1}...` : "Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText, originalArticleDetails: detailsRef.value });
                    sendResponse({ status: "Cache miss, fetching chunk from server" });
                }
            });
            return true;

        } else if (request.action === "playAudioDataUrl" && request.audioDataUrl && request.originalText) {
            console.log("[Popup Main] 'playAudioDataUrl' for:", request.originalText.substring(0, 50) + "...", "Received articleDetails:", request.articleDetails);
            detailsRef.value = request.articleDetails;
            detailsRef.value.isActiveSession = true;
            sharedState.currentPlayingText.value = request.originalText;

            AudioController.playAudio(request.audioDataUrl, request.originalText, detailsRef.value);

            if (detailsRef.value && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
            } else if (domElements.sessionQueueContainer) {
                domElements.sessionQueueContainer.style.display = 'none';
            }

            const cacheKey = generateAudioCacheKey(request.originalText);
            chrome.storage.local.set({ [cacheKey]: request.audioDataUrl }, () => {
                if (chrome.runtime.lastError) { console.error("Error saving to audio cache", chrome.runtime.lastError.message); }
                else { console.log("Audio data cached for key:", cacheKey); }
            });

            let historyDisplayTitle;
            const HISTORY_ITEM_TARGET_LENGTH = 56;
            const CHUNK_SUFFIX_APPROX_LENGTH = 10;
            const genericTitles = ["Reading Page Content", "Selected Text", "Page Content", "Untitled Page"];
            if (detailsRef.value && detailsRef.value.isChunk) {
                let baseDisplayPart;
                const isTitleGeneric = !detailsRef.value.title || genericTitles.includes(detailsRef.value.title);
                const totalChunks = detailsRef.value.totalChunks != null ? detailsRef.value.totalChunks : 0;
                if (totalChunks > 1) {
                    let maxBaseLength = HISTORY_ITEM_TARGET_LENGTH - CHUNK_SUFFIX_APPROX_LENGTH;
                    if (maxBaseLength < 15) maxBaseLength = 15;
                    if (!isTitleGeneric) baseDisplayPart = detailsRef.value.title;
                    else baseDisplayPart = request.originalText;
                    if (baseDisplayPart.length > maxBaseLength) baseDisplayPart = baseDisplayPart.substring(0, maxBaseLength).trim() + "...";
                    const chunkNumber = detailsRef.value.currentChunkIndex != null ? detailsRef.value.currentChunkIndex + 1 : '';
                    historyDisplayTitle = `${baseDisplayPart} (${chunkNumber}/${totalChunks})`;
                } else {
                    if (!isTitleGeneric) baseDisplayPart = detailsRef.value.title;
                    else baseDisplayPart = request.originalText;
                    if (baseDisplayPart.length > HISTORY_ITEM_TARGET_LENGTH) baseDisplayPart = baseDisplayPart.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                    historyDisplayTitle = baseDisplayPart;
                }
            } else {
                let titleToUse = (detailsRef.value && detailsRef.value.title && detailsRef.value.title !== "Selected Text") ? detailsRef.value.title : request.originalText;
                if (titleToUse.length > HISTORY_ITEM_TARGET_LENGTH) titleToUse = titleToUse.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                historyDisplayTitle = titleToUse;
            }
            HistoryManager.addHistoryItemToDOM(request.originalText, request.audioDataUrl, true, historyDisplayTitle);
            sendResponse({ status: "Audio received and playing, caching attempt made" });
            return false;

        } else if (request.action === "ttsErrorPopup") {
            console.error("[Popup Main] 'ttsErrorPopup' action received:", request.error);
            AudioController.stopAndResetAudioPlayer(`Error: ${request.error}`);
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            sendResponse({ status: "Error message acknowledged" });
            return false;
        } else if (request.action === "allChunksFinished") {
            console.log("[Popup Main] Received 'allChunksFinished' from background.");
            if (domElements.statusMessage) domElements.statusMessage.textContent = "Finished reading all page content.";
            if (detailsRef.value) detailsRef.value.isActiveSession = false;
            updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            detailsRef.value = null;
            sharedState.isAudioPlaying.value = false;
            return false;
        } else {
            console.warn("[Popup Main] Received unknown message action:", request.action);
            sendResponse({ status: "Unknown action" });
            return false;
        }
    });
    console.log("[Popup Main] Message listener successfully attached.");

    // --- Resume Button Logic ---
    domElements.resumeButton.addEventListener('click', () => {
        console.log("[Popup Main] Resume button clicked.");
        const detailsVal = sharedState.currentArticleDetails.value;
        if (detailsVal && detailsVal.isActiveSession && typeof detailsVal.currentChunkIndex === 'number') {
            showLoader("Resuming...");
            domElements.resumeButton.style.display = 'none';
            chrome.runtime.sendMessage({
                action: "resumeTTSSession",
                resumeFromChunkIndex: detailsVal.currentChunkIndex
            }, response => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Main] Error sending resumeTTSSession:", chrome.runtime.lastError.message);
                    domElements.statusMessage.textContent = "Error resuming.";
                    hideLoader();
                    updateSessionInfoDisplay(detailsVal, sharedState.isAudioPlaying.value);
                } else {
                    console.log("[Popup Main] Resume request sent. Response:", response);
                    if (response && !response.success) {
                        domElements.statusMessage.textContent = response.error || "Failed to resume.";
                        hideLoader();
                        updateSessionInfoDisplay(detailsVal, sharedState.isAudioPlaying.value);
                    }
                }
            });
        } else {
            console.warn("[Popup Main] Resume clicked but no valid active session details found.");
            domElements.statusMessage.textContent = "No active session to resume.";
            domElements.resumeButton.style.display = 'none';
        }
    });

    // --- Confirm on Close ---
    window.addEventListener('beforeunload', (event) => {
        if (sharedState.isAudioPlaying.value && !domElements.audioPlayer.paused && !domElements.audioPlayer.ended) {
            console.log("[Popup Main] 'beforeunload' triggered while audio is actively playing.");
            event.preventDefault();
            event.returnValue = '';
        }
    });

    console.log("[Popup Main] All event handlers attached.");
    hideLoader();
    domElements.audioPlayer.style.display = 'block';

    console.log("[Popup Main] Requesting initial session state from background...");
    chrome.runtime.sendMessage({ action: "requestInitialSessionState" }, response => {
        const detailsRef = sharedState.currentArticleDetails;
        if (chrome.runtime.lastError) {
            console.warn("[Popup Main] Error requesting initial session state:", chrome.runtime.lastError.message);
            domElements.statusMessage.textContent = "Could not get session state.";
        } else if (response && response.action === "activeSessionState" && response.sessionData) {
            console.log("[Popup Main] Received initial session state:", response.sessionData);
            if (response.sessionData.isActive) {
                detailsRef.value = response.sessionData.articleDetails;
                if (detailsRef.value) {
                    detailsRef.value.isActiveSession = true;
                    detailsRef.value.currentChunkIndex = response.sessionData.currentIndex;
                    detailsRef.value.chunks = response.sessionData.chunks || (detailsRef.value.chunks || []);
                    detailsRef.value.totalChunks = detailsRef.value.chunks.length;
                    detailsRef.value.isLastChunk = (detailsRef.value.currentChunkIndex === (detailsRef.value.chunks.length > 0 ? detailsRef.value.chunks.length - 1 : 0));

                    console.log("[Popup Main] Restored active session details for UI:", detailsRef.value);
                    if (detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                        renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
                    }
                } else {
                    console.warn("[Popup Main] Active session reported, but articleDetails missing in sessionData. Creating basic active state.");
                    detailsRef.value = {
                        isActiveSession: true,
                        isChunk: (response.sessionData.chunks && response.sessionData.chunks.length > 1),
                        currentChunkIndex: response.sessionData.currentIndex,
                        totalChunks: response.sessionData.chunks ? response.sessionData.chunks.length : 0,
                        chunks: response.sessionData.chunks || [],
                        title: "Active Session"
                    };
                    if (detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                        renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
                    }
                }
            } else {
                console.log("[Popup Main] No active session reported by background on load.");
                detailsRef.value = { isActiveSession: false };
                if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            }
        } else {
            console.log("[Popup Main] No active session reported or invalid response:", response);
            detailsRef.value = { isActiveSession: false };
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
        }
        updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
    });
});
