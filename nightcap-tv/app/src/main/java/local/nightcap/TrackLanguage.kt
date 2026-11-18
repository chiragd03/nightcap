package local.nightcap

/**
 * The audio languages the player knows by name, and a libVLC track's language, read the way the
 * server reads a file's tracks (nightcap-server: languages.py AUDIO_LANGUAGES, filetracks.py
 * language/named), so the player and the server's ranking agree about a file.
 */
object TrackLanguage {

    /** (two-letter code, three-letter code, English name, own name), as the server's AUDIO_LANGUAGES. */
    private val LANGUAGES = listOf(
        listOf("en", "eng", "English", "English"), listOf("hi", "hin", "Hindi", "हिन्दी"),
        listOf("es", "spa", "Spanish", "Español"), listOf("fr", "fre", "French", "Français"),
        listOf("de", "ger", "German", "Deutsch"), listOf("it", "ita", "Italian", "Italiano"),
        listOf("pt", "por", "Portuguese", "Português"), listOf("ja", "jpn", "Japanese", "日本語"),
        listOf("ko", "kor", "Korean", "한국어"), listOf("zh", "chi", "Chinese", "中文"),
        listOf("ar", "ara", "Arabic", "العربية"), listOf("ru", "rus", "Russian", "Русский"),
        listOf("nl", "dut", "Dutch", "Nederlands"), listOf("ta", "tam", "Tamil", "தமிழ்"),
        listOf("te", "tel", "Telugu", "తెలుగు"), listOf("pa", "pan", "Punjabi", "ਪੰਜਾਬੀ"),
        listOf("ur", "urd", "Urdu", "اردو"),
    )

    /** Each language's English name by its two-letter code ("hi" → "Hindi"). */
    val NAMES: Map<String, String> = LANGUAGES.associate { it[0] to it[2] }

    /** libVLC's own spelling where it differs from the server's English name (its tag for "pan"). */
    private val LIBVLC_NAMES = mapOf("pa" to "Panjabi")

    /** A text naming one language: its English or own name, or its three-letter code as a word. */
    private val NAMED = LANGUAGES.map { (two, three, english, native) ->
        val names = listOfNotNull(english, LIBVLC_NAMES[two]).joinToString("|") { Regex.escape(it) }
        two to Regex("""(?i)(?<![a-z])(?:$names)(?![a-z])|${Regex.escape(native)}|(?<![a-z])$three(?![a-z])""")
    }

    /** The one language [text] names, or null (none, or more than one). */
    fun named(text: String): String? = NAMED.filter { (_, rx) -> rx.containsMatchIn(text) }.map { it.first }
        .distinct().singleOrNull()

    /**
     * A libVLC track's language from its name ("Hindi 5.1 - [English]": its own title, then its tag in
     * brackets): the title's when the tag says nothing, "Undetermined" or English (Matroska's default,
     * which release tools stamp on every track); otherwise the tag's (null when the tag is a language
     * not known by name).
     */
    fun of(name: String): String? {
        // (Split at the last " - [": a title may hold one itself.)
        val at = name.lastIndexOf(" - [").takeIf { it >= 0 && name.endsWith("]") }
        val title = if (at != null) name.substring(0, at) else name
        val tagText = at?.let { name.substring(it + 4, name.length - 1).trim() }
        if (tagText == null || tagText.isEmpty() || tagText.equals("Undetermined", true) || tagText.equals("und", true))
            return named(title)
        val tagged = named(tagText)
        return if (tagged == "en") named(title) ?: "en" else tagged
    }
}
