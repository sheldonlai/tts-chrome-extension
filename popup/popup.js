// popup.js (Main Orchestrator)

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
        autoAdvanceToggleBtn: document.getElementById('autoAdvanceToggleBtn'),
        sessionQueueContainer: document.getElementById('sessionQueueContainer'),
        sessionQueueList: document.getElementById('sessionQueueList'),
        toggleSessionQueueBtn: document.getElementById('toggleSessionQueue'),
        toggleHistoryListBtn: document.getElementById('toggleHistoryList')
    };

    // Shared State
    const sharedState = {
        isAudioPlaying: { value: false },
        currentPlayingText: { value: "" },
        currentArticleDetails: { value: null }, // Holds comprehensive details from background
        isHandlingAudioError: { value: false },
        isCurrentlySeeking: { value: false }
    };

    console.log("[Popup Main] DOMContentLoaded. Initializing modules.");

    if (!domElements.audioPlayer || !domElements.statusMessage || !domElements.resumeButton || !domElements.autoAdvanceToggleBtn) {
        console.error("[Popup Main] One or more critical UI elements not found! Check popup.html IDs.", domElements);
        if (domElements.statusMessage) domElements.statusMessage.textContent = "Error: Popup UI critical elements missing.";
        return;
    }
    domElements.statusMessage.textContent = "Popup ready.";
    if (domElements.currentSessionInfoDiv) domElements.currentSessionInfoDiv.style.display = 'none';
    if (domElements.resumeButton) domElements.resumeButton.style.display = 'none';
    if (domElements.autoAdvanceToggleBtn) domElements.autoAdvanceToggleBtn.style.display = 'none';
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
                    if (sharedState.currentArticleDetails.value && sharedState.currentArticleDetails.value.isActiveSession && sharedState.currentArticleDetails.value.isChunk) {
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
                playAudioFromHistory: (audioDataUrl, text, articleDetailsFromHistory) => {
                    sharedState.currentArticleDetails.value = articleDetailsFromHistory; // This should be comprehensive
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
        const detailsVal = sharedState.currentArticleDetails.value;
        if (detailsVal && detailsVal.isActiveSession && typeof chunkIndex === 'number' && detailsVal.chunks && chunkIndex < detailsVal.chunks.length) {
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
                    updateSessionInfoDisplay(detailsVal, sharedState.isAudioPlaying.value);
                } else {
                    console.log("[Popup Main] jumpToChunk request sent. Response:", response);
                    // Background will send a new processTextForTTS or playAudioDataUrl message
                }
            });
        } else {
            console.warn("[Popup Main] Cannot handle chunk item click. Invalid state or chunkIndex.", detailsVal, chunkIndex);
        }
    }

    // --- Message Handling from Background Script ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("[Popup Main] Message received:", request.action, request); // Log the request object
        const detailsRef = sharedState.currentArticleDetails; // Reference to sharedState.currentArticleDetails

        if (request.action === "stopAndResetAudio") {
            console.log("[Popup Main] Received 'stopAndResetAudio' command.");
            AudioController.stopAndResetAudioPlayer("Audio stopped. Ready for new input.");
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: (detailsRef.value ? detailsRef.value.autoAdvanceToNextPage : false) }; // Preserve autoAdvance
            updateSessionInfoDisplay(detailsRef.value, false);
            sendResponse({ status: "Audio player reset" });
            return false;
        }

        if (request.action === "sessionClearedByBackground") {
            console.log("[Popup Main] Received 'sessionClearedByBackground'. Resetting UI.");
            detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: false }; // Full reset
            sharedState.isAudioPlaying.value = false;
            AudioController.stopAndResetAudioPlayer("All data cleared.");
            updateSessionInfoDisplay(detailsRef.value, false);
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            sendResponse({ status: "Popup UI reset for cleared session" });
            return false;
        }

        if (request.action === "activeSessionState") {
            console.log("[Popup Main] Received 'activeSessionState':", request.sessionData);
            if (request.sessionData && request.sessionData.articleDetails) {
                detailsRef.value = request.sessionData.articleDetails; // This is now comprehensive from background
                // isActiveSession, currentChunkIndex etc. are part of articleDetails
            } else {
                // Fallback if structure is unexpected
                const persistedAutoAdvance = (request.sessionData && request.sessionData.articleDetails && request.sessionData.articleDetails.autoAdvanceToNextPage !== undefined)
                    ? request.sessionData.articleDetails.autoAdvanceToNextPage
                    : (detailsRef.value ? detailsRef.value.autoAdvanceToNextPage : false);
                detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: persistedAutoAdvance };
            }

            if (detailsRef.value && detailsRef.value.isActiveSession && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
            } else if (domElements.sessionQueueContainer) {
                domElements.sessionQueueContainer.style.display = 'none';
            }
            updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
            sendResponse({ status: "Session state received by popup" });
            return false;
        }


        if (request.action === "processTextForTTS" && request.selectedText) {
            AudioController.stopAndResetAudioPlayer("Processing new text/chunk...");
            const textToProcess = request.selectedText;
            detailsRef.value = request.articleDetails; // This is comprehensive from background
            sharedState.currentPlayingText.value = textToProcess;

            showLoader(detailsRef.value && detailsRef.value.isChunk ? `Loading chunk ${detailsRef.value.currentChunkIndex + 1}...` : "Checking cache...");

            if (detailsRef.value && detailsRef.value.isActiveSession && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
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

                if (result[cacheKey]) {
                    console.log("[Popup Main] Cache hit for chunk:", normalizedText.substring(0, 30) + "...");
                    AudioController.playAudio(result[cacheKey], normalizedText, detailsRef.value);
                    const fullTitleForHistory = (detailsRef.value && detailsRef.value.title) ? detailsRef.value.title : "Audio Snippet";
                    HistoryManager.addHistoryItemToDOM(normalizedText, result[cacheKey], fullTitleForHistory, detailsRef.value);
                    sendResponse({ status: "Playing chunk from cache" });
                } else {
                    console.log("[Popup Main] Cache miss for chunk:", normalizedText.substring(0, 30) + "...", ". Requesting from background.");
                    domElements.statusMessage.textContent = detailsRef.value && detailsRef.value.isChunk ? `Fetching chunk ${detailsRef.value.currentChunkIndex + 1}...` : "Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText, originalArticleDetails: detailsRef.value });
                    sendResponse({ status: "Cache miss, fetching chunk from server" });
                }
            });
            return true;
        }

        if (request.action === "playAudioDataUrl" && request.audioDataUrl && request.originalText) {
            detailsRef.value = request.articleDetails; // Comprehensive from background
            sharedState.currentPlayingText.value = request.originalText;

            AudioController.playAudio(request.audioDataUrl, request.originalText, detailsRef.value);

            if (detailsRef.value && detailsRef.value.isActiveSession && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
            } else if (domElements.sessionQueueContainer) {
                domElements.sessionQueueContainer.style.display = 'none';
            }

            const cacheKey = generateAudioCacheKey(request.originalText.trim());
            chrome.storage.local.set({ [cacheKey]: request.audioDataUrl }, () => {
                if (chrome.runtime.lastError) { console.error("Error saving to audio cache", chrome.runtime.lastError.message); }
            });

            const fullTitleForHistory = (detailsRef.value && detailsRef.value.title) ? detailsRef.value.title : "Audio Snippet";
            HistoryManager.addHistoryItemToDOM(request.originalText.trim(), request.audioDataUrl, fullTitleForHistory, detailsRef.value);
            sendResponse({ status: "Audio received and playing, caching attempt made" });
            return false;
        }

        if (request.action === "ttsErrorPopup") {
            console.error("[Popup Main] 'ttsErrorPopup' action received:", request.error);
            AudioController.stopAndResetAudioPlayer(`Error: ${request.error}`);
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: (detailsRef.value ? detailsRef.value.autoAdvanceToNextPage : false) }; // Preserve autoAdvance
            updateSessionInfoDisplay(detailsRef.value, false);
            sendResponse({ status: "Error message acknowledged" });
            return false;
        }

        if (request.action === "allChunksFinished") {
            console.log("[Popup Main] Received 'allChunksFinished' from background.");
            if (domElements.statusMessage) domElements.statusMessage.textContent = "Finished reading all page content.";
            if (detailsRef.value) detailsRef.value.isActiveSession = false; // Mark as inactive for UI
            updateSessionInfoDisplay(detailsRef.value, false); // isAudioPlaying is false
            if (domElements.sessionQueueContainer) domElements.sessionQueueContainer.style.display = 'none';
            sharedState.isAudioPlaying.value = false;
            sendResponse({ status: "All chunks finished message handled by popup" });
            return false;
        }

        if (request.action === "nextPageResult_Popup") {
            hideLoader();
            if (request.success && request.navigating) {
                domElements.statusMessage.textContent = request.message || `Navigating to next page...`;
                // The detailsRef.value should be updated by background via autoAdvanceStateChanged or new session init
            } else {
                domElements.statusMessage.textContent = request.reasoning || "Could not find next page.";
                if (detailsRef.value) detailsRef.value.isActiveSession = false; // No longer actively navigating or playing this session
            }
            updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
            sendResponse({ status: "Next page result handled by popup" });
            return false;
        }

        if (request.action === "autoAdvanceStateChanged") {
            console.log("[Popup Main] Received 'autoAdvanceStateChanged', enabled:", request.enabled, "Full Details:", request.articleDetails);
            if (request.articleDetails) {
                detailsRef.value = request.articleDetails; // This is comprehensive from background
                detailsRef.value.autoAdvanceToNextPage = request.enabled; // Ensure this specific flag is also set from the 'enabled' field
            } else {
                if (detailsRef.value) {
                    detailsRef.value.autoAdvanceToNextPage = request.enabled;
                } else {
                    detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: request.enabled };
                }
                console.warn("[Popup Main] autoAdvanceStateChanged received without full articleDetails. Using existing/default for other properties.");
            }

            if (detailsRef.value && detailsRef.value.isActiveSession && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
                renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
            } else if (domElements.sessionQueueContainer) {
                domElements.sessionQueueContainer.style.display = 'none';
            }

            updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
            sendResponse({ status: "Popup UI updated for auto-advance state" });
            return false;
        }

        return false;
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
                }
            });
        } else {
            console.warn("[Popup Main] Resume clicked but no valid active session details found.");
            domElements.statusMessage.textContent = "No active session to resume.";
            domElements.resumeButton.style.display = 'none';
        }
    });

    domElements.autoAdvanceToggleBtn.addEventListener('click', () => {
        const currentIsEnabled = domElements.autoAdvanceToggleBtn.classList.contains('enabled');
        const newEnableState = !currentIsEnabled;

        // Optimistic UI update for the button text and style
        domElements.autoAdvanceToggleBtn.textContent = newEnableState ? "Disable Auto-Next Page (Applying...)" : "Enable Auto-Next Page (Applying...)";
        if (newEnableState) {
            domElements.autoAdvanceToggleBtn.classList.add('enabled');
        } else {
            domElements.autoAdvanceToggleBtn.classList.remove('enabled');
        }
        // Optionally, briefly update status message
        // domElements.statusMessage.textContent = "Updating auto-next page setting...";


        chrome.runtime.sendMessage({ action: "toggleAutoAdvance", enable: newEnableState }, response => {
            if (chrome.runtime.lastError) {
                console.error("[Popup Main] Error sending toggleAutoAdvance:", chrome.runtime.lastError.message);
                domElements.statusMessage.textContent = "Error setting auto-advance.";
                // The UI will be corrected by 'autoAdvanceStateChanged' if background eventually sends it,
                // or by a full state refresh if needed. For now, the optimistic update might be temporarily wrong.
                // Consider re-fetching state to ensure UI consistency on error.
                chrome.runtime.sendMessage({ action: "requestInitialSessionState" });
            } else if (response && response.success) {
                // console.log("[Popup Main] Auto-advance toggle request sent. Background responded success:", response.autoAdvanceEnabled);
                // The authoritative UI update (button text, style, and session list visibility)
                // will be handled by the 'autoAdvanceStateChanged' message listener
                // when it receives the comprehensive state from the background.
                // The optimistic update above provides immediate feedback.
            } else { // Response received but not successful (e.g., response.success is false from background)
                domElements.statusMessage.textContent = "Failed to set auto-advance.";
                // Revert optimistic UI by re-fetching the true state from background
                chrome.runtime.sendMessage({ action: "requestInitialSessionState" });
            }
        });
    });


    window.addEventListener('beforeunload', (event) => {
        if (sharedState.isAudioPlaying.value && !domElements.audioPlayer.paused && !domElements.audioPlayer.ended) {
            console.log("[Popup Main] 'beforeunload' triggered while audio is actively playing. Background should save state.");
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
            detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: false };
        } else if (response && response.action === "activeSessionState" && response.sessionData && response.sessionData.articleDetails) {
            console.log("[Popup Main] Received initial session state from background:", response.sessionData);
            detailsRef.value = response.sessionData.articleDetails; // This is comprehensive
        } else {
            console.log("[Popup Main] No active session reported or invalid response for initial state:", response);
            detailsRef.value = { isActiveSession: false, autoAdvanceToNextPage: false };
        }

        if (detailsRef.value && detailsRef.value.isActiveSession && detailsRef.value.isChunk && detailsRef.value.chunks && detailsRef.value.chunks.length > 1) {
            renderSessionQueue(detailsRef.value.chunks, detailsRef.value.currentChunkIndex, handleChunkItemClick);
        } else if (domElements.sessionQueueContainer) {
            domElements.sessionQueueContainer.style.display = 'none';
        }
        updateSessionInfoDisplay(detailsRef.value, sharedState.isAudioPlaying.value);
    });
});
