// content.js

console.log("[Content Script] Initializing content.js - Version 7 (improved self-link filtering).");

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
            for (let i = maxChunkLength; i > maxChunkLength / 2; i--) {
                if (preferredSplitChars.includes(remainingText[i])) {
                    splitAt = i + 1;
                    break;
                }
            }
            if (splitAt === -1) splitAt = remainingText.lastIndexOf(' ', maxChunkLength);
            if (splitAt === -1 || splitAt === 0) splitAt = maxChunkLength;

            chunks.push(remainingText.substring(0, splitAt).trim());
            remainingText = remainingText.substring(splitAt).trim();
        }
    }
    return chunks.filter(chunk => chunk.length > 0);
}


function extractAndChunkTextContent() {
    console.log("[Content Script] extractAndChunkTextContent() called.");
    if (typeof Readability === 'undefined') {
        console.error("[Content Script] Readability is not available.");
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
        // console.log("[Content Script] Readability parsed. Title:", article.title, "Length:", article.textContent.length);
        const finalChunks = splitTextIntoChunks(article.textContent, 1500);

        if (finalChunks.length === 0 && article.textContent.trim().length > 0) {
            finalChunks.push(article.textContent.trim());
        } else if (finalChunks.length === 0) {
            return null;
        }
        // console.log(`[Content Script] Text split into ${finalChunks.length} final chunks.`);
        return {
            title: article.title || document.title || "Untitled Page",
            textContentChunks: finalChunks,
            simplifiedHtml: article.content,
            excerpt: article.excerpt,
            length: article.length,
            sourceURL: window.location.href
        };
    } else {
        // Fallback if Readability fails
        const bodyText = document.body ? (document.body.innerText || "") : "";
        const fallbackChunks = splitTextIntoChunks(bodyText, 1500);
        if (fallbackChunks.length === 0 && bodyText.trim().length === 0) return null;

        return {
            title: document.title || "Untitled Page",
            textContentChunks: fallbackChunks.length > 0 ? fallbackChunks : (bodyText.trim() ? [bodyText.trim()] : []),
            simplifiedHtml: null,
            excerpt: bodyText.substring(0, 150),
            length: bodyText.length,
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
    // const currentOrigin = new URL(currentUrl).origin; // Not strictly needed with simplified self-link check
    // const currentPathname = new URL(currentUrl).pathname; // Not strictly needed with simplified self-link check
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
        "/genre/"
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

    const currentBaseUrl = currentUrl.split('#')[0]; // Get current URL without fragment

    for (let i = 0; i < allAnchorTags.length; i++) {
        const anchor = allAnchorTags[i];
        let rawHref = anchor.getAttribute('href');

        if (!rawHref || rawHref.trim() === "" || rawHref.startsWith('#')) { // Skip empty or fragment-only links
            continue;
        }

        let absoluteHref;
        try {
            absoluteHref = new URL(rawHref, currentUrl).href;
        } catch (e) {
            // If it's an invalid URL construct (e.g., "javascript:"), check against excluded patterns before skipping
            if (excludedUrlPatterns.some(pattern => rawHref.toLowerCase().includes(pattern.toLowerCase()))) {
                continue;
            }
            console.warn(`[Content Script] Could not parse href: '${rawHref}'. Skipping.`);
            continue;
        }

        // Filter out non-HTTP(S) links
        if (!absoluteHref.startsWith('http:') && !absoluteHref.startsWith('https:')) {
            continue;
        }

        // Skip if the link's base URL (ignoring its own fragment) is the same as the current page's base URL.
        // This filters out links to the same page, including those with identical or different fragments.
        if (absoluteHref.split('#')[0] === currentBaseUrl) {
            console.log(`Skipping self-link or same-page fragment: ${absoluteHref}`);
            continue;
        }

        const linkText = (anchor.innerText || anchor.title || "").trim();
        const linkTextLower = linkText.toLowerCase();
        const hrefLower = absoluteHref.toLowerCase(); // Use absoluteHref for pattern matching

        // Skip if it matches excluded URL patterns (checking absoluteHref now)
        if (excludedUrlPatterns.some(pattern => hrefLower.includes(pattern.toLowerCase()))) {
            continue;
        }

        // Skip if it matches excluded text patterns
        if (excludedTextPatterns.some(pattern => linkTextLower.includes(pattern.toLowerCase()))) {
            // Exception: allow if text is "next" or "previous" despite other excluded words
            if (!(linkTextLower.includes("next") || linkTextLower.includes("prev"))) {
                continue;
            }
        }

        // Skip if link has no meaningful text and no title attribute, unless it has nav symbols or looks like numerical nav
        if (!linkText && !anchor.getAttribute('title')) {
            let hasNavSymbol = anchor.innerHTML.includes('>') || anchor.innerHTML.includes('&gt;') ||
                anchor.innerHTML.includes('»') || anchor.innerHTML.includes('&raquo;');

            let looksLikeNumericalNav = false;
            // Simple check for numerical increment in the last path segment or query params
            // This is a heuristic and might need refinement for complex URL structures
            const currentPathParts = new URL(currentUrl).pathname.split('/');
            const linkPathParts = new URL(absoluteHref).pathname.split('/');
            const currentLastPath = currentPathParts.pop() || currentPathParts.pop() || ""; // handle trailing slash
            const linkLastPath = linkPathParts.pop() || linkPathParts.pop() || "";

            const currentNumMatch = currentLastPath.match(/\d+/);
            if (currentNumMatch) {
                const currentNum = parseInt(currentNumMatch[0]);
                if (linkLastPath.includes(String(currentNum + 1)) || linkLastPath.includes(String(currentNum - 1))) {
                    looksLikeNumericalNav = true;
                }
            }
            // Also check query parameters if path doesn't show clear numerical nav
            if (!looksLikeNumericalNav) {
                const currentSearchParams = new URL(currentUrl).searchParams;
                const linkSearchParams = new URL(absoluteHref).searchParams;
                for (const [key, value] of currentSearchParams) {
                    const numInCurrentQuery = parseInt(value);
                    if (!isNaN(numInCurrentQuery)) {
                        const linkQueryValue = linkSearchParams.get(key);
                        if (linkQueryValue) {
                            if (linkQueryValue.includes(String(numInCurrentQuery + 1)) || linkQueryValue.includes(String(numInCurrentQuery - 1))) {
                                looksLikeNumericalNav = true;
                                break;
                            }
                        }
                    }
                }
            }


            if (!hasNavSymbol && !looksLikeNumericalNav) {
                continue;
            }
        }

        candidateLinks.push({
            href: absoluteHref,
            text: linkText || anchor.title || absoluteHref // Fallback if text is empty
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

        if (request.action === "extractReadablePageContent") {
            const articleDataWithChunks = extractAndChunkTextContent();

            if (articleDataWithChunks && articleDataWithChunks.textContentChunks && articleDataWithChunks.textContentChunks.length > 0) {
                sendResponse({ success: true, data: articleDataWithChunks });
            } else {
                sendResponse({ success: false, error: "Could not extract or chunk readable content from the page." });
            }
            return true;
        } else if (request.action === "extractPageLinks") {
            const linkData = extractPageLinkData();
            if (linkData) {
                sendResponse({ success: true, data: linkData });
            } else {
                sendResponse({ success: false, error: "Failed to extract link data." });
            }
            return false;
        }
    });

} catch (e) {
    console.error("[Content Script] CRITICAL: Error attaching message listener in content.js:", e);
}
