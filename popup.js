// popup.js

document.addEventListener('DOMContentLoaded', () => {
    const audioPlayer = document.getElementById('popupAudioPlayer');
    const statusMessage = document.getElementById('statusMessage');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const historyListElement = document.getElementById('historyList');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');

    const currentSessionInfoDiv = document.getElementById('currentSessionInfo');
    const currentSessionTitleSpan = document.getElementById('currentSessionTitle');
    const currentSessionChunkInfoSpan = document.getElementById('currentSessionChunkInfo');
    const resumeButton = document.getElementById('resumeButton');

    let isAudioPlaying = false;
    let currentPlayingText = "";
    let currentArticleDetails = null;
    let isHandlingAudioError = false;
    let isCurrentlySeeking = false;

    const MAX_HISTORY_ITEMS = 10;

    console.log("[Popup Script] DOMContentLoaded. Script loaded.");

    if (!audioPlayer || !statusMessage || !loadingIndicator || !historyListElement || !clearHistoryBtn ||
        !currentSessionInfoDiv || !currentSessionTitleSpan || !currentSessionChunkInfoSpan || !resumeButton) {
        console.error("[Popup Script] Essential UI elements not found! Check popup.html for correct IDs.");
        if (statusMessage) statusMessage.textContent = "Error: Popup UI elements missing.";
        return;
    }
    statusMessage.textContent = "Popup ready.";
    currentSessionInfoDiv.style.display = 'none';
    resumeButton.style.display = 'none';

    // --- UI Helper Functions ---
    function updateSessionInfoDisplay() {
        if (currentArticleDetails && currentArticleDetails.isActiveSession) {
            currentSessionInfoDiv.style.display = 'block';
            let title = currentArticleDetails.title || "Reading in Progress";
            if (title.length > 42) title = title.substring(0, 42) + "...";
            currentSessionTitleSpan.textContent = title;

            if (isAudioPlaying) {
                resumeButton.style.display = 'none';
                if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number' && currentArticleDetails.totalChunks > 1) {
                    currentSessionChunkInfoSpan.textContent = `Chunk ${currentArticleDetails.currentChunkIndex + 1} / ${currentArticleDetails.totalChunks}`;
                } else if (currentArticleDetails.isChunk) {
                    currentSessionChunkInfoSpan.textContent = "";
                }
                else {
                    currentSessionChunkInfoSpan.textContent = "";
                }
                let playingStatusText = `Playing: ${currentPlayingText.substring(0, 30)}${currentPlayingText.length > 30 ? '...' : ''}`;
                if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                    if (currentArticleDetails.totalChunks > 1) {
                        playingStatusText = `Playing chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks}...`;
                    } else {
                        playingStatusText = `Playing content...`;
                    }
                }
                if (statusMessage) statusMessage.textContent = playingStatusText;

            } else {
                if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                    if (currentArticleDetails.totalChunks > 1) {
                        currentSessionChunkInfoSpan.textContent = `(Paused at Chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks})`;
                    } else {
                        currentSessionChunkInfoSpan.textContent = "(Paused)";
                    }
                    resumeButton.style.display = 'block';
                } else if (!currentArticleDetails.isChunk && currentArticleDetails.textContent) {
                    currentSessionChunkInfoSpan.textContent = "(Paused)";
                    resumeButton.style.display = 'block';
                } else {
                    currentSessionChunkInfoSpan.textContent = "(Session active, ready to start)";
                    resumeButton.style.display = 'block';
                }
                if (!statusMessage.textContent.startsWith("Playing") && !statusMessage.textContent.startsWith("Loading")) {
                    statusMessage.textContent = "Session paused. Click Resume to continue.";
                }
            }
        } else {
            currentSessionInfoDiv.style.display = 'none';
            resumeButton.style.display = 'none';
            currentSessionTitleSpan.textContent = '';
            currentSessionChunkInfoSpan.textContent = '';
            if (statusMessage.textContent.includes("Paused") || statusMessage.textContent.includes("Session active") || statusMessage.textContent.startsWith("Finished") || statusMessage.textContent.startsWith("Playing")) {
                statusMessage.textContent = "Ready for audio.";
            }
        }
    }

    function showLoader(message = "Processing...") {
        if (loadingIndicator) loadingIndicator.style.display = 'block';
        if (statusMessage) statusMessage.textContent = message;
        audioPlayer.style.display = 'none';
        if (audioPlayer.HAVE_CURRENT_DATA && !audioPlayer.paused) {
            audioPlayer.pause();
        }
        currentSessionInfoDiv.style.display = 'none';
        resumeButton.style.display = 'none';
    }

    function hideLoader() {
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        audioPlayer.style.display = 'block';
        // updateSessionInfoDisplay(); // Called by playAudio or onplay/onpause now
    }

    function stopAndResetAudioPlayer(resetMessage = "Ready for new audio.") {
        console.log("[Popup Script] Stopping and resetting audio player. Message:", resetMessage);
        isHandlingAudioError = true;
        audioPlayer.pause();
        if (audioPlayer.currentSrc && audioPlayer.currentSrc !== "") audioPlayer.src = '';

        isAudioPlaying = false;
        isCurrentlySeeking = false;
        currentPlayingText = "";
        if (currentArticleDetails) currentArticleDetails.isActiveSession = false;
        if (statusMessage) statusMessage.textContent = resetMessage;
        updateSessionInfoDisplay();
        hideLoader();
        setTimeout(() => { isHandlingAudioError = false; }, 100);
    }

    function playAudio(audioDataUrl, textToShow, articleDetailsForPlayback) {
        currentPlayingText = textToShow;
        isHandlingAudioError = false;
        isCurrentlySeeking = false;
        audioPlayer.src = audioDataUrl;
        currentArticleDetails = articleDetailsForPlayback;
        currentArticleDetails.isActiveSession = true;

        const playPromise = audioPlayer.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log("[Popup Script] Audio playback initiated by playAudio for:", textToShow.substring(0, 50) + "...");
                isAudioPlaying = true;
                updateSessionInfoDisplay();
                hideLoader();
            })
                .catch(error => {
                    console.error("[Popup Script] Error calling audioPlayer.play():", error);
                    if (statusMessage) statusMessage.textContent = "Error starting audio playback.";
                    isAudioPlaying = false;
                    currentPlayingText = "";
                    if (currentArticleDetails) currentArticleDetails.isActiveSession = false;
                    updateSessionInfoDisplay();
                    hideLoader();
                });
        } else {
            console.log("[Popup Script] Audio playback initiated (no promise).");
            isAudioPlaying = true;
            updateSessionInfoDisplay();
            hideLoader();
        }
    }

    // --- History Management ---
    async function loadHistory() {
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            const history = result.ttsHistory || [];
            historyListElement.innerHTML = '';
            if (history.length === 0) {
                const li = document.createElement('li');
                li.textContent = "No history yet.";
                li.style.cursor = 'default';
                historyListElement.appendChild(li);
                clearHistoryBtn.style.display = 'none';
            } else {
                history.forEach(item => addHistoryItemToDOM(item.text, item.audioDataUrl, false, item.title || item.text));
                clearHistoryBtn.style.display = 'block';
            }
        } catch (e) {
            console.error("[Popup Script] Error loading history:", e);
        }
    }
    async function addHistoryItemToStorage(text, audioDataUrl, articleTitle = "Audio Snippet") {
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            const newItem = {
                text: text,
                title: articleTitle,
                audioDataUrl: audioDataUrl,
                timestamp: Date.now()
            };
            history = history.filter(item => item.text !== text);
            history.unshift(newItem);
            if (history.length > MAX_HISTORY_ITEMS) {
                history = history.slice(0, MAX_HISTORY_ITEMS);
            }
            await chrome.storage.local.set({ ttsHistory: history });
            return true;
        } catch (e) {
            console.error("[Popup Script] Error saving item to history storage:", e);
            return false;
        }
    }
    function addHistoryItemToDOM(text, audioDataUrl, saveToStorage = true, displayTitle) {
        for (let i = 0; i < historyListElement.children.length; i++) {
            const child = historyListElement.children[i];
            if (child.dataset.fullText === text) {
                child.remove();
                break;
            }
        }
        if (historyListElement.firstChild && historyListElement.firstChild.textContent === "No history yet.") {
            historyListElement.innerHTML = '';
        }
        const li = document.createElement('li');
        li.dataset.fullText = text;
        const textSpan = document.createElement('span');
        textSpan.className = 'history-text';
        textSpan.textContent = displayTitle;
        textSpan.title = text;
        li.appendChild(textSpan);
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-history-item';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.title = 'Remove from history';
        deleteBtn.onclick = async (event) => {
            event.stopPropagation();
            await removeHistoryItem(text);
            li.remove();
            if (historyListElement.children.length === 0) loadHistory();
        };
        li.appendChild(deleteBtn);
        li.onclick = () => {
            console.log("[Popup Script] Playing from history. Display title:", displayTitle, "Chunk text:", text.substring(0, 50) + "...");
            stopAndResetAudioPlayer("Loading from history...");
            showLoader("Loading from history...");
            const historyArticleDetails = {
                title: displayTitle,
                textContent: text,
                isChunk: false,
                isLastChunk: true,
                isActiveSession: true
            };
            playAudio(audioDataUrl, text, historyArticleDetails);
        };
        historyListElement.insertBefore(li, historyListElement.firstChild);
        if (historyListElement.children.length > MAX_HISTORY_ITEMS) {
            historyListElement.lastChild.remove();
        }
        if (saveToStorage) {
            addHistoryItemToStorage(text, audioDataUrl, displayTitle);
        }
        clearHistoryBtn.style.display = 'block';
    }
    async function removeHistoryItem(textToRemove) {
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            history = history.filter(item => item.text !== textToRemove);
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[Popup Script] Removed item from history:", textToRemove.substring(0, 50) + "...");
        } catch (e) {
            console.error("[Popup Script] Error removing item from history storage:", e);
        }
    }
    clearHistoryBtn.addEventListener('click', async () => {
        if (confirm("Are you sure you want to clear all TTS history?")) {
            try {
                stopAndResetAudioPlayer("History cleared.");
                await chrome.storage.local.set({ ttsHistory: [] });
                loadHistory();
            } catch (e) {
                console.error("[Popup Script] Error clearing history:", e);
            }
        }
    });

    // --- Message Handling ---
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("[Popup Script] Message received:", request);

        if (request.action === "stopAndResetAudio") {
            console.log("[Popup Script] Received 'stopAndResetAudio' command.");
            stopAndResetAudioPlayer("Audio stopped. Ready for new input.");
            sendResponse({ status: "Audio player reset" });
            return false;
        }

        if (request.action === "activeSessionState") {
            console.log("[Popup Script] Received 'activeSessionState':", request.sessionData);
            if (request.sessionData && request.sessionData.isActive) {
                currentArticleDetails = request.sessionData.articleDetails;
                if (currentArticleDetails) {
                    currentArticleDetails.isActiveSession = true;
                    currentArticleDetails.currentChunkIndex = request.sessionData.currentIndex;
                    currentArticleDetails.totalChunks = request.sessionData.totalChunks;
                    currentArticleDetails.isLastChunk = (request.sessionData.currentIndex === request.sessionData.totalChunks - 1);
                    console.log("[Popup Script] Restored active session details for UI:", currentArticleDetails);
                } else {
                    console.warn("[Popup Script] Active session reported, but articleDetails missing in sessionData.");
                    currentArticleDetails = { isActiveSession: true, isChunk: false };
                }
            } else {
                console.log("[Popup Script] No active session reported by background on load.");
                currentArticleDetails = { isActiveSession: false };
            }
            updateSessionInfoDisplay();
            sendResponse({ status: "Session state received by popup" });
            return false;
        }

        if (request.action === "processTextForTTS" && request.selectedText) {
            stopAndResetAudioPlayer("Processing new text/chunk...");
            const textToProcess = request.selectedText;
            currentArticleDetails = request.articleDetails;
            currentArticleDetails.isActiveSession = true;

            console.log(`[Popup Script] 'processTextForTTS' for: "${textToProcess.substring(0, 50)}..."`, "Details:", currentArticleDetails);
            showLoader(currentArticleDetails && currentArticleDetails.isChunk ? `Loading chunk ${currentArticleDetails.currentChunkIndex + 1}...` : "Checking cache...");

            const normalizedText = textToProcess.trim();
            const cacheKey = "tts_" + normalizedText.substring(0, 200);

            chrome.storage.local.get([cacheKey], (result) => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Script] Error getting from storage:", chrome.runtime.lastError.message);
                    statusMessage.textContent = "Storage error. Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText });
                    sendResponse({ status: "Storage error, fetching from server" });
                    return;
                }
                if (result[cacheKey]) {
                    console.log("[Popup Script] Cache hit for chunk:", normalizedText);
                    playAudio(result[cacheKey], normalizedText, currentArticleDetails);
                    if (currentArticleDetails) currentArticleDetails.isLastChunk = currentArticleDetails.isLastChunk;
                    sendResponse({ status: "Playing chunk from cache" });
                } else {
                    console.log("[Popup Script] Cache miss for chunk:", normalizedText, ". Requesting from background.");
                    statusMessage.textContent = currentArticleDetails && currentArticleDetails.isChunk ? `Fetching chunk ${currentArticleDetails.currentChunkIndex + 1}...` : "Fetching from server...";
                    chrome.runtime.sendMessage({ action: "fetchTTSFromServer", textToSynthesize: normalizedText });
                    sendResponse({ status: "Cache miss, fetching chunk from server" });
                }
            });
            return true;

        } else if (request.action === "playAudioDataUrl" && request.audioDataUrl && request.originalText) {
            console.log("[Popup Script] 'playAudioDataUrl' for:", request.originalText.substring(0, 50) + "...", "Received articleDetails:", request.articleDetails);

            currentArticleDetails = request.articleDetails;
            currentArticleDetails.isActiveSession = true;

            playAudio(request.audioDataUrl, request.originalText, currentArticleDetails);

            // --- REFINED historyDisplayTitle construction ---
            let historyDisplayTitle;
            const HISTORY_ITEM_TARGET_LENGTH = 60; // User request: Target overall length for history item text
            const CHUNK_SUFFIX_APPROX_LENGTH = 10; // User request: Approx length of " (X/Y)"
            const genericTitles = ["Reading Page Content", "Selected Text", "Page Content", "Untitled Page"];

            if (currentArticleDetails && currentArticleDetails.isChunk) {
                let baseDisplayPart;
                const isTitleGeneric = !currentArticleDetails.title || genericTitles.includes(currentArticleDetails.title);
                const totalChunks = currentArticleDetails.totalChunks != null ? currentArticleDetails.totalChunks : 0;

                if (totalChunks > 1) { // Multi-chunk item, prioritize showing chunk info
                    let maxBaseLength = HISTORY_ITEM_TARGET_LENGTH - CHUNK_SUFFIX_APPROX_LENGTH;
                    if (maxBaseLength < 15) maxBaseLength = 15; // Ensure some base is shown, e.g. "Text Preview..."

                    if (!isTitleGeneric) {
                        baseDisplayPart = currentArticleDetails.title;
                    } else { // Generic title, use chunk text preview
                        baseDisplayPart = request.originalText;
                    }
                    // Truncate the base part to make space for chunk suffix
                    if (baseDisplayPart.length > maxBaseLength) {
                        baseDisplayPart = baseDisplayPart.substring(0, maxBaseLength).trim() + "...";
                    }

                    const chunkNumber = currentArticleDetails.currentChunkIndex != null ? currentArticleDetails.currentChunkIndex + 1 : '';
                    historyDisplayTitle = `${baseDisplayPart} (${chunkNumber}/${totalChunks})`; // Removed "Chunk "
                } else { // Single chunk item (totalChunks is 1 or 0)
                    if (!isTitleGeneric) {
                        baseDisplayPart = currentArticleDetails.title;
                    } else {
                        baseDisplayPart = request.originalText;
                    }
                    // Truncate if longer than target length
                    if (baseDisplayPart.length > HISTORY_ITEM_TARGET_LENGTH) {
                        baseDisplayPart = baseDisplayPart.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                    }
                    historyDisplayTitle = baseDisplayPart;
                }
            } else { // Not a chunk (e.g. context menu selection for a short text)
                let titleToUse = (currentArticleDetails && currentArticleDetails.title && currentArticleDetails.title !== "Selected Text")
                    ? currentArticleDetails.title
                    : request.originalText;
                if (titleToUse.length > HISTORY_ITEM_TARGET_LENGTH) {
                    titleToUse = titleToUse.substring(0, HISTORY_ITEM_TARGET_LENGTH - 3) + "...";
                }
                historyDisplayTitle = titleToUse;
            }
            // --- END REFINED historyDisplayTitle construction ---

            addHistoryItemToDOM(request.originalText, request.audioDataUrl, true, historyDisplayTitle);
            sendResponse({ status: "Audio received and playing, caching attempt made" });
            return false;

        } else if (request.action === "ttsErrorPopup") {
            console.error("[Popup Script] 'ttsErrorPopup' action received:", request.error);
            stopAndResetAudioPlayer(`Error: ${request.error}`);
            sendResponse({ status: "Error message acknowledged" });
            return false;
        } else if (request.action === "allChunksFinished") {
            console.log("[Popup Script] Received 'allChunksFinished' from background.");
            if (statusMessage) statusMessage.textContent = "Finished reading all page content.";
            if (currentArticleDetails) currentArticleDetails.isActiveSession = false;
            updateSessionInfoDisplay();
            currentArticleDetails = null;
            isAudioPlaying = false;
            return false;
        }
        else {
            console.warn("[Popup Script] Received unknown message action:", request.action);
            sendResponse({ status: "Unknown action" });
            return false;
        }
    });
    console.log("[Popup Script] Message listener successfully attached.");

    // --- Audio Player Event Listeners ---
    audioPlayer.onplay = () => {
        console.log("[Popup Script] Audio onplay event.");
        isAudioPlaying = true;
        isCurrentlySeeking = false;
        updateSessionInfoDisplay();
    };

    audioPlayer.onpause = () => {
        console.log("[Popup Script] Audio onpause event. Seeking flag:", isCurrentlySeeking);
        isAudioPlaying = false;
        if (!isCurrentlySeeking) {
            if (currentArticleDetails && currentArticleDetails.isActiveSession) {
                updateSessionInfoDisplay();
            }
        }
    };

    audioPlayer.onseeking = () => {
        console.log("[Popup Script] Audio onseeking event.");
        isCurrentlySeeking = true;
    };

    audioPlayer.onseeked = () => {
        console.log("[Popup Script] Audio onseeked event. Player paused after seek:", audioPlayer.paused);
        isCurrentlySeeking = false;
        if (audioPlayer.paused) {
            isAudioPlaying = false;
        }
        updateSessionInfoDisplay();
    };

    audioPlayer.onended = () => {
        console.log("[Popup Script] Audio playback finished (onended).");
        isAudioPlaying = false;
        isCurrentlySeeking = false;

        if (currentArticleDetails && currentArticleDetails.isChunk && !currentArticleDetails.isLastChunk) {
            console.log("[Popup Script] Requesting next audio chunk from background. Current chunk was:", currentArticleDetails.currentChunkIndex);
            showLoader(`Loading next chunk (finished ${currentArticleDetails.currentChunkIndex != null ? currentArticleDetails.currentChunkIndex + 1 : 'current'})...`);
            chrome.runtime.sendMessage({ action: "requestNextAudioChunk" }, response => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Script] Error requesting next chunk:", chrome.runtime.lastError.message);
                    if (statusMessage) statusMessage.textContent = "Error loading next chunk.";
                    hideLoader();
                } else {
                    console.log("[Popup Script] Next chunk request sent. Background response:", response);
                    if (response && (response.status === "noActiveSession" || response.status === "allChunksFinished")) {
                        if (statusMessage) statusMessage.textContent = "Finished reading all content.";
                        if (currentArticleDetails) currentArticleDetails.isActiveSession = false;
                        updateSessionInfoDisplay();
                        currentArticleDetails = null;
                        hideLoader();
                    }
                }
            });
        } else {
            if (statusMessage && statusMessage.textContent.startsWith("Playing")) {
                statusMessage.textContent = `Finished: ${currentPlayingText.substring(0, 50)}${currentPlayingText.length > 50 ? '...' : ''}`;
            } else if (currentArticleDetails && currentArticleDetails.isChunk && currentArticleDetails.isLastChunk) {
                if (statusMessage) statusMessage.textContent = "Finished reading all page content.";
            }
            if (currentArticleDetails) currentArticleDetails.isActiveSession = false;
            updateSessionInfoDisplay();
            currentPlayingText = "";
            currentArticleDetails = null;
        }
    };
    audioPlayer.onerror = (e) => {
        if (isHandlingAudioError) {
            console.warn("[Popup Script] Audio error occurred during reset, ignoring to prevent loop.");
            return;
        }
        isHandlingAudioError = true;
        isCurrentlySeeking = false;
        console.error("[Popup Script] Audio element error event:", e);
        console.error("[Popup Script] Audio error code:", audioPlayer.error ? audioPlayer.error.code : 'N/A',
            "Message:", audioPlayer.error ? audioPlayer.error.message : 'N/A');

        stopAndResetAudioPlayer("Audio playback error occurred.");
    };

    window.addEventListener('beforeunload', (event) => {
        if (isAudioPlaying && !audioPlayer.paused && !audioPlayer.ended) {
            console.log("[Popup Script] 'beforeunload' triggered while audio is actively playing.");
            event.preventDefault();
            event.returnValue = '';
        }
    });

    resumeButton.addEventListener('click', () => {
        console.log("[Popup Script] Resume button clicked.");
        if (currentArticleDetails && currentArticleDetails.isActiveSession &&
            typeof currentArticleDetails.currentChunkIndex === 'number') {

            showLoader("Resuming...");
            resumeButton.style.display = 'none';

            chrome.runtime.sendMessage({
                action: "resumeTTSSession",
                resumeFromChunkIndex: currentArticleDetails.currentChunkIndex
            }, response => {
                if (chrome.runtime.lastError) {
                    console.error("[Popup Script] Error sending resumeTTSSession:", chrome.runtime.lastError.message);
                    statusMessage.textContent = "Error resuming.";
                    hideLoader();
                    updateSessionInfoDisplay();
                } else {
                    console.log("[Popup Script] Resume request sent. Response:", response);
                    if (response && !response.success) {
                        statusMessage.textContent = response.error || "Failed to resume.";
                        hideLoader();
                        updateSessionInfoDisplay();
                    }
                }
            });
        } else {
            console.warn("[Popup Script] Resume clicked but no valid active session details found to resume from.");
            statusMessage.textContent = "No active session to resume.";
            resumeButton.style.display = 'none';
        }
    });

    console.log("[Popup Script] All event handlers attached.");
    hideLoader();
    audioPlayer.style.display = 'block';
    loadHistory();

    console.log("[Popup Script] Requesting initial session state from background...");
    chrome.runtime.sendMessage({ action: "requestInitialSessionState" }, response => {
        if (chrome.runtime.lastError) {
            console.warn("[Popup Script] Error requesting initial session state:", chrome.runtime.lastError.message);
            statusMessage.textContent = "Could not get session state.";
        } else if (response && response.action === "activeSessionState" && response.sessionData) {
            console.log("[Popup Script] Received initial session state:", response.sessionData);
            if (response.sessionData.isActive) {
                currentArticleDetails = response.sessionData.articleDetails;
                if (currentArticleDetails) {
                    currentArticleDetails.isActiveSession = true;
                    currentArticleDetails.currentChunkIndex = response.sessionData.currentIndex;
                    currentArticleDetails.totalChunks = response.sessionData.totalChunks;
                    currentArticleDetails.isLastChunk = (response.sessionData.currentIndex === response.sessionData.totalChunks - 1);
                    console.log("[Popup Script] Restored active session details for UI:", currentArticleDetails);
                } else {
                    console.warn("[Popup Script] Active session reported, but articleDetails missing in sessionData. Creating basic active state.");
                    currentArticleDetails = {
                        isActiveSession: true,
                        isChunk: response.sessionData.totalChunks > 1,
                        currentChunkIndex: response.sessionData.currentIndex,
                        totalChunks: response.sessionData.totalChunks,
                        title: "Active Session"
                    };
                }
            } else {
                console.log("[Popup Script] No active session reported by background on load.");
                currentArticleDetails = { isActiveSession: false };
            }
            updateSessionInfoDisplay();
        } else {
            console.log("[Popup Script] No active session reported by background or invalid response:", response);
            currentArticleDetails = { isActiveSession: false };
            updateSessionInfoDisplay();
        }
    });
});
