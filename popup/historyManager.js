// historyManager.js

var HistoryManager = (function () {
    const MAX_HISTORY_ITEMS_CONST = 10;

    let historyListElementRef;
    let clearHistoryBtnRef;
    let playAudioFromHistoryCallback;
    let stopAndResetAudioPlayerCallbackH;
    let showLoaderCallbackH;

    function init(elements, callbacks) {
        console.log("[HistoryManager] Initializing...");
        historyListElementRef = elements.historyListElement;
        clearHistoryBtnRef = elements.clearHistoryBtn;

        playAudioFromHistoryCallback = callbacks.playAudioFromHistory;
        stopAndResetAudioPlayerCallbackH = callbacks.stopAndResetAudioPlayer;
        showLoaderCallbackH = callbacks.showLoader;

        if (!historyListElementRef) {
            console.error("[HistoryManager] historyListElementRef not provided during init.");
        }
        if (!clearHistoryBtnRef) {
            console.error("[HistoryManager] clearHistoryBtnRef not provided during init.");
        } else {
            clearHistoryBtnRef.addEventListener('click', async () => {
                if (confirm("Are you sure you want to clear all TTS history?")) {
                    try {
                        if (typeof stopAndResetAudioPlayerCallbackH === 'function') {
                            stopAndResetAudioPlayerCallbackH("History cleared.");
                        }
                        await chrome.storage.local.set({ ttsHistory: [] });
                        console.log("[HistoryManager] Cleared all history from storage.");
                        loadHistory();
                    } catch (e) {
                        console.error("[HistoryManager] Error clearing history:", e);
                    }
                }
            });
        }
        loadHistory();
        console.log("[HistoryManager] Initialized and history load attempted.");
    }

    async function loadHistory() {
        console.log("[HistoryManager] loadHistory called.");
        if (!historyListElementRef) {
            console.error("[HistoryManager] Cannot load history, historyListElementRef is null.");
            return;
        }
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            const history = result.ttsHistory || [];
            console.log("[HistoryManager] Loaded from storage:", history);

            historyListElementRef.innerHTML = '';
            if (history.length === 0) {
                console.log("[HistoryManager] History is empty. Displaying 'No history yet.'");
                const li = document.createElement('li');
                li.textContent = "No history yet.";
                li.style.cursor = 'default';
                historyListElementRef.appendChild(li);
            } else {
                console.log(`[HistoryManager] Populating ${history.length} history items.`);
                history.forEach(item => addHistoryItemToDOM(item.text, item.audioDataUrl, false, item.title || item.text));
            }

            if (typeof updateClearHistoryButtonVisibility === 'function') {
                console.log("[HistoryManager] Calling updateClearHistoryButtonVisibility after loading history.");
                updateClearHistoryButtonVisibility();
            } else {
                console.warn("[HistoryManager] updateClearHistoryButtonVisibility function not found from uiHelpers after loadHistory.");
            }
        } catch (e) {
            console.error("[HistoryManager] Error loading history from storage:", e);
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
            if (history.length > MAX_HISTORY_ITEMS_CONST) {
                history = history.slice(0, MAX_HISTORY_ITEMS_CONST);
            }
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[HistoryManager] Saved item to history storage. Title:", articleTitle, "Text snippet:", text.substring(0, 30) + "...");
            return true;
        } catch (e) {
            console.error("[HistoryManager] Error saving item to history storage:", e);
            return false;
        }
    }

    function addHistoryItemToDOM(text, audioDataUrl, saveToStorage = true, displayTitle) {
        console.log("[HistoryManager] addHistoryItemToDOM called. Display Title:", displayTitle, "Save to storage:", saveToStorage);
        if (!historyListElementRef) {
            console.error("[HistoryManager] Cannot add history item to DOM, historyListElementRef is null.");
            return;
        }

        for (let i = 0; i < historyListElementRef.children.length; i++) {
            const child = historyListElementRef.children[i];
            if (child.dataset.fullText === text) {
                console.log("[HistoryManager] Removing duplicate visual history item for text:", text.substring(0, 30) + "...");
                child.remove();
                break;
            }
        }

        if (historyListElementRef.firstChild && historyListElementRef.firstChild.textContent === "No history yet.") {
            historyListElementRef.innerHTML = '';
        }
        const li = document.createElement('li');
        li.dataset.fullText = text;

        const textSpan = document.createElement('span');
        textSpan.className = 'list-text';
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
            if (historyListElementRef.children.length === 0) {
                loadHistory();
            } else {
                if (typeof updateClearHistoryButtonVisibility === 'function') {
                    console.log("[HistoryManager] Calling updateClearHistoryButtonVisibility after deleting item.");
                    updateClearHistoryButtonVisibility();
                }
            }
        };
        li.appendChild(deleteBtn);

        li.onclick = () => {
            console.log("[HistoryManager] Playing from history. Display title:", displayTitle);
            if (typeof stopAndResetAudioPlayerCallbackH === 'function') {
                stopAndResetAudioPlayerCallbackH("Loading from history...");
            }
            if (typeof showLoaderCallbackH === 'function') {
                showLoaderCallbackH("Loading from history...");
            }

            const historyArticleDetails = {
                title: displayTitle,
                textContent: text,
                isChunk: false,
                isLastChunk: true,
                isActiveSession: true
            };
            if (typeof playAudioFromHistoryCallback === 'function') {
                playAudioFromHistoryCallback(audioDataUrl, text, historyArticleDetails);
            } else {
                console.error("[HistoryManager] playAudioFromHistoryCallback is not defined!");
            }
        };
        historyListElementRef.insertBefore(li, historyListElementRef.firstChild);
        if (historyListElementRef.children.length > MAX_HISTORY_ITEMS_CONST) {
            historyListElementRef.lastChild.remove();
        }

        if (saveToStorage) {
            addHistoryItemToStorage(text, audioDataUrl, displayTitle);
        }

        if (typeof updateClearHistoryButtonVisibility === 'function') {
            console.log("[HistoryManager] Calling updateClearHistoryButtonVisibility after adding item to DOM.");
            updateClearHistoryButtonVisibility();
        }
        console.log("[HistoryManager] History item added to DOM:", displayTitle);
    }

    async function removeHistoryItem(textToRemove) {
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            history = history.filter(item => item.text !== textToRemove);
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[HistoryManager] Removed item from history storage:", textToRemove.substring(0, 50) + "...");
        } catch (e) {
            console.error("[HistoryManager] Error removing item from history storage:", e);
        }
    }

    return {
        init: init,
        addHistoryItemToDOM: addHistoryItemToDOM
    };
})();
