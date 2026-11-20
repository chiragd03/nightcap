package local.nightcap

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

data class Item(
    val id: String,
    val type: String,
    val name: String,
    val year: String?,
    val rating: Double?,
    val poster: String?,
    val backdrop: String?,
    val trailer: String?,
    val overview: String?,
    val reason: String?,
    val episode: String?,
    val progress: Double?,
    val videoId: String?,
    val newEpisodes: Int? = null,
    /** Place in a Top 10. */
    val rank: Int? = null,
    /** Why a featured title is featured: "New", "Picked for you", "2 new episodes". */
    val label: String? = null,
    /** A series whose "+N new episodes" alerts are turned off. */
    val muted: Boolean = false,
    /** Continue watching: when it was last watched, and the episode after this one. */
    val lastWatched: String? = null,
    val nextVideoId: String? = null,
    val nextEpisode: String? = null,
)

/**
 * My List changes saved on another screen (a title's page, Search), for Home to show as soon as it's
 * back in front: the Home the server brings up to date after them can be held back while someone's
 * browsing (it never moves rows above the one they're on).
 */
object MyListEdits {
    /** [profile]: whose My List it was ([Profiles.currentId] when it was saved). */
    data class Edit(val profile: String?, val item: Item, val on: Boolean)

    private val edits = mutableListOf<Edit>()

    /** A title put on My List ([on]) or taken off, once it's saved. Any thread. */
    @Synchronized fun note(profile: String?, item: Item, on: Boolean) {
        edits.removeAll { it.item.id == item.id }
        edits += Edit(profile, item, on)
    }

    /** The changes noted so far, in order, forgotten here. */
    @Synchronized fun take(): List<Edit> = edits.toList().also { edits.clear() }

    /** A title as a My List card: [poster] null shows its name instead. */
    fun item(id: String, type: String, name: String, year: String?, poster: String?, backdrop: String?) =
        Item(id = id, type = type, name = name, year = year, rating = null, poster = poster, backdrop = backdrop,
            trailer = null, overview = null, reason = null, episode = null, progress = null, videoId = null)
}

/**
 * [style]: null for posters, "ranked" for a Top 10, "tiles" for Browse. [requestId] and
 * [modelVersion] identify the AI answer a row came from, if any.
 */
data class Row(
    val id: String, val title: String, val items: List<Item>, val style: String? = null,
    val requestId: String? = null, val modelVersion: String? = null,
)

/** Loads the home screen from the server and keeps the last copy on disk for instant start-up. */
object Feed {
    const val FEATURED = "featured"

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .addInterceptor(Profiles.header)
        .build()

    /** For the player's source list: the stream finder can take most of a minute when it's busy. */
    val slow: OkHttpClient = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()

    /** For a refresh of Home: it can rebuild the recommendations (an AI call) and look for new
     *  episodes' sources, a minute or two at most. */
    private val refreshing: OkHttpClient = http.newBuilder().readTimeout(150, TimeUnit.SECONDS).build()

    /** The last home screen, one per profile, and of its Shows ("tv") and Movies ("movie") pages ([page]). */
    private fun cacheFile(context: Context, page: String? = null) =
        File(context.filesDir, "home-${Profiles.currentId ?: "default"}${page?.let { "-$it" }.orEmpty()}.json")

    /** Home as read once off the main thread: its JSON (to tell a changed one), its rows, whether it's a
     *  first Home still being set up, and whether the server says a refresh would change it. */
    class Home(val json: String, val rows: List<Row>, val building: Boolean, val stale: Boolean)

    fun read(json: String): Home = JSONObject(json).let { root ->
        Home(json, parse(root), root.optBoolean("building"), root.optBoolean("stale"))
    }

    /** The last saved Home (or [page]), read; null if there's none or it can't be read. Runs on a
     *  background thread. */
    fun cached(context: Context, page: String? = null): Home? =
        runCatching { cacheFile(context, page).takeIf { it.exists() }?.readText()?.let(::read) }.getOrNull()

    /** Downloads Home (or the Shows or Movies [page]) as the server last saved it, saves it here, and
     *  returns it read. Runs on a background thread. */
    fun download(context: Context, page: String? = null): Home = save(context, page, http, Request.Builder()
        .url(if (page == null) "${Server.url}/launcher/home.json" else "${Server.url}/launcher/page/$page.json").build())

    /** Asks the server to bring Home (or a [page]) up to date, and returns the new one (saved here too).
     *  Runs on a background thread; Home's can take a minute or two (a page's asks the AI nothing). */
    fun refresh(context: Context, page: String? = null): Home = save(context, page, refreshing, Request.Builder()
        .url(if (page == null) "${Server.url}/launcher/refresh" else "${Server.url}/launcher/page/$page/refresh")
        .post("{}".toRequestBody("application/json".toMediaType())).build())

    /** Asks the server to build the Browse pages ahead of time, so opening a tile is instant.
     *  Runs on a background thread. */
    fun warmBrowse() = post("/launcher/browse/warm", JSONObject(), changes = false)

