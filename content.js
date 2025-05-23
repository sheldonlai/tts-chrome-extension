// content.js

console.log("[Content Script] Initializing content.js - Version 4 (link extraction).");

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

    // It's crucial to clone the document for Readability to avoid altering the live DOM
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
            title: article.title || document.title || "Untitled Page", // Fallback to document.title
            textContentChunks: finalChunks,
            simplifiedHtml: article.content, // This is the main readable content HTML
            excerpt: article.excerpt,
            length: article.length,
            sourceURL: window.location.href // Add current page URL
        };
    } else {
        console.warn("[Content Script] Readability could not parse an article or textContent was empty.");
        if (article) {
            console.log("[Content Script] Article object from Readability:", article);
        }
        // Fallback to trying to get basic info if Readability fails
        return {
            title: document.title || "Untitled Page",
            textContentChunks: splitTextIntoChunks(document.body.innerText || "", 1500), // Basic fallback
            simplifiedHtml: null,
            excerpt: (document.body.innerText || "").substring(0, 150),
            length: (document.body.innerText || "").length,
            sourceURL: window.location.href
        };
    }
}

/**
 * Extracts and filters <a> tags from the current DOM.
 * @returns {object} An object containing currentUrl, currentTitle, and a filtered, deduplicated list of links.
 */
function extractPageLinkData() {
    console.log("[Content Script] extractPageLinkData() called.");
    const currentUrl = window.location.href;
    const currentOrigin = new URL(currentUrl).origin;
    const currentPathname = new URL(currentUrl).pathname;
    const currentTitle = document.title || "Untitled Page";
    const allAnchorTags = document.getElementsByTagName('a');
    const candidateLinks = []; // Store candidates before deduplication

    const excludedUrlPatterns = [
        "javascript:void(0)",
        "mailto:",
        "tel:",
        "/login",
        "/signup",
        "/register",
        "/privacy",
        "/terms",
        "/contact",
        "/about",
        "/sitemap",
        "/store",
        "/cart",
        "/checkout",
        "/search",
        "/profile",
        "/user",
        "/account",
        "/feed",
        "/rss",
        "/author/",
        "/tag/",
        "/category/",
        "/genre/" // Added to catch all genre links specifically
    ];

    const excludedTextPatterns = [
        "login", "log in", "sign in", "signin",
        "signup", "sign up", "register",
        "privacy policy", "terms of service", "terms & conditions",
        "contact us", "about us",
        "sitemap", "search",
        "profile", "my account", "settings",
        "share on", "tweet", "facebook", "pinterest", "linkedin", // Social media
        "download", "subscribe", "add to cart", "buy now",
        "advertisement", "ads by",
        "cookie policy", "accessibility"
    ];

    for (let i = 0; i < allAnchorTags.length; i++) {
        const anchor = allAnchorTags[i];
        let rawHref = anchor.getAttribute('href');

        if (!rawHref || rawHref.trim() === "" || rawHref.startsWith('#')) {
            continue;
        }

        let absoluteHref;
        try {
            absoluteHref = new URL(rawHref, currentUrl).href;
        } catch (e) {
            if (excludedUrlPatterns.some(pattern => rawHref.toLowerCase().includes(pattern.toLowerCase()))) {
                continue;
            }
            console.warn(`[Content Script] Could not parse href: '${rawHref}'. Skipping.`);
            continue;
        }
        
        if (!absoluteHref.startsWith('http:') && !absoluteHref.startsWith('https:')) {
            continue;
        }

        if (absoluteHref.split('#')[0] === currentUrl.split('#')[0]) {
            try {
                const linkUrlObj = new URL(absoluteHref);
                if (linkUrlObj.origin === currentOrigin && linkUrlObj.pathname === currentPathname && linkUrlObj.hash !== "") {
                    continue;
                }
            } catch(e) { /* ignore */ }
        }

        const linkText = (anchor.innerText || anchor.title || "").trim();
        const linkTextLower = linkText.toLowerCase();
        const hrefLower = absoluteHref.toLowerCase();

        if (excludedUrlPatterns.some(pattern => hrefLower.includes(pattern.toLowerCase()))) {
            continue;
        }

        if (excludedTextPatterns.some(pattern => linkTextLower.includes(pattern.toLowerCase()))) {
            if (!(linkTextLower.includes("next") || linkTextLower.includes("prev"))) {
                 continue;
            }
        }
        
        if (!linkText && !anchor.getAttribute('title')) {
            let hasNavSymbol = anchor.innerHTML.includes('>') || anchor.innerHTML.includes('&gt;') ||
                               anchor.innerHTML.includes('»') || anchor.innerHTML.includes('&raquo;');
            let looksLikeNumericalNav = false;
            const pathParts = currentPathname.split('/');
            const lastPathPart = pathParts.pop() || pathParts.pop();
            const numMatch = lastPathPart ? lastPathPart.match(/\d+/) : null;
            if (numMatch) {
                const currentNum = parseInt(numMatch[0]);
                if (hrefLower.includes(String(currentNum + 1)) || hrefLower.includes(String(currentNum -1))) {
                    looksLikeNumericalNav = true;
                }
            }
            if (!hasNavSymbol && !looksLikeNumericalNav) {
                continue;
            }
        }

        candidateLinks.push({
            href: absoluteHref,
            text: linkText || anchor.title || absoluteHref
        });
    }

    // Deduplication step
    const uniqueLinks = [];
    const seenHrefs = new Set();
    for (const link of candidateLinks) {
        if (!seenHrefs.has(link.href)) {
            uniqueLinks.push(link);
            seenHrefs.add(link.href);
        }
    }

    console.log(`[Content Script] Extracted ${allAnchorTags.length} total anchors. Filtered to ${candidateLinks.length} candidates. Deduplicated to ${uniqueLinks.length} unique links.`);
    return {
        currentUrl: currentUrl,
        currentTitle: currentTitle,
        links: uniqueLinks // Send the filtered and deduplicated list
    };
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
            return true; // Indicates async response potentially if Readability were async (it's not here)
        } else if (request.action === "extractPageLinks") {
            console.log("[Content Script] 'extractPageLinks' action received from background.");
            const linkData = extractPageLinkData();
            if (linkData) {
                sendResponse({ success: true, data: linkData });
            } else {
                // This case should ideally not happen if the function is implemented correctly
                sendResponse({ success: false, error: "Failed to extract link data." });
            }
            return false; // Synchronous response for this simple extraction
        }
    });
    console.log("[Content Script] Message listener successfully attached.");

} catch (e) {
    console.error("[Content Script] CRITICAL: Error attaching message listener in content.js:", e);
}

console.log("[Content Script] Reached end of content.js execution. Waiting for messages.");
