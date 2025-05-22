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
        currentArticleDetails: { value: null }, // This will hold { title, textContent, isChunk, currentChunkIndex, totalChunks, isActiveSession, etc. }
        isHandlingAudioError: { value: false },
        isCurrentlySeeking: { value: false }
    };

    // CONSTANTS
    // const HISTORY_ITEM_TARGET_LENGTH = 45; // No longer strictly needed for stored title, display can be CSS
    // const SELECTED_TEXT_TITLE_BASE_LENGTH = 100; // Background now handles longer titles

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
                // playAudioFromHistory will be called with the full article details from history
                playAudioFromHistory: (audioDataUrl, text, articleDetailsFromHistory) => {
                    // When playing from history, currentArticleDetails should be fully populated
                    // from the history item, including the full title.
                    sharedState.currentArticleDetails.value = articleDetailsFromHistory;
                    AudioController.playAudio(audioDataUrl, text, articleDetailsFromHistory);
                },
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
                    // Background will send a new processTextForTTS or playAudioDataUrl message
                }
            });
        } else {
            console.warn("[Popup Main] Cannot handle chunk item click. Invalid state or chunkIndex.", details, chunkIndex);
        }
    }

    // --- Message Handling ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("[Popup Main] Message received:", request.action);
        const detailsRef = sharedState.currentArticleDetails; // Use this to modify sharedState.currentArticleDetails.value

        if (request.action === "stopAndResetAudio") {
            console.log("[Popup Main] Received 'stopAndResetAudio' command.");
            AudioController.stopAndResetAudioPlayer("Audio stopped. Ready for new input.");
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            sendResponse({ status: "Audio player reset" });
            return false;
        }

        if (request.action === "sessionClearedByBackground") {
            console.log("[Popup Main] Received 'sessionClearedByBackground'. Resetting UI.");
            detailsRef.value = { isActiveSession: false }; // Reset current article details
            sharedState.isAudioPlaying.value = false;
            AudioController.stopAndResetAudioPlayer("All data cleared.");
            updateSessionInfoDisplay(detailsRef.value, false); // Update UI based on reset state
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            sendResponse({ status: "Popup UI reset for cleared session" });
            return false;
        }


        if (request.action === "activeSessionState") {
            if (request.sessionData && request.sessionData.isActive) {
                detailsRef.value = request.sessionData.articleDetails; // This should contain the full title
                if (detailsRef.value) {
                    detailsRef.value.isActiveSession = true;
                    detailsRef.value.currentChunkIndex = request.sessionData.currentIndex;
                    // Ensure chunks array is present and consistent
                    detailsRef.value.chunks = request.sessionData.chunks || (detailsRef.value.chunks || []);
                    detailsRef.value.totalChunks = detailsRef.value.chunks.length;
                    detailsRef.value.isLastChunk = (detailsRef.value.currentChunkIndex === (detailsRef.value.chunks.length > 0 ? detailsRef.value.chunks.length - 1 : 0));

                    if (detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                        renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
                    } else if (domElements.sessionQueueContainer) {
                        domElements.sessionQueueContainer.style.display = 'none';
                    }
                } else {
                    // Fallback if articleDetails is somehow missing but session is active
                    detailsRef.value = {
                        isActiveSession: true,
                        isChunk: (request.sessionData.chunks && request.sessionData.chunks.length > 1),
                        currentChunkIndex: request.sessionData.currentIndex,
                        totalChunks: request.sessionData.chunks ? request.sessionData.chunks.length : 0,
                        chunks: request.sessionData.chunks || [],
                        title: "Active Session (Details Missing)" // Fallback title
                    };
                    if (detailsRef.value.isChunk) renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
                }
            } else {
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
            detailsRef.value = request.articleDetails; // This comes from background, should have full title
            if (detailsRef.value) detailsRef.value.isActiveSession = true;
            sharedState.currentPlayingText.value = textToProcess;

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

                if (result[cacheKey]) { // Cache hit
                    console.log("[Popup Main] Cache hit for chunk:", normalizedText.substring(0, 30) + "...");
                    AudioController.playAudio(result[cacheKey], normalizedText, detailsRef.value); // detailsRef.value has full title

                    // For history, use the full title from detailsRef.value.title
                    const fullTitleForHistory = (detailsRef.value && detailsRef.value.title) ? detailsRef.value.title : "Audio Snippet";
                    HistoryManager.addHistoryItemToDOM(normalizedText, result[cacheKey], fullTitleForHistory, detailsRef.value);
                    sendResponse({ status: "Playing chunk from cache" });

                } else { // Cache miss
                    console.log("[Popup Main] Cache miss for chunk:", normalizedText.substring(0, 30) + "...", ". Requesting from background.");
                    domElements.statusMessage.textContent = detailsRef.value && detailsRef.value.isChunk ? `Fetching chunk ${detailsRef.value.currentChunkIndex + 1}...` : "Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText, originalArticleDetails: detailsRef.value });
                    sendResponse({ status: "Cache miss, fetching chunk from server" });
                }
            });
            return true; // Async response

        } else if (request.action === "playAudioDataUrl" && request.audioDataUrl && request.originalText) {
            detailsRef.value = request.articleDetails; // This comes from background, should have full title
            if (detailsRef.value) detailsRef.value.isActiveSession = true;
            sharedState.currentPlayingText.value = request.originalText;

            AudioController.playAudio(request.audioDataUrl, request.originalText, detailsRef.value);

            if (detailsRef.value && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
            } else if (domElements.sessionQueueContainer) {
                domElements.sessionQueueContainer.style.display = 'none';
            }

            const cacheKey = generateAudioCacheKey(request.originalText.trim());
            chrome.storage.local.set({ [cacheKey]: request.audioDataUrl }, () => {
                if (chrome.runtime.lastError) { console.error("Error saving to audio cache", chrome.runtime.lastError.message); }
                else { console.log("Audio data cached for key:", cacheKey); }
            });

            // For history, use the full title from detailsRef.value.title
            const fullTitleForHistory = (detailsRef.value && detailsRef.value.title) ? detailsRef.value.title : "Audio Snippet";
            // Pass the complete articleDetails object to history so it can store everything needed for full restoration
            HistoryManager.addHistoryItemToDOM(request.originalText.trim(), request.audioDataUrl, fullTitleForHistory, detailsRef.value);
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
            if (detailsRef.value) detailsRef.value.isActiveSession = false; // Mark session inactive
            updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value); // Update UI
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            // Don't null out detailsRef.value immediately, updateSessionInfoDisplay might need it briefly
            // It will be effectively reset if a new session starts or popup closes.
            sharedState.isAudioPlaying.value = false;
            return false;
        } else {
            console.warn("[Popup Main] Received unknown message action:", request.action);
            sendResponse({ status: "Unknown action" });
            return false;
        }
    });
    console.log("[Popup Main] Message listener successfully attached.");

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
                    // If successful, background will send a new message to process/play audio
                }
            });
        } else {
            console.warn("[Popup Main] Resume clicked but no valid active session details found.");
            domElements.statusMessage.textContent = "No active session to resume.";
            domElements.resumeButton.style.display = 'none';
        }
    });

    window.addEventListener('beforeunload', (event) => {
        // Background.js handles session saving on popup close if audio was playing.
        // No specific action needed here for that.
        if (sharedState.isAudioPlaying.value && !domElements.audioPlayer.paused && !domElements.audioPlayer.ended) {
            console.log("[Popup Main] 'beforeunload' triggered while audio is actively playing. State should be saved by background.js on window close.");
        }
    });

    console.log("[Popup Main] All event handlers attached.");
    hideLoader(); // Ensure loader is hidden on initial load
    domElements.audioPlayer.style.display = 'block'; // Ensure player is visible

    console.log("[Popup Main] Requesting initial session state from background...");
    chrome.runtime.sendMessage({ action: "requestInitialSessionState" }, response => {
        const detailsRef = sharedState.currentArticleDetails; // Use this to modify sharedState.currentArticleDetails.value
        if (chrome.runtime.lastError) {
            console.warn("[Popup Main] Error requesting initial session state:", chrome.runtime.lastError.message);
        } else if (response && response.action === "activeSessionState" && response.sessionData) {
            if (response.sessionData.isActive) {
                detailsRef.value = response.sessionData.articleDetails; // This should contain the full title
                if (detailsRef.value) {
                    detailsRef.value.isActiveSession = true;
                    detailsRef.value.currentChunkIndex = response.sessionData.currentIndex;
                    detailsRef.value.chunks = response.sessionData.chunks || (detailsRef.value.chunks || []);
                    detailsRef.value.totalChunks = detailsRef.value.chunks.length;
                    detailsRef.value.isLastChunk = (detailsRef.value.currentChunkIndex === (detailsRef.value.chunks.length > 0 ? detailsRef.value.chunks.length - 1 : 0));

                    if (detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                        renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
                    }
                } else {
                    detailsRef.value = { /* ... fallback as before ... */ title: "Active Session (Initial Load Error)" };
                }
            } else {
                detailsRef.value = { isActiveSession: false };
                if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            }
        } else {
            detailsRef.value = { isActiveSession: false };
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
        }
        updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value); // Update UI with initial state
    });
});
