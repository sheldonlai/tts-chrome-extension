// uiHelpers.js functions (showLoader, hideLoader, updateSessionInfoDisplay) are expected to be globally available
// as they are simple utility functions not wrapped in an IIFE that returns an object.
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
        resumeButton: document.getElementById('resumeButton')
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

    if (Object.values(domElements).some(el => !el)) {
        console.error("[Popup Main] One or more essential UI elements not found! Check popup.html IDs.");
        if (domElements.statusMessage) domElements.statusMessage.textContent = "Error: Popup UI critical elements missing.";
        return;
    }
    domElements.statusMessage.textContent = "Popup ready.";
    domElements.currentSessionInfoDiv.style.display = 'none';
    domElements.resumeButton.style.display = 'none';

    // Initialize Audio Controller
    AudioController.init( // Call init on the global AudioController object
        { audioPlayer: domElements.audioPlayer, statusMessage: domElements.statusMessage },
        sharedState,
        {
            updateSessionInfoDisplay: () => updateSessionInfoDisplay(sharedState.currentArticleDetails.value, sharedState.isAudioPlaying.value), // updateSessionInfoDisplay is global from uiHelpers.js
            showLoader: showLoader, // from uiHelpers.js
            hideLoader: hideLoader  // from uiHelpers.js
        }
    );

    // Initialize History Manager
    HistoryManager.init( // Call init on the global HistoryManager object
        { historyListElement: domElements.historyListElement, clearHistoryBtn: domElements.clearHistoryBtn },
        {
            playAudioFromHistory: AudioController.playAudio, // Pass AudioController's playAudio method
            stopAndResetAudioPlayer: AudioController.stopAndResetAudioPlayer, // Pass AudioController's method
            showLoader: showLoader // from uiHelpers.js
        }
    );

    // --- Message Handling ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("[Popup Main] Message received:", request);
        const details = sharedState.currentArticleDetails;

        if (request.action === "stopAndResetAudio") {
            console.log("[Popup Main] Received 'stopAndResetAudio' command.");
            AudioController.stopAndResetAudioPlayer("Audio stopped. Ready for new input.");
            sendResponse({ status: "Audio player reset" });
            return false;
        }

        if (request.action === "activeSessionState") {
            console.log("[Popup Main] Received 'activeSessionState':", request.sessionData);
            if (request.sessionData && request.sessionData.isActive) {
                details.value = request.sessionData.articleDetails;
                if (details.value) {
                    details.value.isActiveSession = true;
                    details.value.currentChunkIndex = request.sessionData.currentIndex;
                    details.value.totalChunks = request.sessionData.totalChunks;
                    details.value.isLastChunk = (request.sessionData.currentIndex === request.sessionData.totalChunks - 1);
                } else {
                    details.value = { isActiveSession: true, isChunk: false, title: "Active Session (Details Missing)" };
                }
            } else {
                details.value = { isActiveSession: false };
            }
            updateSessionInfoDisplay(details.value, sharedState.isAudioPlaying.value); // Global from uiHelpers.js
            sendResponse({ status: "Session state received by popup" });
            return false;
        }

        if (request.action === "processTextForTTS" && request.selectedText) {
            AudioController.stopAndResetAudioPlayer("Processing new text/chunk...");
            const textToProcess = request.selectedText;
            details.value = request.articleDetails;
            details.value.isActiveSession = true;
            sharedState.currentPlayingText.value = textToProcess;

            console.log(`[Popup Main] 'processTextForTTS' for: "${textToProcess.substring(0, 50)}..."`, "Details:", details.value);
            showLoader(details.value && details.value.isChunk ? `Loading chunk ${details.value.currentChunkIndex + 1}...` : "Checking cache...");

            const normalizedText = textToProcess.trim();
            const cacheKey = "tts_" + normalizedText.substring(0, 200);

            chrome.storage.local.get([cacheKey], (result) => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Main] Error getting from storage:", chrome.runtime.lastError.message);
                    domElements.statusMessage.textContent = "Storage error. Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText });
                    sendResponse({ status: "Storage error, fetching from server" });
                    return;
                }
                if (result[cacheKey]) {
                    console.log("[Popup Main] Cache hit for chunk:", normalizedText);
                    AudioController.playAudio(result[cacheKey], normalizedText, details.value);
                    if (details.value) details.value.isLastChunk = details.value.isLastChunk;
                    sendResponse({ status: "Playing chunk from cache" });
                } else {
                    console.log("[Popup Main] Cache miss for chunk:", normalizedText, ". Requesting from background.");
                    domElements.statusMessage.textContent = details.value && details.value.isChunk ? `Fetching chunk ${details.value.currentChunkIndex + 1}...` : "Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText });
                    sendResponse({ status: "Cache miss, fetching chunk from server" });
                }
            });
            return true;

        } else if (request.action === "playAudioDataUrl" && request.audioDataUrl && request.originalText) {
            console.log("[Popup Main] 'playAudioDataUrl' for:", request.originalText.substring(0, 50) + "...", "Received articleDetails:", request.articleDetails);
            details.value = request.articleDetails;
            details.value.isActiveSession = true;
            sharedState.currentPlayingText.value = request.originalText;

            AudioController.playAudio(request.audioDataUrl, request.originalText, details.value);

            let historyDisplayTitle;
            const HISTORY_ITEM_TARGET_LENGTH = 60;
            const CHUNK_SUFFIX_APPROX_LENGTH = 10;
            const genericTitles = ["Reading Page Content", "Selected Text", "Page Content", "Untitled Page"];

            if (details.value && details.value.isChunk) {
                let baseDisplayPart;
                const isTitleGeneric = !details.value.title || genericTitles.includes(details.value.title);
                const totalChunks = details.value.totalChunks != null ? details.value.totalChunks : 0;
                if (totalChunks > 1) {
                    let maxBaseLength = HISTORY_ITEM_TARGET_LENGTH - CHUNK_SUFFIX_APPROX_LENGTH;
                    if (maxBaseLength < 15) maxBaseLength = 15;
                    if (!isTitleGeneric) baseDisplayPart = details.value.title;
                    else baseDisplayPart = request.originalText;
                    if (baseDisplayPart.length > maxBaseLength) baseDisplayPart = baseDisplayPart.substring(0, maxBaseLength).trim() + "...";
                    const chunkNumber = details.value.currentChunkIndex != null ? details.value.currentChunkIndex + 1 : '';
                    historyDisplayTitle = `${baseDisplayPart} (${chunkNumber}/${totalChunks})`;
                } else {
                    if (!isTitleGeneric) baseDisplayPart = details.value.title;
                    else baseDisplayPart = request.originalText;
                    if (baseDisplayPart.length > HISTORY_ITEM_TARGET_LENGTH) baseDisplayPart = baseDisplayPart.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                    historyDisplayTitle = baseDisplayPart;
                }
            } else {
                let titleToUse = (details.value && details.value.title && details.value.title !== "Selected Text") ? details.value.title : request.originalText;
                if (titleToUse.length > HISTORY_ITEM_TARGET_LENGTH) titleToUse = titleToUse.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                historyDisplayTitle = titleToUse;
            }
            HistoryManager.addHistoryItemToDOM(request.originalText, request.audioDataUrl, true, historyDisplayTitle);
            sendResponse({ status: "Audio received and playing, caching attempt made" });
            return false;

        } else if (request.action === "ttsErrorPopup") {
            console.error("[Popup Main] 'ttsErrorPopup' action received:", request.error);
            AudioController.stopAndResetAudioPlayer(`Error: ${request.error}`);
            sendResponse({ status: "Error message acknowledged" });
            return false;
        } else if (request.action === "allChunksFinished") {
            console.log("[Popup Main] Received 'allChunksFinished' from background.");
            if (domElements.statusMessage) domElements.statusMessage.textContent = "Finished reading all page content.";
            if (details.value) details.value.isActiveSession = false;
            updateSessionInfoDisplay(details.value, sharedState.isAudioPlaying.value); // Global
            details.value = null;
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
            showLoader("Resuming..."); // Global
            domElements.resumeButton.style.display = 'none';
            chrome.runtime.sendMessage({
                action: "resumeTTSSession",
                resumeFromChunkIndex: detailsVal.currentChunkIndex
            }, response => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Main] Error sending resumeTTSSession:", chrome.runtime.lastError.message);
                    domElements.statusMessage.textContent = "Error resuming.";
                    hideLoader(); // Global
                    updateSessionInfoDisplay(detailsVal, sharedState.isAudioPlaying.value); // Global
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
    // loadHistory(); // Now called by HistoryManager.init()

    console.log("[Popup Main] Requesting initial session state from background...");
    chrome.runtime.sendMessage({ action: "requestInitialSessionState" }, response => {
        const details = sharedState.currentArticleDetails;
        if (chrome.runtime.lastError) {
            console.warn("[Popup Main] Error requesting initial session state:", chrome.runtime.lastError.message);
            domElements.statusMessage.textContent = "Could not get session state.";
        } else if (response && response.action === "activeSessionState" && response.sessionData) {
            console.log("[Popup Main] Received initial session state:", response.sessionData);
            if (response.sessionData.isActive) {
                details.value = response.sessionData.articleDetails;
                if (details.value) {
                    details.value.isActiveSession = true;
                    details.value.currentChunkIndex = response.sessionData.currentIndex;
                    details.value.totalChunks = response.sessionData.totalChunks;
                    details.value.isLastChunk = (response.sessionData.currentIndex === response.sessionData.totalChunks - 1);
                } else {
                    details.value = { isActiveSession: true, isChunk: false, title: "Active Session (Details Missing)" };
                }
            } else {
                details.value = { isActiveSession: false };
            }
        } else {
            console.log("[Popup Main] No active session reported or invalid response:", response);
            details.value = { isActiveSession: false };
        }
        updateSessionInfoDisplay(details.value, sharedState.isAudioPlaying.value); // Global
    });
});
