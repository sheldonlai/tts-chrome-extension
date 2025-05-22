// uiHelpers.js
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
        clearHistoryBtn: document.getElementById('clearHistoryBtn'),

        playerAreaWrapper: document.getElementById('playerAreaWrapper') // Corrected ID
    };
}

window.updateClearHistoryButtonVisibility = function () {
    const ui = getUIElements();
    if (!ui.clearHistoryBtn) {
        console.warn("[uiHelpers] Clear All Data button not found during visibility check.");
        return;
    }
    // console.log("[uiHelpers] updateClearHistoryButtonVisibility called (button is always visible).");
}

function setupCollapsibleLists() {
    // console.log("[uiHelpers] setupCollapsibleLists invoked.");
    const ui = getUIElements();

    function toggleList(listElement, headerElement, storageKey) {
        if (!listElement || !headerElement) {
            console.warn("[uiHelpers] toggleList: Missing listElement or headerElement for:", headerElement ? headerElement.id : 'Unknown header');
            return;
        }

        const isNowCollapsed = listElement.classList.toggle('collapsed');
        // console.log(`[uiHelpers] Toggling list for ${headerElement.id}. Is NOW collapsed: ${isNowCollapsed}.`);

        headerElement.classList.toggle('collapsed-header', isNowCollapsed);
        headerElement.classList.toggle('expanded-header', !isNowCollapsed);

        if (storageKey) {
            chrome.storage.local.set({ [storageKey]: isNowCollapsed }, () => {
                if (chrome.runtime.lastError) {
                    console.error(`[uiHelpers] Error saving collapse state for ${storageKey}:`, chrome.runtime.lastError.message);
                }
            });
        }
    }

    if (ui.toggleSessionQueueBtn && ui.sessionQueueList) {
        ui.toggleSessionQueueBtn.addEventListener('click', () => {
            // console.log("[uiHelpers] toggleSessionQueueBtn CLICKED.");
            toggleList(ui.sessionQueueList, ui.toggleSessionQueueBtn);
        });
        if (ui.sessionQueueContainer && ui.sessionQueueContainer.style.display !== 'none') {
            ui.toggleSessionQueueBtn.classList.add('expanded-header');
            ui.toggleSessionQueueBtn.classList.remove('collapsed-header');
            ui.sessionQueueList.classList.remove('collapsed');
        } else {
            ui.toggleSessionQueueBtn.classList.add('collapsed-header');
            ui.toggleSessionQueueBtn.classList.remove('expanded-header');
            ui.sessionQueueList.classList.add('collapsed');
        }
        // console.log("[uiHelpers] Session queue toggle listener ATTACHED.");
    } else {
        console.warn("[uiHelpers] Session queue toggle button or list not found during setup.");
    }

    if (ui.toggleHistoryListBtn && ui.historyListElement) {
        const historyCollapsedKey = 'historyListCollapsed';
        chrome.storage.local.get([historyCollapsedKey], (result) => {
            if (chrome.runtime.lastError) {
                console.error(`[uiHelpers] Error getting collapse state for ${historyCollapsedKey}:`, chrome.runtime.lastError.message);
            }
            const shouldBeCollapsed = result[historyCollapsedKey] !== undefined ? result[historyCollapsedKey] : true;
            // console.log(`[uiHelpers] Initial history collapsed state from storage for ${historyCollapsedKey}: ${shouldBeCollapsed}`);

            if (shouldBeCollapsed) {
                ui.historyListElement.classList.add('collapsed');
                ui.toggleHistoryListBtn.classList.add('collapsed-header');
                ui.toggleHistoryListBtn.classList.remove('expanded-header');
            } else {
                ui.historyListElement.classList.remove('collapsed');
                ui.toggleHistoryListBtn.classList.remove('collapsed-header');
                ui.toggleHistoryListBtn.classList.add('expanded-header');
            }
            window.updateClearHistoryButtonVisibility();
        });

        if (ui.toggleHistoryListBtn instanceof HTMLElement) {
            ui.toggleHistoryListBtn.addEventListener('click', () => {
                // console.log("[uiHelpers] toggleHistoryListBtn CLICKED.");
                toggleList(ui.historyListElement, ui.toggleHistoryListBtn, historyCollapsedKey);
            });
            // console.log("[uiHelpers] History list toggle listener ATTACHED.");
        } else {
            console.error("[uiHelpers] toggleHistoryListBtn is not a valid HTMLElement.");
        }
    } else {
        console.warn("[uiHelpers] History list toggle button or list not found during setup.");
    }
    // console.log("[uiHelpers] Collapsible lists setup completed.");
}


