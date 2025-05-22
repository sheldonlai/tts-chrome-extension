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
                if (confirm("Are you sure you want to clear all TTS data, including history and current audio session?")) {
                    try {
                        if (typeof stopAndResetAudioPlayerCallbackH === 'function') {
                            stopAndResetAudioPlayerCallbackH("All data cleared.");
                        }
                        await chrome.storage.local.set({ ttsHistory: [] });
                        chrome.runtime.sendMessage({ action: "clearPersistedTTSSession_Background" }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.error("[HistoryManager] Error sending clearPersistedTTSSession_Background message:", chrome.runtime.lastError.message);
                            } else {
                                console.log("[HistoryManager] Clear persisted session message sent to background. Response:", response);
                            }
                        });
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

    function getGroupingKey(itemTitle) {
        if (typeof itemTitle !== 'string') {
            console.warn('[HistoryManager DBG] getGroupingKey received non-string itemTitle:', itemTitle, '. Using empty string as fallback for key generation.');
            itemTitle = '';
        }
        console.log(`[HistoryManager DBG] getGroupingKey - Input itemTitle: "${itemTitle}"`);

        const chunkPattern = /\s*\([\d\s]+\/[\d\s]+\)$/;
        let titleWithoutChunkInfo = itemTitle.replace(chunkPattern, "").trim();
        console.log(`[HistoryManager DBG] getGroupingKey - titleWithoutChunkInfo: "${titleWithoutChunkInfo}"`);


        if (titleWithoutChunkInfo.length === 0 && itemTitle.length > 0) {
            console.log(`[HistoryManager DBG] getGroupingKey - titleWithoutChunkInfo was empty, returning original itemTitle: "${itemTitle}"`);
            return itemTitle;
        }

        return titleWithoutChunkInfo;
    }


    async function loadHistory() {
        console.log("[HistoryManager] loadHistory called for refined grouped display.");
        if (!historyListElementRef) {
            console.error("[HistoryManager] Cannot load history, historyListElementRef is null.");
            return;
        }
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            const historyItems = result.ttsHistory || [];
            console.log("[HistoryManager] Loaded from storage for grouping:", JSON.parse(JSON.stringify(historyItems)));

            historyListElementRef.innerHTML = '';

            if (historyItems.length === 0) {
                console.log("[HistoryManager] History is empty. Displaying 'No history yet.'");
                const li = document.createElement('li');
                li.textContent = "No history yet.";
                li.style.cursor = 'default';
                li.style.textAlign = 'center';
                li.style.color = '#6c757d';
                li.style.padding = '10px';
                historyListElementRef.appendChild(li);
            } else {
                const groups = new Map();
                historyItems.forEach(item => {
                    const currentItemTitle = (typeof item.title === 'string' && item.title.trim() !== "") ? item.title.trim() : "Untitled History Item (from loadHistory)";
                    console.log(`[HistoryManager DBG] Processing item for grouping. Original item.title: "${item.title}", Corrected currentItemTitle: "${currentItemTitle}"`);
                    const key = getGroupingKey(currentItemTitle);
                    console.log(`[HistoryManager DBG] Grouping key for "${currentItemTitle}": "${key}"`);


                    if (!groups.has(key)) {
                        groups.set(key, []);
                    }
                    groups.get(key).push({ ...item, title: currentItemTitle });
                });

                console.log("[HistoryManager DBG] Groups created:", JSON.parse(JSON.stringify(Array.from(groups.entries()))));


                groups.forEach((itemsInGroup, groupKey) => {
                    const displayGroupKey = groupKey || "Miscellaneous";
                    console.log(`[HistoryManager DBG] Rendering group. displayGroupKey: "${displayGroupKey}", itemsInGroup count: ${itemsInGroup.length}`);


                    if (itemsInGroup.length > 1 && displayGroupKey !== itemsInGroup[0].title) {
                        const groupLi = document.createElement('li');
                        groupLi.classList.add('history-group');

                        const prefixSpan = document.createElement('span');
                        prefixSpan.className = 'history-group-prefix';
                        prefixSpan.textContent = displayGroupKey;
                        groupLi.appendChild(prefixSpan);

                        const subUl = document.createElement('ul');
                        subUl.className = 'history-group-items';
                        itemsInGroup.forEach(item => {
                            let displaySuffixForSubItem = "";
                            const chunkPattern = /\(([\d\s]+\/[\d\s]+)\)$/;
                            const match = item.title.match(chunkPattern);

                            if (match) {
                                displaySuffixForSubItem = `(${match[1]})`;
                            } else {
                                if (item.title.startsWith(displayGroupKey) && item.title.length > displayGroupKey.length) {
                                    let tempSuffix = item.title.substring(displayGroupKey.length).trim();
                                    displaySuffixForSubItem = tempSuffix || "(details)";
                                } else if (item.title !== displayGroupKey) {
                                    displaySuffixForSubItem = item.title;
                                } else {
                                    displaySuffixForSubItem = "(details)";
                                }
                            }
                            console.log(`[HistoryManager DBG] Sub-item for group "${displayGroupKey}". Original item.title: "${item.title}", displaySuffixForSubItem: "${displaySuffixForSubItem}"`);
                            subUl.appendChild(createHistoryEntryLi(item, displaySuffixForSubItem, true));
                        });
                        groupLi.appendChild(subUl);
                        historyListElementRef.appendChild(groupLi);
                    } else {
                        itemsInGroup.forEach(item => {
                            console.log(`[HistoryManager DBG] Rendering single item. Original item.title: "${item.title}"`);
                            historyListElementRef.appendChild(createHistoryEntryLi(item, item.title, false));
                        });
                    }
                });
            }

            if (typeof window.updateClearHistoryButtonVisibility === 'function') {
                window.updateClearHistoryButtonVisibility();
            }
        } catch (e) {
            console.error("[HistoryManager] Error loading or grouping history from storage:", e);
        }
    }

    function createHistoryEntryLi(itemData, displayContent, isSubItem) {
        const li = document.createElement('li');

        if (isSubItem) {
            li.classList.add('history-sub-item');
        }

        const textSpan = document.createElement('span');
        textSpan.className = 'list-text';
        textSpan.textContent = displayContent;
        textSpan.title = itemData.text;
        li.appendChild(textSpan);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-history-item';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.title = 'Remove from history';
        deleteBtn.onclick = async (event) => {
            event.stopPropagation();
            await removeHistoryItemFromStorage(itemData.text);
            loadHistory();
        };
        li.appendChild(deleteBtn);

        li.onclick = () => {
            console.log("[HistoryManager] Playing from history. Original item title for playback:", itemData.title);
            if (typeof stopAndResetAudioPlayerCallbackH === 'function') {
                stopAndResetAudioPlayerCallbackH("Loading from history...");
            }
            if (typeof showLoaderCallbackH === 'function') {
                showLoaderCallbackH("Loading from history...");
            }

            const historyArticleDetails = {
                title: itemData.title,
                textContent: itemData.text,
                isChunk: false,
                isLastChunk: true,
                isActiveSession: true
            };
            if (typeof playAudioFromHistoryCallback === 'function') {
                playAudioFromHistoryCallback(itemData.audioDataUrl, itemData.text, historyArticleDetails);
            } else {
                console.error("[HistoryManager] playAudioFromHistoryCallback is not defined!");
            }
        };
        return li;
    }


    async function addHistoryItemToStorage(text, audioDataUrl, displayTitle) {
        // displayTitle is the value received from addHistoryItemToDOMAndStorage
        let titleToStore = "Untitled Audio (from storage)"; // Default fallback
        if (typeof displayTitle === 'string') {
            const trimmedTitle = displayTitle.trim();
            if (trimmedTitle !== "") {
                titleToStore = trimmedTitle;
            }
        }
        console.log(`[HistoryManager DBG] addHistoryItemToStorage - Received displayTitle: "${displayTitle}" (Type: ${typeof displayTitle}), Trimmed: "${typeof displayTitle === 'string' ? displayTitle.trim() : 'N/A'}", Title to store: "${titleToStore}"`);

        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            const newItem = {
                text: text,
                title: titleToStore,
                audioDataUrl: audioDataUrl,
                timestamp: Date.now()
            };
            history = history.filter(item => item.text !== text);
            history.unshift(newItem);
            if (history.length > MAX_HISTORY_ITEMS_CONST) {
                history = history.slice(0, MAX_HISTORY_ITEMS_CONST);
            }
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[HistoryManager] Saved item to history storage. Title stored:", newItem.title);
            return true;
        } catch (e) {
            console.error("[HistoryManager] Error saving item to history storage:", e);
            return false;
        }
    }

    async function addHistoryItemToDOMAndStorage(text, audioDataUrl, displayTitle) {
        // This displayTitle comes directly from popup.js
        console.log(`[HistoryManager DBG] addHistoryItemToDOMAndStorage called. Received displayTitle from popup.js: "${displayTitle}" (Type: ${typeof displayTitle})`);
        // The actual fallback and trimming for storage happens in addHistoryItemToStorage
        await addHistoryItemToStorage(text, audioDataUrl, displayTitle);
        loadHistory();
    }


    async function removeHistoryItemFromStorage(textToRemove) {
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
        addHistoryItemToDOM: addHistoryItemToDOMAndStorage,
        loadHistory: loadHistory
    };
})();
