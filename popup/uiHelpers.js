// uiHelpers.js

const MAX_TITLE_DISPLAY_LENGTH = 65;

function getUIElements() {
    return {
        audioPlayer: document.getElementById('popupAudioPlayer'),
        statusMessage: document.getElementById('statusMessage'),
        loadingIndicator: document.getElementById('loadingIndicator'),

        currentSessionInfoDiv: document.getElementById('currentSessionInfo'),
        currentSessionTitleSpan: document.getElementById('currentSessionTitle'),
        currentSessionChunkInfoSpan: document.getElementById('currentSessionChunkInfo'),
        resumeButton: document.getElementById('resumeButton'),

        sessionQueueContainer: document.getElementById('sessionQueueContainer'),
        sessionQueueList: document.getElementById('sessionQueueList'),
        toggleSessionQueueBtn: document.getElementById('toggleSessionQueue'),

        historyContainer: document.getElementById('historyContainer'),
        historyListElement: document.getElementById('historyList'),
        toggleHistoryListBtn: document.getElementById('toggleHistoryList'),
        clearHistoryBtn: document.getElementById('clearHistoryBtn')
    };
}

function updateClearHistoryButtonVisibility() {
    const ui = getUIElements();
    if (!ui.historyListElement || !ui.clearHistoryBtn) {
        return;
    }
    const isHistoryListCollapsed = ui.historyListElement.classList.contains('collapsed');
    const hasHistoryItems = ui.historyListElement.children.length > 0 &&
        !(ui.historyListElement.children.length === 1 && ui.historyListElement.firstChild.textContent === "No history yet.");

    const newDisplay = (!isHistoryListCollapsed && hasHistoryItems) ? 'block' : 'none';
    if (ui.clearHistoryBtn.style.display !== newDisplay) {
        ui.clearHistoryBtn.style.display = newDisplay;
    }
}

// This function should be called ONLY ONCE from popup.js after DOMContentLoaded
function setupCollapsibleLists() {
    console.log("[uiHelpers] setupCollapsibleLists invoked.");

    const ui = getUIElements();

    function toggleList(listElement, headerElement, storageKey) {
        if (!listElement || !headerElement) {
            console.warn("[uiHelpers] toggleList: Missing listElement or headerElement for:", headerElement ? headerElement.id : 'Unknown header');
            return;
        }
        const wasCollapsed = listElement.classList.contains('collapsed');
        const isNowCollapsed = listElement.classList.toggle('collapsed');

        console.log(`[uiHelpers] Toggling list for ${headerElement.id}. Was collapsed: ${wasCollapsed}. Is NOW collapsed: ${isNowCollapsed}.`);

        headerElement.classList.toggle('collapsed-header', isNowCollapsed);
        headerElement.classList.toggle('expanded-header', !isNowCollapsed);

        if (isNowCollapsed) {
            headerElement.textContent = headerElement.textContent.replace('▼', '▶');
        } else {
            headerElement.textContent = headerElement.textContent.replace('▶', '▼');
        }

        if (storageKey) {
            chrome.storage.local.set({ [storageKey]: isNowCollapsed });
        }

        if (listElement.id === 'historyList') {
            updateClearHistoryButtonVisibility();
        }
    }

    if (ui.toggleSessionQueueBtn && ui.sessionQueueList) {
        // Simplified listener attachment (assuming setupCollapsibleLists is called once)
        ui.toggleSessionQueueBtn.addEventListener('click', () => {
            console.log("[uiHelpers] toggleSessionQueueBtn CLICKED.");
            toggleList(ui.sessionQueueList, ui.toggleSessionQueueBtn);
        });
        console.log("[uiHelpers] Session queue toggle listener ATTACHED to element:", ui.toggleSessionQueueBtn);

        // Initial arrow state for session queue
        if (ui.sessionQueueList.classList.contains('collapsed')) {
            ui.toggleSessionQueueBtn.textContent = ui.toggleSessionQueueBtn.textContent.replace('▼', '▶');
            ui.toggleSessionQueueBtn.classList.add('collapsed-header');
            ui.toggleSessionQueueBtn.classList.remove('expanded-header');
        } else {
            ui.toggleSessionQueueBtn.textContent = ui.toggleSessionQueueBtn.textContent.replace('▶', '▼');
            ui.toggleSessionQueueBtn.classList.add('expanded-header');
            ui.toggleSessionQueueBtn.classList.remove('collapsed-header');
        }
    } else {
        console.warn("[uiHelpers] Session queue toggle button or list not found during setup.");
    }

    if (ui.toggleHistoryListBtn && ui.historyListElement) {
        const historyCollapsedKey = 'historyListCollapsed';

        chrome.storage.local.get([historyCollapsedKey], (result) => {
            const shouldBeCollapsed = result[historyCollapsedKey] !== undefined ? result[historyCollapsedKey] : true;
            console.log(`[uiHelpers] Initial history collapsed state from storage for ${historyCollapsedKey}: ${shouldBeCollapsed}`);

            if (shouldBeCollapsed) {
                ui.historyListElement.classList.add('collapsed');
                ui.toggleHistoryListBtn.classList.add('collapsed-header');
                ui.toggleHistoryListBtn.classList.remove('expanded-header');
                ui.toggleHistoryListBtn.textContent = ui.toggleHistoryListBtn.textContent.replace('▼', '▶');
            } else {
                ui.historyListElement.classList.remove('collapsed');
                ui.toggleHistoryListBtn.classList.remove('collapsed-header');
                ui.toggleHistoryListBtn.classList.add('expanded-header');
                ui.toggleHistoryListBtn.textContent = ui.toggleHistoryListBtn.textContent.replace('▶', '▼');
            }
            updateClearHistoryButtonVisibility();
        });

        // Simplified listener attachment (assuming setupCollapsibleLists is called once)
        console.log("[uiHelpers] Attempting to attach listener to toggleHistoryListBtn:", ui.toggleHistoryListBtn);
        if (ui.toggleHistoryListBtn instanceof HTMLElement) { // Check if it's a valid element
            ui.toggleHistoryListBtn.addEventListener('click', () => {
                console.log("[uiHelpers] toggleHistoryListBtn CLICKED.");
                toggleList(ui.historyListElement, ui.toggleHistoryListBtn, historyCollapsedKey);
            });
            console.log("[uiHelpers] History list toggle listener ATTACHED.");
        } else {
            console.error("[uiHelpers] toggleHistoryListBtn is not a valid HTMLElement. Cannot attach listener.");
        }
    } else {
        console.warn("[uiHelpers] History list toggle button or list not found during setup.");
    }
    console.log("[uiHelpers] Collapsible lists setup completed.");
}


