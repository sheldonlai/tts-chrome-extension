// audioController.js

var AudioController = (function () {
    // Module-scoped variables (private to this IIFE)
    let audioPlayerElement;
    let statusMessageElement;

    // State references (objects passed in, allowing shared state)
    let isAudioPlayingState;
    let currentPlayingTextState;
    let currentArticleDetailsState;
    let isHandlingAudioErrorState;
    let isCurrentlySeekingState;

    // Callbacks to functions in other modules (e.g., uiHelpers or main popup.js)
    let updateSessionInfoDisplayCallback;
    let showLoaderCallback;
    let hideLoaderCallback;

    function init(elements, state, callbacks) {
        console.log("[AudioController] Initializing...");
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

        // Attach event listeners
        if (audioPlayerElement) {
            audioPlayerElement.onplay = onAudioPlay;
            audioPlayerElement.onpause = onAudioPause;
            audioPlayerElement.onseeking = onAudioSeeking;
            audioPlayerElement.onseeked = onAudioSeeked;
            audioPlayerElement.onended = onAudioEnded;
            audioPlayerElement.onerror = onAudioError;
            console.log("[AudioController] Event listeners attached to audio player.");
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
        currentArticleDetailsState.value = articleDetailsForPlayback;
        if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = true;

        // Show loader immediately when playAudio is called, before play() promise
        // This loader will be very brief if the audio is already a data URL.
        showLoaderCallback(currentArticleDetailsState.value && currentArticleDetailsState.value.isChunk ?
            `Loading chunk ${currentArticleDetailsState.value.currentChunkIndex + 1}...` :
            "Loading audio...");

        const playPromise = audioPlayerElement.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log("[AudioController] Playback initiated by browser for:", textToShow.substring(0, 50) + "...");
                // Actual UI update to "playing" state and hiding loader is handled by onAudioPlay
            })
                .catch(error => {
                    console.error("[AudioController] Error calling audioPlayer.play():", error);
                    if (statusMessageElement) statusMessageElement.textContent = "Error starting audio playback.";
                    isAudioPlayingState.value = false;
                    currentPlayingTextState.value = "";
                    if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;
                    updateSessionInfoDisplayCallback();
                    hideLoaderCallback(); // Ensure loader is hidden on error too
                });
        } else {
            console.log("[AudioController] Audio playback initiated (no promise).");
            isAudioPlayingState.value = true;
            updateSessionInfoDisplayCallback();
            hideLoaderCallback();
        }
    }

    function stopAndResetAudioPlayer(resetMessage = "Ready for new audio.") {
        if (!audioPlayerElement) {
            console.error("[AudioController] Cannot stop/reset, player not initialized.");
            return;
        }
        console.log("[AudioController] Stopping and resetting audio player. Message:", resetMessage);
        isHandlingAudioErrorState.value = true; // Prevent error loops during reset
        audioPlayerElement.pause();
        if (audioPlayerElement.currentSrc && audioPlayerElement.currentSrc !== "") audioPlayerElement.src = ''; // Clear source

        isAudioPlayingState.value = false;
        isCurrentlySeekingState.value = false;
        currentPlayingTextState.value = "";
        if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;

        if (statusMessageElement) statusMessageElement.textContent = resetMessage;
        updateSessionInfoDisplayCallback();
        hideLoaderCallback();
        setTimeout(() => { isHandlingAudioErrorState.value = false; }, 100); // Reset error handling flag after a short delay
    }

    // --- Audio Element Event Handlers (private to this module) ---
    function onAudioPlay() {
        console.log("[AudioController] Audio onplay event.");
        isAudioPlayingState.value = true;
        isCurrentlySeekingState.value = false;
        hideLoaderCallback(); // Hide loader once playback actually starts
        updateSessionInfoDisplayCallback();
    }

    function onAudioPause() {
        console.log("[AudioController] Audio onpause event. Seeking flag:", isCurrentlySeekingState.value);
        isAudioPlayingState.value = false;
        if (!isCurrentlySeekingState.value) { // Only update UI if not part of a seek operation
            if (currentArticleDetailsState.value && currentArticleDetailsState.value.isActiveSession) {
                updateSessionInfoDisplayCallback();
            }
        }
    }

    function onAudioSeeking() {
        console.log("[AudioController] Audio onseeking event.");
        isCurrentlySeekingState.value = true;
        // Optionally show loader during seek if it's long, but usually seeks are fast
        // showLoaderCallback("Seeking..."); 
    }

    function onAudioSeeked() {
        console.log("[AudioController] Audio onseeked event. Player paused after seek:", audioPlayerElement.paused);
        isCurrentlySeekingState.value = false;
        // hideLoaderCallback(); // Hide loader if shown during seek
        if (audioPlayerElement.paused) { // If seek was done while paused
            isAudioPlayingState.value = false;
        }
        updateSessionInfoDisplayCallback();
    }

    async function onAudioEnded() {
        console.log("[AudioController] Audio playback finished (onended).");
        isAudioPlayingState.value = false;
        isCurrentlySeekingState.value = false;
        const details = currentArticleDetailsState.value;

        if (details && details.isChunk && !details.isLastChunk) {
            console.log("[AudioController] Requesting next audio chunk. Current chunk was:", details.currentChunkIndex);
            // REMOVED: showLoaderCallback call here. Loader will be handled by playAudio or explicit call in popup.js.

            try {
                const response = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: "requestNextAudioChunk" }, (responseFromBg) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(responseFromBg);
                        }
                    });
                });

                console.log("[AudioController] Next chunk request sent. Background response:", response);
                if (response && (response.status === "noActiveSession" || response.status === "allChunksFinished")) {
                    if (statusMessageElement) statusMessageElement.textContent = "Finished reading all content.";
                    if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;
                    updateSessionInfoDisplayCallback();
                    currentArticleDetailsState.value = null; // Clear details as session ended
                    hideLoaderCallback(); // Ensure loader is hidden if it was somehow shown
                }
                // If status is "processingNextChunk" or "sentPrefetchedAudio", 
                // background.js will send a new message to popup.js.
                // `popup.js` will then call `AudioController.playAudio` (for prefetched) or `showLoader` (for processing).
            } catch (error) {
                console.error("[AudioController] Error requesting next chunk:", error.message);
                if (statusMessageElement) statusMessageElement.textContent = "Error loading next chunk.";
                hideLoaderCallback(); // Ensure loader is hidden on error
            }
        } else { // Last chunk or not a chunked session
            if (statusMessageElement && statusMessageElement.textContent.startsWith("Playing")) {
                statusMessageElement.textContent = `Finished: ${currentPlayingTextState.value.substring(0, 50)}${currentPlayingTextState.value.length > 50 ? '...' : ''}`;
            } else if (details && details.isChunk && details.isLastChunk) {
                if (statusMessageElement) statusMessageElement.textContent = "Finished reading all page content.";
            }
            if (currentArticleDetailsState.value) currentArticleDetailsState.value.isActiveSession = false;
            updateSessionInfoDisplayCallback();
            currentPlayingTextState.value = ""; // Clear current playing text
            currentArticleDetailsState.value = null; // Clear details
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