function updateSessionInfoDisplay(currentArticleDetails, isAudioPlaying) {
    const ui = getUIElements();
    if (!ui.currentSessionInfoDiv || !ui.currentSessionTitleSpan || !ui.currentSessionChunkInfoSpan || !ui.resumeButton || !ui.statusMessage || !ui.audioPlayer || !ui.sessionQueueContainer) {
        console.warn("[uiHelpers] Missing elements for updateSessionInfoDisplay.");
        return;
    }

    if (currentArticleDetails && currentArticleDetails.isActiveSession) {
        ui.currentSessionInfoDiv.style.display = 'block';
        let title = currentArticleDetails.title || "Reading in Progress";
        ui.currentSessionTitleSpan.textContent = title;

        // Sliding title logic
        const titleSpan = ui.currentSessionTitleSpan;
        const wrapper = titleSpan.parentElement;

        titleSpan.classList.remove('sliding');
        titleSpan.style.animationName = '';
        titleSpan.style.animationDuration = '';

        void titleSpan.offsetWidth; // Force reflow

        console.log(`[uiHelpers Title Check] Title: "${title}", scrollWidth: ${titleSpan.scrollWidth}, clientWidth: ${wrapper ? wrapper.clientWidth : 'N/A'}`);

        if (wrapper && titleSpan.scrollWidth > wrapper.clientWidth) {
            console.log("[uiHelpers Title Check] Applying sliding animation.");
            const speed = 40; // pixels per second

            const keyframesId = `dynamicMarquee-${titleSpan.id || 'currentSessionTitleMarquee'}`;
            // Scroll from on-screen left to off-screen left, then repeat (reappears on-screen left)
            const dynamicKeyframes = `
                @keyframes ${keyframesId} {
                    0%   { transform: translateX(0); } /* Start on-screen left */
                    100% { transform: translateX(-${titleSpan.scrollWidth}px); } /* End off-screen left */
                }
            `;

            let styleSheet = document.getElementById('dynamicMarqueeStyles');
            if (styleSheet) {
                styleSheet.innerHTML = dynamicKeyframes;
            } else {
                console.warn("[uiHelpers] Dynamic stylesheet for marquee not found.");
            }

            titleSpan.style.animationName = keyframesId;

            // Duration for one full pass (from on-screen left to off-screen left)
            const totalDistance = titleSpan.scrollWidth; // Only the part that scrolls off
            let totalAnimationDuration = totalDistance / speed;

            if (totalAnimationDuration < 3) totalAnimationDuration = 3;
            if (totalAnimationDuration > 60) totalAnimationDuration = 60;

            titleSpan.style.animationDuration = `${totalAnimationDuration}s`;
            titleSpan.classList.add('sliding');
        } else {
            console.log("[uiHelpers Title Check] No overflow, not applying sliding animation.");
            titleSpan.classList.remove('sliding');
            titleSpan.style.animationName = '';
            titleSpan.style.animationDuration = '';
        }


        if (currentArticleDetails.isChunk && currentArticleDetails.totalChunks > 1) {
            ui.sessionQueueContainer.style.display = 'block';
            if (ui.sessionQueueList && ui.sessionQueueList.classList.contains('collapsed')) {
                ui.sessionQueueList.classList.remove('collapsed');
                if (ui.toggleSessionQueueBtn) {
                    ui.toggleSessionQueueBtn.classList.remove('collapsed-header');
                    ui.toggleSessionQueueBtn.classList.add('expanded-header');
                }
            }
        } else {
            ui.sessionQueueContainer.style.display = 'none';
        }

        if (isAudioPlaying) {
            ui.resumeButton.style.display = 'none';
            if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number' && currentArticleDetails.totalChunks > 1) {
                ui.currentSessionChunkInfoSpan.textContent = `Playing ${currentArticleDetails.currentChunkIndex + 1} / ${currentArticleDetails.totalChunks}`;
            } else {
                ui.currentSessionChunkInfoSpan.textContent = "Playing";
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
            if (ui.audioPlayer.currentSrc && ui.audioPlayer.currentSrc !== "" && !ui.audioPlayer.ended) {
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
                if (ui.statusMessage && !ui.statusMessage.textContent.startsWith("Playing") && !ui.statusMessage.textContent.startsWith("Loading") && !ui.statusMessage.textContent.startsWith("Finished") && !ui.statusMessage.textContent.startsWith("Error")) {
                    ui.statusMessage.textContent = "Session paused. Use player controls to resume.";
                }
            } else {
                ui.resumeButton.style.display = 'block';
                if (currentArticleDetails.isChunk && typeof currentArticleDetails.currentChunkIndex === 'number' && typeof currentArticleDetails.totalChunks === 'number') {
                    ui.currentSessionChunkInfoSpan.textContent = `(Resume at Chunk ${currentArticleDetails.currentChunkIndex + 1} of ${currentArticleDetails.totalChunks})`;
                } else if (!currentArticleDetails.isChunk && currentArticleDetails.textContent) {
                    ui.currentSessionChunkInfoSpan.textContent = "(Resume pending)";
                } else {
                    if (ui.audioPlayer.ended && currentArticleDetails.isLastChunk) {
                        ui.currentSessionChunkInfoSpan.textContent = "(Finished)";
                        ui.resumeButton.style.display = 'none';
                    } else {
                        ui.currentSessionChunkInfoSpan.textContent = "(Session active, ready to start)";
                    }
                }
                if (ui.statusMessage) {
                    if (ui.audioPlayer.ended && currentArticleDetails.isLastChunk) {
                        ui.statusMessage.textContent = "Finished reading all content.";
                    } else {
                        ui.statusMessage.textContent = "Session paused. Click Resume to continue.";
                    }
                }
            }
        }
    } else {
        ui.currentSessionInfoDiv.style.display = 'block';
        ui.resumeButton.style.display = 'none';
        ui.sessionQueueContainer.style.display = 'none';
        ui.currentSessionTitleSpan.textContent = 'Please select audio to play';
        ui.currentSessionTitleSpan.classList.remove('sliding');
        ui.currentSessionTitleSpan.style.animationName = '';
        ui.currentSessionTitleSpan.style.animationDuration = '';
        ui.currentSessionChunkInfoSpan.textContent = '';
        if (ui.statusMessage && (ui.statusMessage.textContent.includes("Paused") ||
            ui.statusMessage.textContent.includes("Session active") ||
            ui.statusMessage.textContent.startsWith("Finished") ||
            ui.statusMessage.textContent.startsWith("Playing") ||
            ui.statusMessage.textContent.startsWith("Loading"))) {
            if (!ui.statusMessage.textContent.startsWith("Error") && !ui.statusMessage.textContent.startsWith("All data cleared")) {
                ui.statusMessage.textContent = "Ready for audio.";
            }
        }
    }
    window.updateClearHistoryButtonVisibility();
}