function updateSessionInfoDisplay(currentArticleDetails, isAudioPlaying) {
    const ui = getUIElements();
    if (!ui.currentSessionInfoDiv || !ui.currentSessionTitleSpan || !ui.currentSessionChunkInfoSpan || !ui.resumeButton || !ui.statusMessage || !ui.audioPlayer || !ui.sessionQueueContainer) {
        return;
    }

    if (currentArticleDetails && currentArticleDetails.isActiveSession) {
        ui.currentSessionInfoDiv.style.display = 'block';
        let title = currentArticleDetails.title || "Reading in Progress";
        if (title.length > MAX_TITLE_DISPLAY_LENGTH) {
            title = title.substring(0, MAX_TITLE_DISPLAY_LENGTH) + "...";
        }
        ui.currentSessionTitleSpan.textContent = title;

        if (currentArticleDetails.isChunk && currentArticleDetails.totalChunks > 1) {
            ui.sessionQueueContainer.style.display = 'block';
        } else {
            ui.sessionQueueContainer.style.display = 'none';
        }

        if (isAudioPlaying) {
            ui.resumeButton.style.display = 'none';
            if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number' && currentArticleDetails.totalChunks > 1) {
                ui.currentSessionChunkInfoSpan.textContent = `Chunk ${currentArticleDetails.currentChunkIndex + 1} / ${currentArticleDetails.totalChunks}`;
            } else {
                ui.currentSessionChunkInfoSpan.textContent = "";
            }
            let playingStatusText = `Playing: ${(currentArticleDetails.textContent || "content").substring(0, 30)}${(currentArticleDetails.textContent || "content").length > 30 ? '...' : ''}`;
            if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                if (currentArticleDetails.totalChunks > 1) {
                    playingStatusText = `Playing chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks}...`;
                } else {
                    playingStatusText = `Playing content...`;
                }
            }
            ui.statusMessage.textContent = playingStatusText;
        } else {
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
                if (ui.statusMessage && !ui.statusMessage.textContent.startsWith("Playing") && !ui.statusMessage.textContent.startsWith("Loading") && !ui.statusMessage.textContent.startsWith("Finished")) {
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
                if (ui.statusMessage) ui.statusMessage.textContent = "Session paused. Click Resume to continue.";
            }
        }
    } else {
        ui.currentSessionInfoDiv.style.display = 'none';
        ui.resumeButton.style.display = 'none';
        ui.sessionQueueContainer.style.display = 'none';
        ui.currentSessionTitleSpan.textContent = '';
        ui.currentSessionChunkInfoSpan.textContent = '';
        if (ui.statusMessage && (ui.statusMessage.textContent.includes("Paused") ||
            ui.statusMessage.textContent.includes("Session active") ||
            ui.statusMessage.textContent.startsWith("Finished") ||
            ui.statusMessage.textContent.startsWith("Playing") ||
            ui.statusMessage.textContent.startsWith("Loading"))) {
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
    console.log("[uiHelpers] showLoader called. Message:", message);
}

function hideLoader() {
    const ui = getUIElements();
    if (ui.loadingIndicator) ui.loadingIndicator.style.display = 'none';
    if (ui.audioPlayer) ui.audioPlayer.style.display = 'block';
    console.log("[uiHelpers] hideLoader called.");
}

function renderSessionQueue(chunks, currentChunkIndex, onChunkClickCallback) {
    const ui = getUIElements();
    if (!ui.sessionQueueList || !ui.sessionQueueContainer) {
        console.warn("[uiHelpers] Session queue UI elements not found for rendering.");
        return;
    }
    ui.sessionQueueList.innerHTML = '';
    if (chunks && chunks.length > 1) {
        ui.sessionQueueContainer.style.display = 'block';
        if (ui.sessionQueueList.classList.contains('collapsed')) {
            ui.sessionQueueList.classList.remove('collapsed');
            ui.toggleSessionQueueBtn.classList.remove('collapsed-header');
            ui.toggleSessionQueueBtn.classList.add('expanded-header');
            ui.toggleSessionQueueBtn.textContent = ui.toggleSessionQueueBtn.textContent.replace('▶', '▼');
        }

        chunks.forEach((chunkText, index) => {
            const li = document.createElement('li');
            li.className = 'list-text';
            li.textContent = `Part ${index + 1}: ${chunkText.substring(0, 50)}${chunkText.length > 50 ? '...' : ''}`;
            li.title = chunkText;
            if (index === currentChunkIndex) {
                li.classList.add('current-chunk');
            }
            li.dataset.chunkIndex = index;
            li.addEventListener('click', () => {
                onChunkClickCallback(index);
            });
            ui.sessionQueueList.appendChild(li);
        });
    } else {
        ui.sessionQueueContainer.style.display = 'none';
    }
}

