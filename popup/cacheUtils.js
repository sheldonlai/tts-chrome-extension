const AUDIO_CACHE_PREFIX = "tts_audio_cache_";
const PADDING_TEXT_FOR_CACHE_KEY = "||TTS_CHUNK||"; 

function generateAudioCacheKey(text) {
    if (!text) return AUDIO_CACHE_PREFIX + "undefined_text";
    const trimmedText = text.trim();
    if (trimmedText.length === 0) return AUDIO_CACHE_PREFIX + "empty_text";
    
    const prefix = trimmedText.substring(0, 200);
    // If total length is short enough (e.g., <= 400), just use prefix (or full text if < 200)
    // This avoids adding padding for shorter texts where prefix + suffix might overlap significantly or be the whole text.
    if (trimmedText.length <= 400) { 
        return AUDIO_CACHE_PREFIX + prefix;
    }
    // For longer texts, use prefix + separator + suffix
    const suffix = trimmedText.substring(trimmedText.length - 200);
    return AUDIO_CACHE_PREFIX + prefix + PADDING_TEXT_FOR_CACHE_KEY + suffix;
}
