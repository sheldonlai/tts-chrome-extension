// historyManager.js

var HistoryManager = (function () {
    const MAX_HISTORY_ITEMS_CONST = 10;

    // Module-scoped variables
    let historyListElementRef;
    let clearHistoryBtnRef;
    let playAudioFromHistoryCallback;
    let stopAndResetAudioPlayerCallbackH; // Renamed to avoid conflict if not careful
    let showLoaderCallbackH; // Renamed

    function init(elements, callbacks) {
        console.log("[HistoryManager] Initializing...");
        historyListElementRef = elements.historyListElement;
        clearHistoryBtnRef = elements.clearHistoryBtn;

        playAudioFromHistoryCallback = callbacks.playAudioFromHistory;
        stopAndResetAudioPlayerCallbackH = callbacks.stopAndResetAudioPlayer;
        showLoaderCallbackH = callbacks.showLoader;

        if (clearHistoryBtnRef) {
            clearHistoryBtnRef.addEventListener('click', async () => {
                if (confirm("Are you sure you want to clear all TTS history?")) {
                    try {
                        stopAndResetAudioPlayerCallbackH("History cleared.");
                        await chrome.storage.local.set({ ttsHistory: [] });
                        loadHistory();
                    } catch (e) {
                        console.error("[HistoryManager] Error clearing history:", e);
                    }
                }
            });
        } else {
            console.error("[HistoryManager] Clear history button not provided during init.");
        }
        loadHistory();
        console.log("[HistoryManager] Initialized and history loaded.");
    }

    async function loadHistory() {
        if (!historyListElementRef) return;
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            const history = result.ttsHistory || [];
            historyListElementRef.innerHTML = '';
            if (history.length === 0) {
                const li = document.createElement('li');
                li.textContent = "No history yet.";
                li.style.cursor = 'default';
                historyListElementRef.appendChild(li);
                if (clearHistoryBtnRef) clearHistoryBtnRef.style.display = 'none';
            } else {
                history.forEach(item => addHistoryItemToDOM(item.text, item.audioDataUrl, false, item.title || item.text));
                if (clearHistoryBtnRef) clearHistoryBtnRef.style.display = 'block';
            }
        } catch (e) {
            console.error("[HistoryManager] Error loading history:", e);
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
            console.log("[HistoryManager] Saved item to history storage:", articleTitle);
            return true;
        } catch (e) {
            console.error("[HistoryManager] Error saving item to history storage:", e);
            return false;
        }
    }

    function addHistoryItemToDOM(text, audioDataUrl, saveToStorage = true, displayTitle) {
        if (!historyListElementRef) return;

        for (let i = 0; i < historyListElementRef.children.length; i++) {
            const child = historyListElementRef.children[i];
            if (child.dataset.fullText === text) {
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
            if (historyListElementRef.children.length === 0) loadHistory();
        };
        li.appendChild(deleteBtn);

        li.onclick = () => {
            console.log("[HistoryManager] Playing from history. Display title:", displayTitle);
            stopAndResetAudioPlayerCallbackH("Loading from history...");
            showLoaderCallbackH("Loading from history...");

            const historyArticleDetails = {
                title: displayTitle,
                textContent: text,
                isChunk: false,
                isLastChunk: true,
                isActiveSession: true
            };
            playAudioFromHistoryCallback(audioDataUrl, text, historyArticleDetails);
        };
        historyListElementRef.insertBefore(li, historyListElementRef.firstChild);
        if (historyListElementRef.children.length > MAX_HISTORY_ITEMS_CONST) {
            historyListElementRef.lastChild.remove();
        }

        if (saveToStorage) {
            addHistoryItemToStorage(text, audioDataUrl, displayTitle);
        }
        if (clearHistoryBtnRef) clearHistoryBtnRef.style.display = 'block';
    }

    async function removeHistoryItem(textToRemove) {
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            history = history.filter(item => item.text !== textToRemove);
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[HistoryManager] Removed item from history:", textToRemove.substring(0, 50) + "...");
        } catch (e) {
            console.error("[HistoryManager] Error removing item from history storage:", e);
        }
    }

    // Public API for this module
    return {
        init: init,
        addHistoryItemToDOM: addHistoryItemToDOM // Expose if main popup.js needs to call it directly
        // loadHistory is called internally on init
    };
})();
