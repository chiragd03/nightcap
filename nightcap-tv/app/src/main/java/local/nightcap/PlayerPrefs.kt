package local.nightcap

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import okhttp3.Request
import org.json.JSONObject

/**
 * The player's remembered audio and subtitle languages, one set per profile. The server keeps
 * them (each profile's settings); this keeps a copy on the TV so the player starts at once.
 */
object PlayerPrefs {
    /** The audio language's name ("English"), matched against track names. */
    const val AUDIO = "audioLanguage"
    /** The subtitle language's three-letter code ("eng"), or [OFF]. */
    const val SUBTITLES = "subtitleLanguage"
    const val OFF = "off"
    const val DEFAULT_AUDIO = "English"
    const val DEFAULT_SUBTITLES = "eng"

    /** Subtitle and track languages: three-letter codes and their names. */
    val NAMES = mapOf(
        "eng" to "English", "hin" to "Hindi", "spa" to "Spanish", "fre" to "French", "ger" to "German",
        "ita" to "Italian", "por" to "Portuguese", "jpn" to "Japanese", "kor" to "Korean", "chi" to "Chinese",
        "ara" to "Arabic", "rus" to "Russian", "dut" to "Dutch", "tam" to "Tamil", "tel" to "Telugu",
        "pan" to "Punjabi", "urd" to "Urdu",
    )

    /** Each language's name in its own script, for the settings cards and panels. */
    val NATIVE = mapOf(
        "eng" to "English", "hin" to "हिन्दी", "spa" to "Español", "fre" to "Français", "ger" to "Deutsch",
        "ita" to "Italiano", "por" to "Português", "jpn" to "日本語", "kor" to "한국어", "chi" to "中文",
        "ara" to "العربية", "rus" to "Русский", "dut" to "Nederlands", "tam" to "தமிழ்", "tel" to "తెలుగు",
        "pan" to "ਪੰਜਾਬੀ", "urd" to "اردو",
    )

    /** One line of dialogue in each language, for the subtitles preview. */
    val SAMPLE = mapOf(
        "eng" to "I never thought I'd see this place again.",
        "hin" to "मैंने कभी नहीं सोचा था कि यह जगह फिर देखूँगा।",
        "spa" to "Nunca pensé que volvería a ver este lugar.",
        "fre" to "Je n'aurais jamais cru revoir cet endroit.",
        "ger" to "Ich hätte nie gedacht, diesen Ort wiederzusehen.",
        "ita" to "Non avrei mai pensato di rivedere questo posto.",
        "por" to "Nunca pensei que veria este lugar de novo.",
        "jpn" to "またこの場所を見るとは思わなかった。",
        "kor" to "이곳을 다시 보게 될 줄은 몰랐어.",
        "chi" to "我从没想过会再看到这个地方。",
        "ara" to "لم أظن أنني سأرى هذا المكان مرة أخرى.",
        "rus" to "Не думал, что снова увижу это место.",
        "dut" to "Ik had nooit gedacht deze plek terug te zien.",
        "tam" to "இந்த இடத்தை மீண்டும் பார்ப்பேன் என்று நினைக்கவே இல்லை.",
        "tel" to "ఈ ప్రదేశాన్ని మళ్ళీ చూస్తానని ఎప్పుడూ అనుకోలేదు.",
        "pan" to "ਮੈਂ ਕਦੇ ਨਹੀਂ ਸੋਚਿਆ ਸੀ ਕਿ ਇਹ ਥਾਂ ਮੁੜ ਵੇਖਾਂਗਾ।",
        "urd" to "میں نے کبھی نہیں سوچا تھا کہ یہ جگہ دوبارہ دیکھوں گا۔",
    )

    /** "Aa" for the Subtitles card, in the language's own letters. */
    val GLYPHS = mapOf(
        "hin" to "अ आ", "jpn" to "あア", "kor" to "가나", "chi" to "中文", "ara" to "أ ب", "rus" to "Аа",
        "tam" to "அ ஆ", "tel" to "అ ఆ", "pan" to "ਅ ਆ", "urd" to "ا ب",
    )

    /** Home's language rows (two-letter codes, as the server has them) in their own script. */
    val ROW_NATIVE = mapOf(
        // Anime isn't a language: its own word, so it isn't mistaken for Japanese (日本語).
        "hi" to "हिन्दी", "ko" to "한국어", "anime" to "Anime", "ja" to "日本語", "ta" to "தமிழ்", "te" to "తెలుగు", "ml" to "മലയാളം",
        "es" to "Español", "fr" to "Français", "tr" to "Türkçe", "zh" to "中文",
    )

    /** The code for an audio language's English name ("Hindi" -> "hin"). */
    fun codeOf(name: String) = NAMES.entries.firstOrNull { it.value == name }?.key

    /** The server's names for them in a profile's settings. */
    private val SERVER_KEYS = mapOf(AUDIO to "audio_language", SUBTITLES to "subtitles")

    /**
     * Brings this profile's choices from the server (the TV's copy follows it); one the server
     * doesn't have yet is sent up from the TV. Runs on a background thread.
     */
    fun sync(context: Context) {
        runCatching {
            val request = Request.Builder().url("${Server.url}/launcher/profile.json").build()
            val settings = Feed.http.newCall(request).execute().use { r ->
                check(r.isSuccessful) { "Server answered ${r.code}" }
                JSONObject(r.body!!.string()).getJSONObject("settings")
            }
            val prefs = of(context)
            val missing = JSONObject()
            SERVER_KEYS.forEach { (local, server) ->
                val there = settings.optString(server).takeIf { it.isNotBlank() && it != "null" }
                if (there != null) prefs.edit().putString(local, there).apply()
                else prefs.getString(local, null)?.let { missing.put(server, it) }
            }
            if (missing.length() > 0) Feed.post("/launcher/profile", JSONObject().put("settings", missing))
        }.onFailure { Log.w("Nightcap", "Couldn't sync audio and subtitle choices", it) }
    }

    /** Remembers a subtitle choice here and on the server. */
    fun saveSubtitles(context: Context, code: String) {
        of(context).edit().putString(SUBTITLES, code).apply()
        Thread { Feed.post("/launcher/profile", JSONObject().put("settings", JSONObject().put("subtitles", code))) }.start()
    }

    /** The admin keeps the choices made before profiles existed. */
    fun of(context: Context): SharedPreferences {
        val p = Profiles.current()
        val name = if (p == null || p.isAdmin) "player" else "player-${p.id}"
        return context.getSharedPreferences(name, Context.MODE_PRIVATE)
    }
}
