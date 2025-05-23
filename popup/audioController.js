// audioController.js

var AudioController = (function () {
    let audioPlayerElement;
    let statusMessageElement;
    let isAudioPlayingState;
    let currentPlayingTextState;
    let currentArticleDetailsState; // This holds the full article details including autoAdvanceToNextPage
    let isHandlingAudioErrorState;
    let isCurrentlySeekingState;
    let updateSessionInfoDisplayCallback;
    let showLoaderCallback;
    let hideLoaderCallback;

    function init(elements, state, callbacks) {
        audioPlayerElement = elements.audioPlayer;
        statusMessageElement = elements.statusMessage;
        isAudioPlayingState = state.isAudioPlaying;
        currentPlayingTextState = state.currentPlayingText;
        currentArticleDetailsState = state.currentArticleDetails;
        isHandlingAudioErrorState = state.isHandlingAudioError;
        isCurrentlySeekingState = state.isCurrentlySeeking;
        updateSessionInfoDisplayCallback = callbacks.updateSessionInfoDisplay;
        showLoaderCallback = callbacks.showLoader;
        hideLoaderCallback = callbacks.hideLoader;

        if (audioPlayerElement) {
            audioPlayerElement.onplay = onAudioPlay;
            audioPlayerElement.onpause = onAudioPause;
            audioPlayerElement.onseeking = onAudioSeeking;
            audioPlayerElement.onseeked = onAudioSeeked;
            audioPlayerElement.onended = onAudioEnded;
            audioPlayerElement.onerror = onAudioError;
        } else {
            console.error("[AudioController] Audio player element not provided during init.");
        }
    }

    function playAudio(audioDataUrl, textToShow, articleDetailsForPlayback) {
        if (!audioPlayerElement) {
            console.error("[AudioController] Cannot play audio, player not initialized.");
            return;
        }
        currentPlayingTextState.value = textToShow;
        isHandlingAudioErrorState.value = false;
        isCurrentlySeekingState.value = false;
        audioPlayerElement.src = audioDataUrl;
        currentArticleDetailsState.value = articleDetailsForPlayback; // articleDetailsForPlayback should include autoAdvanceToNextPage
        if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = true;

        showLoaderCallback(currentArticleDetailsState.value && currentArticleDetailsState.value.isChunk ?
            `Loading chunk ${currentArticleDetailsState.value.currentChunkIndex + 1}...` :
            "Loading audio...");

        const playPromise = audioPlayerElement.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                // console.log("[AudioController] Playback initiated by browser for:", textToShow.substring(0, 50) + "...");
            })
                .catch(error => {
                    console.error("[AudioController] Error calling audioPlayer.play():", error);
                    if (statusMessageElement) statusMessageElement.textContent = "Error starting audio playback.";
                    isAudioPlayingState.value = false;
                    currentPlayingTextState.value = "";
                    if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;
                    updateSessionInfoDisplayCallback();
                    hideLoaderCallback();
                });
        } else {
            isAudioPlayingState.value = true;
            updateSessionInfoDisplayCallback();
            hideLoaderCallback();
        }
    }

    function stopAndResetAudioPlayer(resetMessage = "Ready for new audio.") {
        if (!audioPlayerElement) return;
        isHandlingAudioErrorState.value = true;
        audioPlayerElement.pause();
        if (audioPlayerElement.currentSrc && audioPlayerElement.currentSrc !== "") audioPlayerElement.src = '';
        isAudioPlayingState.value = false;
        isCurrentlySeekingState.value = false;
        currentPlayingTextState.value = "";
        if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;
        if (statusMessageElement) statusMessageElement.textContent = resetMessage;
        updateSessionInfoDisplayCallback();
        hideLoaderCallback();
        setTimeout(() => { isHandlingAudioErrorState.value = false; }, 100);
    }

    function onAudioPlay() {
        isAudioPlayingState.value = true;
        isCurrentlySeekingState.value = false;
        hideLoaderCallback();
        updateSessionInfoDisplayCallback();
    }

    function onAudioPause() {
        isAudioPlayingState.value = false;
        if (!isCurrentlySeekingState.value) {
            if (currentArticleDetailsState.value && currentArticleDetailsState.value.isActiveSession) {
                updateSessionInfoDisplayCallback();
            }
        }
    }

    function onAudioSeeking() { isCurrentlySeekingState.value = true; }
    
    function onAudioSeeked() {
        isCurrentlySeekingState.value = false;
        if (audioPlayerElement.paused) isAudioPlayingState.value = false;
        updateSessionInfoDisplayCallback();
    }

    async function onAudioEnded() {
        console.log("[AudioController] Audio playback finished (onended).");
        isAudioPlayingState.value = false;
        isCurrentlySeekingState.value = false;
        const details = currentArticleDetailsState.value; // This includes .autoAdvanceToNextPage

        if (details && details.isChunk && !details.isLastChunk) {
            console.log("[AudioController] Requesting next audio chunk. Current chunk was:", details.currentChunkIndex);
            try {
                const response = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: "requestNextAudioChunk" }, (responseFromBg) => {
                        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                        else resolve(responseFromBg);
                    });
                });
                if (response && (response.status === "noActiveSession" || response.status === "allChunksFinished")) {
                    if (statusMessageElement) statusMessageElement.textContent = "Finished reading all content.";
                    if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;
                    updateSessionInfoDisplayCallback();
                    currentArticleDetailsState.value = null;
                    hideLoaderCallback();
                }
            } catch (error) {
                console.error("[AudioController] Error requesting next chunk:", error.message);
                if (statusMessageElement) statusMessageElement.textContent = "Error loading next chunk.";
                hideLoaderCallback();
            }
        } else { // Last chunk of a session OR not a chunked session
            if (statusMessageElement && statusMessageElement.textContent.startsWith("Playing")) {
                statusMessageElement.textContent = `Finished: ${currentPlayingTextState.value.substring(0, 50)}${currentPlayingTextState.value.length > 50 ? '...' : ''}`;
            } else if (details && details.isChunk && details.isLastChunk) {
                if (statusMessageElement) statusMessageElement.textContent = "Finished reading all page content.";
            }

            const wasLastChunk = details && details.isChunk && details.isLastChunk;
            const wasSingleItem = details && !details.isChunk;

            if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false; // Mark session inactive for UI
            updateSessionInfoDisplayCallback(); // Update UI to show "Finished" etc.

            // currentPlayingTextState.value = ""; // Clear current playing text
            // Don't null out currentArticleDetailsState.value yet, background needs it for auto-advance check

            if (wasLastChunk || wasSingleItem) {
                console.log("[AudioController] Last chunk or single item finished. Checking auto-advance.");
                // Inform background that the session/item has finished playing.
                // Background will check currentTTSSession.autoAdvanceToNextPage.
                chrome.runtime.sendMessage({ action: "sessionFinishedCheckAutoAdvance" }, response => {
                    if (chrome.runtime.lastError) {
                        console.error("[AudioController] Error sending sessionFinishedCheckAutoAdvance:", chrome.runtime.lastError.message);
                    } else {
                        console.log("[AudioController] sessionFinishedCheckAutoAdvance sent. BG Response:", response);
                    }
                    // Background will handle resetting currentTTSSession if not auto-advancing.
                    // If auto-advancing, background handles navigation and new session start.
                    // The popup UI will be updated via messages from background for the new state.
                });
            }
        }
    }

    function onAudioError(e) {
        if (isHandlingAudioErrorState.value) {
            console.warn("[AudioController] Audio error occurred during reset, ignoring to prevent loop.");
            return;
        }
        isHandlingAudioErrorState.value = true;
        isCurrentlySeekingState.value = false;
        console.error("[AudioController] Audio element error event:", e);
        console.error("[AudioController] Audio error code:", audioPlayerElement.error ? audioPlayerElement.error.code : 'N/A',
            "Message:", audioPlayerElement.error ? audioPlayerElement.error.message : 'N/A');
        stopAndResetAudioPlayer("Audio playback error occurred.");
    }

    // Public API for this module
    return {
        init: init,
        playAudio: playAudio,
        stopAndResetAudioPlayer: stopAndResetAudioPlayer
    };
})();
