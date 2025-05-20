// Globally available utils for popup folder.
const MAX_TITLE_DISPLAY_LENGTH = 65; // New constant for title truncation

function getUIElements() {
    return {
        audioPlayer: document.getElementById('popupAudioPlayer'),
        statusMessage: document.getElementById('statusMessage'),
        loadingIndicator: document.getElementById('loadingIndicator'),
        currentSessionInfoDiv: document.getElementById('currentSessionInfo'),
        currentSessionTitleSpan: document.getElementById('currentSessionTitle'),
        currentSessionChunkInfoSpan: document.getElementById('currentSessionChunkInfo'),
        resumeButton: document.getElementById('resumeButton')
    };
}

function updateSessionInfoDisplay(currentArticleDetails, isAudioPlaying) {
    const ui = getUIElements();
    if (!ui.currentSessionInfoDiv || !ui.currentSessionTitleSpan || !ui.currentSessionChunkInfoSpan || !ui.resumeButton || !ui.statusMessage || !ui.audioPlayer) {
        console.warn("[uiHelpers] One or more UI elements for session display not found.");
        return;
    }

    if (currentArticleDetails && currentArticleDetails.isActiveSession) {
        ui.currentSessionInfoDiv.style.display = 'block';
        let title = currentArticleDetails.title || "Reading in Progress";
        // Use the new constant for truncation
        if (title.length > MAX_TITLE_DISPLAY_LENGTH) {
            title = title.substring(0, MAX_TITLE_DISPLAY_LENGTH) + "...";
        }
        ui.currentSessionTitleSpan.textContent = title;

        // Logic for Resume Button and Chunk Info
        if (isAudioPlaying) {
            ui.resumeButton.style.display = 'none'; 
            if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number' && currentArticleDetails.totalChunks > 1) {
                ui.currentSessionChunkInfoSpan.textContent = `Chunk ${currentArticleDetails.currentChunkIndex + 1} / ${currentArticleDetails.totalChunks}`;
            } else {
                ui.currentSessionChunkInfoSpan.textContent = ""; 
            }
            // Update main status message for playing state
            let playingStatusText = `Playing: ${(currentArticleDetails.textContent || "content").substring(0, 30)}${(currentArticleDetails.textContent || "content").length > 30 ? '...' : ''}`;
            if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                if (currentArticleDetails.totalChunks > 1) {
                    playingStatusText = `Playing chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks}...`;
                } else {
                    playingStatusText = `Playing content...`;
                }
            }
            ui.statusMessage.textContent = playingStatusText;

        } else { // Not currently playing, but session is active
            if (ui.audioPlayer.currentSrc && ui.audioPlayer.currentSrc !== "") {
                ui.resumeButton.style.display = 'none';
                if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                     if (currentArticleDetails.totalChunks > 1) {
                        ui.currentSessionChunkInfoSpan.textContent = `(Paused at Chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks})`;
                    } else {
                         ui.currentSessionChunkInfoSpan.textContent = "(Paused)";
                    }
                } else if (!currentArticleDetails.isChunk && currentArticleDetails.textContent) { 
                     ui.currentSessionChunkInfoSpan.textContent = "(Paused)";
                } else {
                     ui.currentSessionChunkInfoSpan.textContent = "(Session active)";
                }
                if (!ui.statusMessage.textContent.startsWith("Playing") && !ui.statusMessage.textContent.startsWith("Loading") && !ui.statusMessage.textContent.startsWith("Finished")) {
                     ui.statusMessage.textContent = "Session paused. Use player controls or resume.";
                }

            } else {
                ui.resumeButton.style.display = 'block';
                 if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                    ui.currentSessionChunkInfoSpan.textContent = `(Resume at Chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks})`;
                } else if (!currentArticleDetails.isChunk && currentArticleDetails.textContent) { 
                     ui.currentSessionChunkInfoSpan.textContent = "(Resume pending)";
                } else { 
                    ui.currentSessionChunkInfoSpan.textContent = "(Session active, ready to start)";
                }
                ui.statusMessage.textContent = "Session paused. Click Resume to continue.";
            }
        }
    } else { // No active session
        ui.currentSessionInfoDiv.style.display = 'none';
        ui.resumeButton.style.display = 'none';
        ui.currentSessionTitleSpan.textContent = '';
        ui.currentSessionChunkInfoSpan.textContent = '';
        if (ui.statusMessage.textContent.includes("Paused") || 
            ui.statusMessage.textContent.includes("Session active") || 
            ui.statusMessage.textContent.startsWith("Finished") || 
            ui.statusMessage.textContent.startsWith("Playing") ||
            ui.statusMessage.textContent.startsWith("Loading")) {
            ui.statusMessage.textContent = "Ready for audio.";
        }
    }
}

function showLoader(message = "Processing...") {
    const ui = getUIElements();
    if (ui.loadingIndicator) ui.loadingIndicator.style.display = 'block';
    if (ui.statusMessage) ui.statusMessage.textContent = message;
    if (ui.audioPlayer) ui.audioPlayer.style.display = 'none';
    if (ui.audioPlayer && ui.audioPlayer.HAVE_CURRENT_DATA && !ui.audioPlayer.paused) {
        ui.audioPlayer.pause();
    }
    if (ui.resumeButton) ui.resumeButton.style.display = 'none';
}

function hideLoader() {
    const ui = getUIElements();
    if (ui.loadingIndicator) ui.loadingIndicator.style.display = 'none';
    if (ui.audioPlayer) ui.audioPlayer.style.display = 'block';
    // updateSessionInfoDisplay(); // Caller should manage this based on state
}