function showLoader(message = "Processing...") {
    const ui = getUIElements();
    if (ui.loadingIndicator) ui.loadingIndicator.style.display = 'flex';
    if (ui.playerAreaWrapper) ui.playerAreaWrapper.style.display = 'none';
    if (ui.statusMessage) ui.statusMessage.textContent = message;

    if (ui.audioPlayer && ui.audioPlayer.HAVE_CURRENT_DATA && !ui.audioPlayer.paused) {
        try {
            ui.audioPlayer.pause();
        } catch (e) {
            console.warn("[uiHelpers] Error pausing audio in showLoader:", e);
        }
    }
    if (ui.resumeButton) ui.resumeButton.style.display = 'none';
    // console.log("[uiHelpers] showLoader called. Message:", message);
}

function hideLoader() {
    const ui = getUIElements();
    if (ui.loadingIndicator) ui.loadingIndicator.style.display = 'none';
    if (ui.playerAreaWrapper) ui.playerAreaWrapper.style.display = 'block';
    // console.log("[uiHelpers] hideLoader called.");
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
        if (ui.toggleSessionQueueBtn && ui.sessionQueueList.classList.contains('collapsed')) {
            ui.sessionQueueList.classList.remove('collapsed');
            ui.toggleSessionQueueBtn.classList.remove('collapsed-header');
            ui.toggleSessionQueueBtn.classList.add('expanded-header');
        }


        chunks.forEach((chunkText, index) => {
            const li = document.createElement('li');
            li.textContent = `Part ${index + 1}: ${chunkText.substring(0, 50)}${chunkText.length > 50 ? '...' : ''}`;
            li.title = chunkText;
            if (index === currentChunkIndex) {
                li.classList.add('current-chunk');
            }
            li.dataset.chunkIndex = index;
            li.addEventListener('click', () => {
                if (typeof onChunkClickCallback === 'function') {
                    onChunkClickCallback(index);
                }
            });
            ui.sessionQueueList.appendChild(li);
        });
    } else {
        ui.sessionQueueContainer.style.display = 'none';
    }
}
