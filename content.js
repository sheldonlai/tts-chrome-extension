// content.js

console.log("[Content Script] Initializing content.js - Version 3 (char limit chunking).");

if (typeof Readability === 'undefined') {
    console.error("[Content Script] FATAL: Readability.js is not loaded or defined! Check manifest.json paths and ensure the library file is correct.");
} else {
    console.log("[Content Script] Readability object IS available globally.");
}

function splitTextIntoChunks(text, maxChunkLength = 1500, preferredSplitChars = ['.', '?', '!', ';']) {
    const chunks = [];
    if (!text || text.trim().length === 0) {
        return chunks;
    }

    let remainingText = text.trim();

    while (remainingText.length > 0) {
        if (remainingText.length <= maxChunkLength) {
            chunks.push(remainingText);
            remainingText = "";
        } else {
            let splitAt = -1;
            // Try to find a preferred split character near the maxChunkLength
            for (let i = maxChunkLength; i > maxChunkLength / 2; i--) {
                if (preferredSplitChars.includes(remainingText[i])) {
                    splitAt = i + 1; // Include the punctuation
                    break;
                }
            }

            if (splitAt === -1) {
                // If no preferred char, try to find a space
                splitAt = remainingText.lastIndexOf(' ', maxChunkLength);
            }

            if (splitAt === -1 || splitAt === 0) {
                // If no space found, or space is at the beginning, force split at maxChunkLength
                splitAt = maxChunkLength;
            }

            chunks.push(remainingText.substring(0, splitAt).trim());
            remainingText = remainingText.substring(splitAt).trim();
        }
    }
    return chunks.filter(chunk => chunk.length > 0); // Ensure no empty chunks
}


function extractAndChunkTextContent() {
    console.log("[Content Script] extractAndChunkTextContent() called.");
    if (typeof Readability === 'undefined') {
        console.error("[Content Script] Readability is not available in extractAndChunkTextContent.");
        return null;
    }

    const documentClone = document.cloneNode(true);
    let article;
    try {
        const reader = new Readability(documentClone);
        article = reader.parse();
    } catch (e) {
        console.error("[Content Script] Error during Readability.parse():", e);
        return null;
    }

    if (article && article.textContent) {
        console.log("[Content Script] Readability parsed article successfully. Title:", article.title, "Original Text Length:", article.textContent.length);

        const preliminaryChunks = article.textContent.split(/\n\s*\n/); // Split by paragraph first
        const finalChunks = [];

        preliminaryChunks.forEach(pChunk => {
            const trimmedPChunk = pChunk.trim();
            if (trimmedPChunk.length > 0) {
                if (trimmedPChunk.length > 1500) { // Target character limit for a chunk
                    console.log(`[Content Script] Paragraph chunk too long (${trimmedPChunk.length} chars), further splitting.`);
                    const subChunks = splitTextIntoChunks(trimmedPChunk, 1500);
                    finalChunks.push(...subChunks);
                } else {
                    finalChunks.push(trimmedPChunk);
                }
            }
        });

        if (finalChunks.length === 0 && article.textContent.trim().length > 0) {
            console.warn("[Content Script] Readability extracted text, but it resulted in zero valid chunks. Using entire textContent as fallback.");
            finalChunks.push(article.textContent.trim());
        } else if (finalChunks.length === 0) {
            console.warn("[Content Script] article.textContent was empty after trimming or no chunks generated.");
            return null;
        }

        console.log(`[Content Script] Text split into ${finalChunks.length} final chunks.`);

        return {
            title: article.title || "Untitled Page",
            textContentChunks: finalChunks,
            simplifiedHtml: article.content,
            excerpt: article.excerpt,
            length: article.length
        };
    } else {
        console.warn("[Content Script] Readability could not parse an article or textContent was empty.");
        if (article) {
            console.log("[Content Script] Article object from Readability:", article);
        }
        return null;
    }
}

try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        console.log("[Content Script] Message listener invoked. Request received:", request);

        if (request.action === "extractReadablePageContent") {
            console.log("[Content Script] 'extractReadablePageContent' action received from background.");
            const articleDataWithChunks = extractAndChunkTextContent();

            if (articleDataWithChunks && articleDataWithChunks.textContentChunks && articleDataWithChunks.textContentChunks.length > 0) {
                console.log("[Content Script] Successfully extracted and chunked content. Sending response to background. Chunks:", articleDataWithChunks.textContentChunks.length);
                sendResponse({ success: true, data: articleDataWithChunks });
            } else {
                console.error("[Content Script] Failed to extract or chunk content. Sending error response to background.");
                sendResponse({ success: false, error: "Could not extract or chunk readable content from the page using Readability.js." });
            }
            return true;
        }
    });
    console.log("[Content Script] Message listener successfully attached.");

} catch (e) {
    console.error("[Content Script] CRITICAL: Error attaching message listener in content.js:", e);
}

console.log("[Content Script] Reached end of content.js execution. Waiting for messages.");
