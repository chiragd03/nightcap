package local.nightcap

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.format.DateFormat
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.TextView
import coil.dispose
import coil.load
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.Date

/** A Live TV channel, as the server describes it (never its stream addresses: see [Live.play]). */
data class Channel(
    val id: String,
    val name: String,
    val logo: String?,
    val mono: String,
    val hue: Int,
    val kind: String,
    val kindName: String,
    val countries: List<String>,
    val languages: List<String>,
    val favourite: Boolean,
    // A household's own item (x-row in its list) may add these; an ordinary channel leaves them null.
    val state: String? = null,          // "live", "upcoming", "24/7"
    val startsAt: Long? = null,         // ms, when given
    val endsAt: Long? = null,           // ms, when given
    val about: String? = null,          // a line under its name
    // An event's card: its channels, each an item of its own (the card's id is the first's). Empty: one.
    val channels: List<LiveMember> = emptyList(),
) {
    /** "News · English · Germany". */
    val meta: String get() = (listOf(kindName) + languages.take(2) + countries.take(2)).filter { it.isNotBlank() }.joinToString(" · ")

    /** An own item that hasn't started: shown, but not played. */
    val upcoming: Boolean get() = state == "upcoming"

    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("logo", logo ?: JSONObject.NULL)
        .put("mono", mono).put("hue", hue).put("kind", kind).put("kindName", kindName)
        .put("countries", JSONArray(countries.map { JSONObject().put("name", it) }))
        .put("languages", JSONArray(languages.map { JSONObject().put("name", it) }))
        .put("favourite", favourite)
        .put("state", state ?: JSONObject.NULL).put("startsAt", startsAt ?: JSONObject.NULL)
        .put("endsAt", endsAt ?: JSONObject.NULL).put("about", about ?: JSONObject.NULL)
        .put("channels", JSONArray(channels.map { JSONObject().put("id", it.id).put("name", it.name) }))

    companion object {
        fun from(o: JSONObject) = Channel(
            id = o.getString("id"), name = o.getString("name"),
            logo = o.optString("logo").takeIf { it.isNotEmpty() && it != "null" },
            mono = o.optString("mono", "TV"), hue = o.optInt("hue"),
            kind = o.optString("kind"), kindName = o.optString("kindName"),
            countries = names(o.optJSONArray("countries")), languages = names(o.optJSONArray("languages")),
            favourite = o.optBoolean("favourite"),
            state = o.optString("state").takeIf { it.isNotEmpty() && it != "null" },
            startsAt = if (o.isNull("startsAt")) null else o.optLong("startsAt"),
            endsAt = if (o.isNull("endsAt")) null else o.optLong("endsAt"),
            about = o.optString("about").takeIf { it.isNotEmpty() && it != "null" },
            channels = o.optJSONArray("channels")?.let { a ->
                (0 until a.length()).map { a.getJSONObject(it).let { m -> LiveMember(m.getString("id"), m.optString("name")) } }
            }.orEmpty(),
        )

        private fun names(a: JSONArray?) = (0 until (a?.length() ?: 0)).map { a!!.getJSONObject(it).optString("name") }

        fun list(a: JSONArray?) = (0 until (a?.length() ?: 0)).map { from(a!!.getJSONObject(it)) }
    }
}

/** One channel of an event's card: an item of its own, played by its [id]. */
data class LiveMember(val id: String, val name: String)

/** A row on the Live TV page: My channels ("mine"), a kind of channel ("kind:news"), or one of the
 *  household's own rows ("row:…", [count] its whole size). */
data class LiveRow(val key: String, val title: String, val kind: String?, val channels: List<Channel>, val count: Int = 0) {
    val isOwnRow: Boolean get() = key.startsWith("row:")
}

/** A channel's stream as a playback link. [recipe] (an own item opened its household's own way) is
 *  passed through untouched to [LiveStreams]; the app itself never reads inside it. */
class LiveStream(val url: String, val hls: Boolean, val recipe: JSONObject?)

/** The Live TV page as the server builds it. */
class LivePage(val lists: Int, val hero: Channel?, val rows: List<LiveRow>, val shown: Int, val total: Int, val hidden: Int)

/** One page of Browse all, and what its filters can pick. */
class LiveBrowse(
    val channels: List<Channel>, val count: Int, val total: Int, val hidden: Int, val languagesSaid: Boolean,
    val countries: List<String>, val languages: List<String>, val options: Map<String, List<Option>>,
) {
    class Option(val id: String, val name: String, val count: Int)
}

/** A channel's streams, best first, as this TV's playback links. */
class LivePlay(val channel: Channel, val streams: List<LiveStream>, val expiresAt: Long)

/** Live TV on the server (its Live TV API). Every call runs on a background thread. */
object Live {
    /** No Live TV on this server (one older than it): the page says so. */
    class NotOnServer : Exception()

