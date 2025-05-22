// historyManager.js

var HistoryManager = (function () {
    const MAX_HISTORY_ITEMS_CONST = 10;

    let historyListElementRef;
    let clearHistoryBtnRef;
    let playAudioFromHistoryCallback; // This will be AudioController.playAudio
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
                // Modern browsers support a more subtle confirmation, but standard confirm is fine for extensions
                if (confirm("Are you sure you want to clear all TTS data, including history and current audio session? This will also clear cached audio files.")) {
                    try {
                        if (typeof stopAndResetAudioPlayerCallbackH === 'function') {
                            stopAndResetAudioPlayerCallbackH("All data cleared.");
                        }
                        // Clear history from storage
                        await chrome.storage.local.set({ ttsHistory: [] });
                        // Tell background to clear its persisted session and audio caches
                        chrome.runtime.sendMessage({ action: "clearPersistedTTSSession_Background" }, (response) => {
                            if (chrome.runtime.lastError) {
                                console.error("[HistoryManager] Error sending clearPersistedTTSSession_Background message:", chrome.runtime.lastError.message);
                            } else {
                                console.log("[HistoryManager] Clear persisted session and cache message sent to background. Response:", response);
                            }
                        });
                        console.log("[HistoryManager] Cleared all history from storage and requested background data clear.");
                        loadHistory(); // Reload to show empty list
                    } catch (e) {
                        console.error("[HistoryManager] Error clearing history:", e);
                    }
                }
            });
        }
        loadHistory();
        console.log("[HistoryManager] Initialized and history load attempted.");
    }

    // This function is primarily for grouping and might not be strictly necessary
    // if titles are unique enough or if grouping isn't a primary concern.
    // For now, it tries to get a base title if there's chunk info.
    function getGroupingKey(itemTitle) {
        if (typeof itemTitle !== 'string') {
            itemTitle = '';
        }
        // Example: "My Long Article Title (1/5)" -> "My Long Article Title"
        const chunkPattern = /\s*\([\d\s]+\/[\d\s]+\)$/;
        let titleWithoutChunkInfo = itemTitle.replace(chunkPattern, "").trim();
        return titleWithoutChunkInfo || itemTitle; // Fallback to full title if pattern removes everything
    }


    async function loadHistory() {
        // console.log("[HistoryManager] loadHistory called.");
        if (!historyListElementRef) {
            console.error("[HistoryManager] Cannot load history, historyListElementRef is null.");
            return;
        }
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            const historyItems = result.ttsHistory || [];
            // console.log("[HistoryManager] Loaded from storage:", JSON.parse(JSON.stringify(historyItems)));

            historyListElementRef.innerHTML = ''; // Clear current list

            if (historyItems.length === 0) {
                const li = document.createElement('li');
                li.textContent = "No history yet.";
                li.style.cursor = 'default';
                li.style.textAlign = 'center';
                li.style.color = '#6c757d';
                li.style.padding = '10px';
                historyListElementRef.appendChild(li);
            } else {
                // Grouping logic (optional, can be simplified if not strictly needed)
                const groups = new Map();
                historyItems.forEach(item => {
                    // Ensure item.title is a string, fallback if not (shouldn't happen with new saving logic)
                    const currentItemFullTitle = (typeof item.title === 'string' && item.title.trim() !== "") ? item.title.trim() : "Untitled History Item";
                    const key = getGroupingKey(currentItemFullTitle); // Group by base title

                    if (!groups.has(key)) {
                        groups.set(key, []);
                    }
                    // Store the full item, which includes the full title and other articleDetails
                    groups.get(key).push({ ...item, title: currentItemFullTitle });
                });

                groups.forEach((itemsInGroup, groupKey) => {
                    const displayGroupKey = groupKey || "Miscellaneous";

                    if (itemsInGroup.length > 1 && displayGroupKey !== itemsInGroup[0].title) {
                        // Create group header
                        const groupLi = document.createElement('li');
                        groupLi.classList.add('history-group');
                        const prefixSpan = document.createElement('span');
                        prefixSpan.className = 'history-group-prefix';
                        prefixSpan.textContent = displayGroupKey; // Show the (potentially shorter) group key
                        groupLi.appendChild(prefixSpan);

                        const subUl = document.createElement('ul');
                        subUl.className = 'history-group-items';
                        itemsInGroup.forEach(item => { // item here is the full history item
                            // For sub-items, display might just be chunk info or a distinguishing part
                            let displaySuffixForSubItem = "";
                            const chunkPattern = /\(([\d\s]+\/[\d\s]+)\)$/;
                            const match = item.title.match(chunkPattern); // Use full item.title
                            if (match) displaySuffixForSubItem = `Chunk ${match[1].replace('/', ' of ')}`;
                            else if (item.title.startsWith(displayGroupKey) && item.title.length > displayGroupKey.length) {
                                displaySuffixForSubItem = item.title.substring(displayGroupKey.length).trim() || "(details)";
                            } else displaySuffixForSubItem = item.title; // Fallback to full title if no good suffix

                            subUl.appendChild(createHistoryEntryLi(item, displaySuffixForSubItem, true));
                        });
                        groupLi.appendChild(subUl);
                        historyListElementRef.appendChild(groupLi);
                    } else {
                        // Render single items or groups where group key is the same as the item title
                        itemsInGroup.forEach(item => {
                            historyListElementRef.appendChild(createHistoryEntryLi(item, item.title, false)); // Display full title
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

    // itemData now includes the full articleDetails object
    function createHistoryEntryLi(itemData, displayContentForList, isSubItem) {
        const li = document.createElement('li');
        if (isSubItem) li.classList.add('history-sub-item');

        const textSpan = document.createElement('span');
        textSpan.className = 'list-text'; // This class should handle text-overflow: ellipsis in CSS
        textSpan.textContent = displayContentForList; // This is the (potentially truncated) text for the list item
        textSpan.title = itemData.title; // Tooltip shows the full title from itemData.title
        li.appendChild(textSpan);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-history-item';
        deleteBtn.innerHTML = '&times;'; // "x" symbol
        deleteBtn.title = 'Remove from history';
        deleteBtn.onclick = async (event) => {
            event.stopPropagation(); // Prevent li's onclick from firing
            await removeHistoryItemFromStorage(itemData.text, itemData.timestamp); // Use text and timestamp for uniqueness
            loadHistory(); // Refresh list
        };
        li.appendChild(deleteBtn);

        li.onclick = () => {
            console.log("[HistoryManager] Playing from history. Full title for playback:", itemData.title);
            if (typeof stopAndResetAudioPlayerCallbackH === 'function') {
                stopAndResetAudioPlayerCallbackH("Loading from history...");
            }
            if (typeof showLoaderCallbackH === 'function') {
                showLoaderCallbackH("Loading from history...");
            }

            // Construct the articleDetails for playback using the stored itemData.
            // itemData itself should now be the full articleDetails object.
            const playbackArticleDetails = {
                ...itemData.articleDetails, // Spread all stored details (like chunks, simplifiedHtml etc.)
                title: itemData.title,       // Ensure the full title is used
                textContent: itemData.text,    // The specific text content of this history item
                isActiveSession: true,       // Mark as active for UI updates
                isChunk: itemData.articleDetails ? itemData.articleDetails.isChunk : false, // Restore chunk status
                currentChunkIndex: itemData.articleDetails ? itemData.articleDetails.currentChunkIndex : 0,
                totalChunks: itemData.articleDetails && itemData.articleDetails.chunks ? itemData.articleDetails.chunks.length : 1,
                isLastChunk: itemData.articleDetails ? (itemData.articleDetails.currentChunkIndex === (itemData.articleDetails.chunks ? itemData.articleDetails.chunks.length - 1 : 0)) : true,
                chunks: itemData.articleDetails ? itemData.articleDetails.chunks : [itemData.text]
            };

            if (typeof playAudioFromHistoryCallback === 'function') {
                playAudioFromHistoryCallback(itemData.audioDataUrl, itemData.text, playbackArticleDetails);
            } else {
                console.error("[HistoryManager] playAudioFromHistoryCallback is not defined!");
            }
        };
        return li;
    }

    // `fullTitleToStore` is the complete, untruncated title.
    // `originalArticleDetails` is the complete object from the TTS processing, containing title, chunks, etc.
    async function addHistoryItemToStorage(text, audioDataUrl, fullTitleToStore, originalArticleDetails) {
        let titleForStorage = "Untitled Audio (History Storage)"; // Fallback
        if (typeof fullTitleToStore === 'string' && fullTitleToStore.trim() !== "") {
            titleForStorage = fullTitleToStore.trim();
        }
        // console.log(`[HistoryManager] addHistoryItemToStorage - Title to store: "${titleForStorage}"`);

        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            const newItem = {
                text: text, // The actual text content that was spoken
                title: titleForStorage, // The full title for this item
                audioDataUrl: audioDataUrl,
                timestamp: Date.now(),
                articleDetails: originalArticleDetails // Store the whole articleDetails object
            };
            // Remove previous entries with the same text content to avoid duplicates, keep most recent
            history = history.filter(item => item.text !== text);
            history.unshift(newItem); // Add new item to the beginning
            if (history.length > MAX_HISTORY_ITEMS_CONST) {
                history = history.slice(0, MAX_HISTORY_ITEMS_CONST); // Keep only the newest N items
            }
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[HistoryManager] Saved item to history storage. Stored Title:", newItem.title);
            return true;
        } catch (e) {
            console.error("[HistoryManager] Error saving item to history storage:", e);
            return false;
        }
    }

    // `fullTitle` is the untruncated title.
    // `articleDetailsForStorage` is the full object to store.
    async function addHistoryItemToDOMAndStorage(text, audioDataUrl, fullTitle, articleDetailsForStorage) {
        // console.log(`[HistoryManager] addHistoryItemToDOMAndStorage. Full title for storage: "${fullTitle}"`);
        await addHistoryItemToStorage(text, audioDataUrl, fullTitle, articleDetailsForStorage);
        loadHistory(); // Refresh the displayed list
    }

    // Use text and timestamp to identify item for removal, as titles/text might not be unique enough alone
    async function removeHistoryItemFromStorage(textToRemove, timestampToRemove) {
        try {
            const result = await chrome.storage.local.get(['ttsHistory']);
            let history = result.ttsHistory || [];
            history = history.filter(item => !(item.text === textToRemove && item.timestamp === timestampToRemove));
            await chrome.storage.local.set({ ttsHistory: history });
            console.log("[HistoryManager] Removed item from history storage based on text and timestamp.");
        } catch (e) {
            console.error("[HistoryManager] Error removing item from history storage:", e);
        }
    }

    return {
        init: init,
        addHistoryItemToDOM: addHistoryItemToDOMAndStorage, // Expose the correct function
        loadHistory: loadHistory
    };
})();