    private fun save(context: Context, page: String?, client: OkHttpClient, request: Request): Home {
        // (The profile it was asked for: one switched to meanwhile never gets it.)
        val file = cacheFile(context, page)
        return client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Server answered ${response.code}" }
            val body = response.body!!.string()
            // Only a Home that reads is kept (a hotel Wi-Fi page answers 200 too): else it's a failure.
            read(body).also {
                // (Whole or not at all: the TV switched off mid-write leaves the last one.)
                val part = File(file.path + ".part")
                part.writeText(body)
                check(part.renameTo(file)) { "Couldn't save Home" }
            }
        }
    }

    /**
     * When something that Home shows last changed (watched, alerts, a saved position), so Home
     * knows to fetch itself again when you come back to it.
     */
    @Volatile var changedAt = 0L
        private set

    fun markChanged() {
        changedAt = android.os.SystemClock.elapsedRealtime()
        // (A screen in front that shows what changed catches up now, not on its next visit.)
        onChange?.let { main.post(it) }
    }

    /** Called on the main thread after each change, while a screen in front has set it. */
    @Volatile var onChange: (() -> Unit)? = null
    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    /** Posts a small JSON change to the server; true if it was saved. Runs on a background thread.
     *  [changes]: whether it changes what Home shows (so Home refreshes); a report doesn't. */
    fun post(path: String, body: JSONObject, changes: Boolean = true): Boolean = runCatching {
        val request = Request.Builder().url(Server.url + path)
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        http.newCall(request).execute().use { check(it.isSuccessful) { "HTTP ${it.code}" } }
    }.onFailure { android.util.Log.w("Nightcap", "Couldn't save $path", it) }.isSuccess.also { if (it && changes) markChanged() }

    /** Tells the server which Home row a title was opened from; rows nobody uses rotate out. */
    /** A title opened ("opened", "searched_opened"), linked to where it was (see PlaySource). */
    fun interaction(imdbId: String, kind: String, source: PlaySource) = Thread {
        // (A report: no page changes because of it.)
        post("/launcher/interaction", source.into(JSONObject().put("id", imdbId).put("kind", kind)), changes = false)
    }.start()

    fun opened(rowId: String) = Thread {
        runCatching {
            val body = JSONObject().put("row", rowId).toString()
                .toRequestBody("application/json".toMediaType())
            http.newCall(Request.Builder().url("${Server.url}/launcher/opened").post(body).build()).execute().close()
        }
    }.start()

    /** Home's rows. A row or title that can't be read is left out, not the whole Home; only one with
     *  no rows at all to read fails. */
    private fun parse(root: JSONObject): List<Row> {
        val rows = root.getJSONArray("rows")
        val featured = root.optJSONArray("featured")?.let { f -> (0 until f.length()).mapNotNull { readItem(f.optJSONObject(it)) } }
        return listOfNotNull(featured?.takeIf { it.isNotEmpty() }?.let { Row(FEATURED, "", it, style = "featured") }) +
            (0 until rows.length()).mapNotNull { r ->
                runCatching {
                    val row = rows.getJSONObject(r)
                    val items = row.getJSONArray("items")
                    Row(
                        id = row.getString("id"),
                        title = row.getString("title"),
                        items = (0 until items.length()).mapNotNull { i -> readItem(items.optJSONObject(i)) },
                        style = row.optStringOrNull("style"),
                        requestId = row.optStringOrNull("requestId"),
                        modelVersion = row.optStringOrNull("modelVersion"),
                    )
                }.onFailure { Log.w("Feed", "Row left out", it) }.getOrNull()
            }
    }

    private fun readItem(o: JSONObject?): Item? =
        o?.let { runCatching { parseItem(it) }.onFailure { e -> Log.w("Feed", "Title left out", e) }.getOrNull() }

    // (Numbers the server can send as null, "none": checked with isNull, not only has.)
    private fun parseItem(o: JSONObject) = Item(
        id = o.getString("id"),
        type = o.optString("type", "movie"),
        name = o.optString("name", o.getString("id")),
        year = o.optStringOrNull("year"),
        rating = if (o.has("rating") && !o.isNull("rating")) o.getDouble("rating") else null,
        poster = o.optStringOrNull("poster"),
        backdrop = o.optStringOrNull("backdrop"),
        trailer = o.optStringOrNull("trailer"),
        overview = o.optStringOrNull("overview"),
        reason = o.optStringOrNull("reason"),
        episode = o.optStringOrNull("episode"),
        progress = if (o.has("progress") && !o.isNull("progress")) o.getDouble("progress") else null,
        videoId = o.optStringOrNull("videoId"),
        newEpisodes = if (o.has("newEpisodes") && !o.isNull("newEpisodes")) o.getInt("newEpisodes") else null,
        rank = if (o.has("rank") && !o.isNull("rank")) o.getInt("rank") else null,
        label = o.optStringOrNull("label"),
        muted = o.optBoolean("muted"),
        lastWatched = o.optStringOrNull("lastWatched"),
        nextVideoId = o.optStringOrNull("nextVideoId"),
        nextEpisode = o.optStringOrNull("nextEpisode"),
    )

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) getString(key).takeIf { it.isNotEmpty() } else null
}