    private fun get(path: String): JSONObject =
        Feed.http.newCall(Request.Builder().url(Server.url + path).build()).execute().use { r ->
            if (r.code == 404 && path.startsWith("/livetv/page")) throw NotOnServer()
            check(r.isSuccessful) { "HTTP ${r.code}" }
            JSONObject(r.body!!.string())
        }

    fun page(): LivePage {
        val o = get("/livetv/page.json")
        val rows = o.optJSONArray("rows") ?: JSONArray()
        return LivePage(
            lists = o.optInt("lists"),
            hero = o.optJSONObject("hero")?.let(Channel::from),
            rows = (0 until rows.length()).map { i ->
                rows.getJSONObject(i).let { r ->
                    LiveRow(r.getString("key"), r.getString("title"), r.optString("kind").takeIf { it.isNotEmpty() },
                        Channel.list(r.optJSONArray("channels")), r.optInt("count"))
                }
            },
            shown = o.optInt("shown"), total = o.optInt("total"), hidden = o.optInt("hidden"),
        )
    }

    /** [countries], [languages]: null for the household's places, empty for any. [row]: one of the
     *  household's own rows (its key), whole — the places and the other filters don't apply. */
    fun browse(kind: String?, countries: List<String>?, languages: List<String>?, q: String, offset: Int, limit: Int = 60, row: String? = null): LiveBrowse {
        val url = okhttp3.HttpUrl.Builder().scheme("http").host("x").addPathSegments("livetv/browse.json").apply {
            if (row != null) addQueryParameter("row", row)
            if (kind != null) addQueryParameter("kind", kind)
            if (countries != null) addQueryParameter("countries", countries.joinToString(",").ifEmpty { "any" })
            if (languages != null) addQueryParameter("languages", languages.joinToString(",").ifEmpty { "any" })
            if (q.isNotBlank()) addQueryParameter("q", q.trim())
            addQueryParameter("offset", offset.toString())
            addQueryParameter("limit", limit.toString())
        }.build()
        val o = get("/livetv/browse.json?" + url.encodedQuery)
        val filters = o.optJSONObject("filters") ?: JSONObject()
        val options = o.optJSONObject("options") ?: JSONObject()
        fun ids(a: JSONArray?) = (0 until (a?.length() ?: 0)).map { a!!.getString(it) }
        fun opts(key: String) = options.optJSONArray(key)?.let { a ->
            (0 until a.length()).map { a.getJSONObject(it).let { x -> LiveBrowse.Option(x.getString("id"), x.optString("name"), x.optInt("count")) } }
        }.orEmpty()
        return LiveBrowse(
            Channel.list(o.optJSONArray("channels")), o.optInt("count"), o.optInt("total"), o.optInt("hidden"),
            o.optBoolean("languagesSaid"), ids(filters.optJSONArray("countries")), ids(filters.optJSONArray("languages")),
            mapOf("kinds" to opts("kinds"), "countries" to opts("countries"), "languages" to opts("languages")),
        )
    }

    /** The channels hidden because they didn't play. */
    fun hidden(): List<Channel> = Channel.list(get("/livetv/hidden.json").optJSONArray("channels"))

    fun play(id: String): LivePlay {
        val o = Feed.slow.newCall(Request.Builder().url("${Server.url}/livetv/play/$id.json").build()).execute().use { r ->
            check(r.isSuccessful) { "HTTP ${r.code}" }
            JSONObject(r.body!!.string())
        }
        val streams = o.optJSONArray("streams") ?: JSONArray()
        return LivePlay(Channel.from(o.getJSONObject("channel")),
            (0 until streams.length()).map { streams.getJSONObject(it).let { s -> LiveStream(s.getString("url"), s.optBoolean("hls", true), s.optJSONObject("recipe")) } },
            o.optLong("linksExpireAt", Long.MAX_VALUE))
    }

    fun favourite(id: String, on: Boolean) = post("/livetv/favourite", JSONObject().put("channel", id).put("on", on))

    fun watched(id: String, seconds: Int) = post("/livetv/watching", JSONObject().put("channel", id).put("seconds", seconds))

    fun failed(id: String) = post("/livetv/failed", JSONObject().put("channel", id))

