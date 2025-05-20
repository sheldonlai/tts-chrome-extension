// plugin.js
document.addEventListener('DOMContentLoaded', () => {
    console.log("[Plugin] DOMContentLoaded. Initializing plugin script.");

    const openTTSWindowBtn = document.getElementById('openTTSWindowBtn');
    const readPageContentBtn = document.getElementById('readPageContentBtn');
    const messageArea = document.getElementById('messageArea');

    function updateMessage(text, isError = false) {
        if (messageArea) {
            messageArea.textContent = text;
            messageArea.style.color = isError ? 'red' : '#555';
        }
        console.log(`[Plugin] Message updated: ${text}${isError ? ' (ERROR)' : ''}`);
    }

    if (!openTTSWindowBtn) {
        console.error("[Plugin] 'openTTSWindowBtn' not found in plugin.html.");
        updateMessage("Error: UI button 'openTTSWindowBtn' missing.", true);
    }
    if (!readPageContentBtn) {
        console.error("[Plugin] 'readPageContentBtn' not found in plugin.html.");
        updateMessage("Error: UI button 'readPageContentBtn' missing.", true);
    }
    if (!messageArea) {
        console.warn("[Plugin] 'messageArea' not found in plugin.html.");
    }


    if (openTTSWindowBtn) {
        openTTSWindowBtn.addEventListener('click', () => {
            console.log("[Plugin] 'Open Text-to-Speech' button clicked.");
            updateMessage("Opening TTS window...");
            
            chrome.runtime.sendMessage({ action: "openTTSWindow" }, (response) => {
                console.log("[Plugin] Response received for 'openTTSWindow'. lastError:", chrome.runtime.lastError, "Response object:", response);
                if (chrome.runtime.lastError) {
                    console.error("[Plugin] Error sending 'openTTSWindow' message:", chrome.runtime.lastError.message);
                    updateMessage(`Error: ${chrome.runtime.lastError.message}`, true);
                } else if (response) {
                    if (response.status === "ttsWindowOpened") {
                        updateMessage("TTS window opened/focused.");
                    } else if (response.status === "errorOpeningTTSWindow") {
                        updateMessage(`Error: ${response.error || "Could not open TTS window."}`, true);
                    } else {
                        updateMessage("TTS window action initiated. Status: " + (response.status || "unknown"));
                    }
                } else {
                    // This case might happen if background.js doesn't send a response at all
                    updateMessage("No specific response from background for 'openTTSWindow'. Assuming action initiated.", true);
                }
                // Attempt to close the plugin popup after processing
                setTimeout(() => {
                    console.log("[Plugin] Attempting to close 'openTTSWindow' popup.");
                    window.close();
                }, 1500); // Increased delay slightly
            });
        });
    }

    if (readPageContentBtn) {
        readPageContentBtn.addEventListener('click', () => {
            console.log("[Plugin] 'Read Page Content' button clicked.");
            updateMessage("Getting page content for TTS...");
            
            chrome.runtime.sendMessage({ action: "getSimplifiedContentForTTS" }, (response) => {
                console.log("[Plugin] Response received for 'getSimplifiedContentForTTS'. lastError:", chrome.runtime.lastError, "Response object:", response);
                if (chrome.runtime.lastError) {
                    console.error("[Plugin] Error sending 'getSimplifiedContentForTTS' message:", chrome.runtime.lastError.message);
                    updateMessage(`Error: ${chrome.runtime.lastError.message}`, true);
                } else if (response) {
                    if (response.success) {
                        console.log("[Plugin] Page content processing for TTS initiated. Background response:", response.message);
                        updateMessage(response.message || "Page content sent for TTS.");
                    } else {
                        const errorMsg = response.error || "Unknown error from background processing page content.";
                        console.error("[Plugin] Failed to initiate page content reading:", errorMsg);
                        updateMessage(`Failed: ${errorMsg}`, true);
                    }
                } else {
                     // This case might happen if background.js doesn't send a response at all
                    updateMessage("No specific response from background for 'getSimplifiedContentForTTS'. Assuming action initiated.", true);
                }
                // Attempt to close the plugin popup after processing
                setTimeout(() => {
                    console.log("[Plugin] Attempting to close 'readPageContentBtn' popup.");
                    window.close();
                }, 1500); // Increased delay slightly
            });
        });
    }
    console.log("[Plugin] Event listeners attached.");
});
