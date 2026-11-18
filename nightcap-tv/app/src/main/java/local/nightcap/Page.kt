package local.nightcap

import android.util.LruCache
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** One card on a title page: an episode, an actor or a poster. Unused fields stay null. */
data class Card(
    val id: String,
    val type: String?,
    val name: String,
    val episode: String?,
    val overview: String?,
    val thumbnail: String?,
    val aired: String?,
    val rating: String?,
    val character: String?,
    val photo: String?,
    val poster: String?,
    val reason: String?,
    val year: String?,
    val backdrop: String? = null,
    /** An episode that hasn't aired yet. */
    val upcoming: Boolean = false,
    /** Marked watched. */
    val watched: Boolean = false,
    /** How far into this episode (0–1) when it's the one you're partway through. */
    val progress: Float? = null,
)

data class Section(val id: String, val title: String, val kind: String, val cards: List<Card>)

data class Header(
    val id: String,
    val type: String,
    val name: String,
    val facts: String,
    val rating: String?,
    val overview: String,
    val backdrop: String?,
    val trailer: String?,
    /** Series: whether "+N new episodes" shows for it. */
    val notify: Boolean = true,
    /** Your rating: -1 not for me, 1 like, 2 love; null if not rated. */
    val myRating: Int? = null,
    /** Whether it's on this profile's My List. */
    val inList: Boolean = false,
)

data class Page(val header: Header, val sections: List<Section>, val focusSection: String?, val focusIndex: Int)

/** 2026-12-25 -> "25 Dec 2026"; anything unparseable is returned as is. */
fun niceDate(iso: String?): String? = iso?.let {
    runCatching {
        java.time.LocalDate.parse(it.take(10)).format(java.time.format.DateTimeFormatter.ofPattern("d MMM yyyy"))
    }.getOrDefault(it)
}

/** Title, actor and similar-titles pages, fetched on demand and kept for the last few visits. */
object Pages {
    private val memory = LruCache<String, String>(20)

    /** Forgets the pages kept so far (they show the last profile's ticks and ratings). */
    fun clear() = memory.evictAll()

    fun titlePath(type: String, id: String) = "/launcher/title/$type/$id.json"
    fun personPath(id: String) = "/launcher/person/$id.json"
    fun browsePath(key: String) = "/launcher/browse/$key.json"
    fun similarPath(type: String, id: String) = "/launcher/similar/$type/$id.json"

    /** Asks the server for the AI's More like this picks now (it answers TMDB's list again if the
     *  AI isn't available), and keeps them like any page. Runs on a background thread; a few seconds. */
    fun rankSimilar(type: String, id: String): JSONObject {
        val request = Request.Builder().url("${Server.url}/launcher/similar/$type/$id/rank")
            .post("{}".toRequestBody("application/json".toMediaType())).build()
        val body = Feed.slow.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Server answered ${response.code}" }
            response.body!!.string()
        }
        memory.put(similarPath(type, id), body)
        return JSONObject(body)
    }

    /** Forgets a page kept here (it's asked fresh next time). */
    fun forget(path: String) {
        memory.remove(path)
    }

    /** Forgets every kept More like this list (a title said Not interested to is in none of them now). */
    fun forgetSimilar() {
        val prefix = similarPath("", "").substringBefore("//")
        memory.snapshot().keys.filter { it.startsWith(prefix) }.forEach(memory::remove)
    }

    /** Runs on a background thread. Pass [fresh] to skip the memory cache. */
    fun get(path: String, fresh: Boolean = false, client: okhttp3.OkHttpClient = Feed.http): JSONObject {
        if (!fresh) memory.get(path)?.let { return JSONObject(it) }
        val request = Request.Builder().url(Server.url + path).build()
        val body = client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Server answered ${response.code}" }
            response.body!!.string()
        }
        memory.put(path, body)
        return JSONObject(body)
    }

    fun parsePage(o: JSONObject): Page {
        val h = o.getJSONObject("header")
        val sections = o.getJSONArray("sections")
        val focus = o.optJSONObject("focus")
        return Page(
            header = Header(
                id = h.getString("id"), type = h.getString("type"), name = h.optString("name"),
                facts = h.optString("facts"), rating = h.str("rating"), overview = h.optString("overview"),
                backdrop = h.str("backdrop"), trailer = h.str("trailer"), notify = h.optBoolean("notify", true),
                myRating = if (h.has("myRating") && !h.isNull("myRating")) h.getInt("myRating") else null,
                inList = h.optBoolean("inList"),
            ),
            sections = (0 until sections.length()).map { parseSection(sections.getJSONObject(it)) },
            focusSection = focus?.optString("section"),
            focusIndex = focus?.optInt("index") ?: 0,
        )
    }

    fun parseSection(o: JSONObject): Section {
        val items = o.getJSONArray("items")
        return Section(o.getString("id"), o.getString("title"), o.getString("kind"),
            (0 until items.length()).map { parseCard(items.getJSONObject(it)) })
    }

    fun parseCards(items: org.json.JSONArray) = (0 until items.length()).map { parseCard(items.getJSONObject(it)) }

    private fun parseCard(o: JSONObject) = Card(
        id = o.getString("id"), type = o.str("type"), name = o.optString("name"), episode = o.str("episode"),
        overview = o.str("overview"), thumbnail = o.str("thumbnail"), aired = o.str("aired"), rating = o.str("rating"),
        character = o.str("character"), photo = o.str("photo"), poster = o.str("poster"), reason = o.str("reason"),
        year = o.str("year"), backdrop = o.str("backdrop"), upcoming = o.optBoolean("upcoming"),
        watched = o.optBoolean("watched"),
        // (The server sends null for none: "has" alone isn't enough.)
        progress = if (o.has("progress") && !o.isNull("progress")) o.getDouble("progress").toFloat() else null,
    )

    private fun JSONObject.str(key: String): String? =
        if (has(key) && !isNull(key)) get(key).toString().takeIf { it.isNotEmpty() } else null
}