    private fun post(path: String, body: JSONObject): Boolean = runCatching {
        Feed.http.newCall(Request.Builder().url(Server.url + path)
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /** A channel's own colour, for its tile's tint (from the server's [Channel.hue]). */
    fun colour(hue: Int, alpha: Int): Int = Color.HSVToColor(alpha, floatArrayOf(hue.toFloat(), 0.62f, 0.95f))

    /** The soft glow of a channel's colour from ([x], [y]) of [view]'s box (the top left by default),
     *  its corners rounded by [cornerDp] (0 for one that fills the screen). */
    fun glow(view: View, hue: Int, alpha: Int, radiusDp: Float, x: Float = 0.3f, y: Float = 0.2f, cornerDp: Float = 10f) {
        val dp = view.resources.displayMetrics.density
        view.background = GradientDrawable().apply {
            gradientType = GradientDrawable.RADIAL_GRADIENT
            colors = intArrayOf(colour(hue, alpha), Color.TRANSPARENT)
            gradientRadius = radiusDp * dp
            setGradientCenter(x, y)
            cornerRadius = cornerDp * dp
        }
    }

    /** The long-press menu for [channel] (the app's own, as on Home): add it to My channels, or take
     *  it out; [toggle] does it. */
    fun myChannelsSheet(activity: android.app.Activity, anchor: View?, channel: Channel, toggle: () -> Unit) {
        Sheet.show(activity, anchor, channel.name, channel.about?.takeIf { it.isNotBlank() } ?: channel.meta.ifBlank { null },
            listOf(if (channel.favourite) Sheet.Action(R.drawable.ic_act_remove, "Remove from My channels", toggle)
                   else Sheet.Action(R.drawable.ic_star, "Add to My channels", toggle)))
    }

    /** A channel tile (card_channel.xml) for [channel]: its logo, or its short name on its tint. */
    fun bind(view: View, channel: Channel?) {
        val logo = view.findViewById<ImageView>(R.id.channelLogo)
        val mono = view.findViewById<TextView>(R.id.channelMono)
        val tint = view.findViewById<View>(R.id.channelTint)
        val name = view.findViewById<TextView>(R.id.channelName)
        view.findViewById<View>(R.id.channelStar).visibility = if (channel?.favourite == true) View.VISIBLE else View.GONE
        val badge = view.findViewById<TextView>(R.id.channelBadge)
        val sub = view.findViewById<TextView>(R.id.channelSub)
        channel ?: return
        badgeAndSub(view.context, badge, sub, channel)
        val dp = view.resources.displayMetrics.density
        logo.setPadding((34 * dp).toInt(), (22 * dp).toInt(), (34 * dp).toInt(), (22 * dp).toInt())
        logo.scaleType = ImageView.ScaleType.FIT_CENTER
        name.text = channel.name
        mono.text = channel.mono
        glow(tint, channel.hue, if (channel.logo != null) 0x30 else 0x5C, 140f)
        mono.visibility = if (channel.logo == null) View.VISIBLE else View.GONE
        if (channel.logo == null) {
            logo.dispose()
            logo.setImageDrawable(null)
        } else {
            logo.load(channel.logo) {
                // A logo that doesn't load: the short name instead.
                listener(onError = { _, _ -> mono.visibility = View.VISIBLE; logo.setImageDrawable(null) })
            }
        }
    }

    /** An own item's corner badge (Live / Soon / 24-7) and the line under its name (its "about", or
     *  when it starts). An ordinary channel has neither. */
    private fun badgeAndSub(context: Context, badge: TextView, sub: TextView, ch: Channel) {
        when (ch.state) {
            "live" -> setBadge(badge, "● LIVE", 0xE5362B)
            "upcoming" -> setBadge(badge, "SOON", 0xCC121722.toInt())
            "24/7" -> setBadge(badge, "24/7", 0xCC121722.toInt())
            else -> badge.visibility = View.GONE
        }
        val many = if (ch.channels.size > 1) "${ch.channels.size} channels" else null
        val line = when {
            ch.upcoming && ch.startsAt != null -> "Starts " + timeText(context, ch.startsAt)
            else -> listOfNotNull(ch.about?.takeIf { it.isNotBlank() }, many).joinToString(" · ").ifEmpty { null }
        }
        sub.text = line ?: ""
        sub.visibility = if (line == null) View.GONE else View.VISIBLE
    }

    private fun setBadge(badge: TextView, text: String, colour: Int) {
        badge.text = text
        badge.setBackgroundResource(R.drawable.channel_badge_bg)
        badge.backgroundTintList = android.content.res.ColorStateList.valueOf(if (colour < 0) colour else (0xFF000000.toInt() or colour))
        badge.visibility = View.VISIBLE
    }

    /** "7:30 PM" today, "Tue · 7:30 PM" within the coming week, else "Tue 1 Jun · 7:30 PM" (with the
     *  year when it isn't this one). */
    fun timeText(context: Context, ms: Long): String {
        val time = DateFormat.getTimeFormat(context).format(Date(ms))
        val now = Calendar.getInstance()
        val then = Calendar.getInstance().apply { timeInMillis = ms }
        val sameYear = now.get(Calendar.YEAR) == then.get(Calendar.YEAR)
        if (sameYear && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)) return time
        val withinWeek = ms - System.currentTimeMillis() in 0 until 6L * 24 * 3600 * 1000
        val day = DateFormat.format(if (withinWeek) "EEE" else if (sameYear) "EEE d MMM" else "EEE d MMM yyyy", then).toString()
        return "$day · $time"
    }

    /** A new channel tile, rounded. */
    fun inflate(parent: ViewGroup): View = LayoutInflater.from(parent.context).inflate(R.layout.card_channel, parent, false).also {
        val tile = it.findViewById<View>(R.id.channelTile)
        tile.outlineProvider = ViewOutlineProvider.BACKGROUND
        tile.clipToOutline = true
    }
}
