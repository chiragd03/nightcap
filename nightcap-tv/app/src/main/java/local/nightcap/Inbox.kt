package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Play on TV: while the screen is on, asks the server every 10 seconds whether something was sent
 * to this TV (nothing while it sleeps), and puts it to whoever is at the TV over whatever screen is
 * open, pausing what's playing.
 *
 * A title from the catalogue plays as the profile that sent it (the TV switches to it, and stays);
 * a link plays on the profile that's on the TV. No: nothing switches, and what was paused carries
 * on. Nobody answers within a minute: the question goes, and what was paused stays paused.
 */
object Inbox {
    private const val EVERY_MS = 10_000L
    private const val ANSWER_WITHIN_MS = 60_000L
    private const val COME_UP_WITHIN_MS = 15_000L
    private const val TAG = "Nightcap"

    class Sender(val id: String, val name: String, val avatar: String?, val isAdmin: Boolean)
    class Title(val type: String, val id: String, val name: String, val episode: String?, val art: String?)
    class Link(val url: String, val name: String?, val site: String)
    class Ask(val id: Long, val from: Sender, val title: Title?, val link: Link?)

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var app: Context
    /** One question at a time. */
    @Volatile private var asking = false
    /** A question waiting for a Nightcap screen to come up (another app was in front). */
    private var waiting: Ask? = null

    private val tick = object : Runnable {
        override fun run() {
            check()
            handler.postDelayed(this, EVERY_MS)
        }
    }

    fun start(context: Context) {
        app = context.applicationContext
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, EVERY_MS)
    }

    fun stop() = handler.removeCallbacks(tick)

    private fun check() {
        if (asking || !Server.ready || Profiles.currentId == null) return
        if (!app.getSystemService(PowerManager::class.java).isInteractive) return
        io.execute {
            val ask = runCatching { fetch() }.onFailure { Log.w(TAG, "Inbox check failed", it) }.getOrNull() ?: return@execute
            handler.post { arrived(ask) }
        }
    }

    private fun fetch(): Ask? {
        val json = Feed.http.newCall(Request.Builder().url("${Server.url}/launcher/inbox.json").build()).execute()
            .use { r -> check(r.isSuccessful) { "Server answered ${r.code}" }; JSONObject(r.body!!.string()) }
        val o = json.optJSONObject("request") ?: return null
        val f = o.getJSONObject("from")
        return Ask(
            o.getLong("id"),
            Sender(f.getString("id"), f.optString("name"), f.optString("avatar").ifEmpty { null }, f.optBoolean("isAdmin")),
            o.optJSONObject("title")?.let { t ->
                Title(t.getString("type"), t.getString("id"), t.optString("name"), t.optString("episode").ifEmpty { null },
                    t.optString("art").ifEmpty { null })
            },
            o.optJSONObject("link")?.let { l -> Link(l.getString("url"), l.optString("name").ifEmpty { null }, l.optString("site")) },
        )
    }

    private fun arrived(ask: Ask) {
        asking = true
        val activity = NightcapApp.resumed
        if (activity != null) return askOn(activity, ask)
        // Another app is in front: Nightcap comes up and asks there (if it never does, the request
        // is turned down after a while, so checking carries on). A Nightcap screen still showing under a
        // TV panel (its settings, voice search) is asked on once the panel goes: never closed for it.
        waiting = ask
        if (NightcapApp.visible == 0) {
            // (The card says who it's for: Who's watching isn't put in front of it.)
            Profiles.asked()
            app.startActivity(Intent(app, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        handler.postDelayed({
            if (waiting !== ask) return@postDelayed
            waiting = null
            reply(ask, false)
            asking = false
        }, COME_UP_WITHIN_MS)
    }

    /** A Nightcap screen came to the front: a question waiting for one is asked now. */
    fun resumed(activity: Activity) {
        val ask = waiting ?: return
        waiting = null
        // (Once the screen has laid itself out, so the question sits in the middle of it.)
        handler.postDelayed({ askOn(activity, ask) }, 400)
    }

    private fun askOn(activity: Activity, ask: Ask) {
        val paused = NowPlaying.current?.pauseForQuestion() == true
        val switching = ask.title != null && ask.from.id != Profiles.currentId
        val title = ask.title?.name ?: ask.link?.name ?: "A video"
        val detail = ask.title?.episode ?: ask.link?.site
        var answered = false
        fun no() {
            if (answered) return
            answered = true
            reply(ask, false)
            if (paused) NowPlaying.current?.carryOn()
            asking = false
        }
        val close = AskCard.show(activity, ask.from, title, detail, ask.title?.art,
            playLabel = if (switching) "Play as ${ask.from.name}" else "Play",
            onPlay = {
                if (!answered) {
                    answered = true
                    // (A link is said yes to once it's been added; a title at once.)
                    if (ask.link == null || ask.title != null) reply(ask, true)
                    play(activity, ask)
                }
            },
            onNotNow = { no() })
        handler.postDelayed({
            if (answered) return@postDelayed
            answered = true
            close()
            reply(ask, false)
            asking = false
        }, ANSWER_WITHIN_MS)
    }

    private fun play(activity: Activity, ask: Ask) {
        val before = NowPlaying.current
        val title = ask.title
        if (title != null) {
            if (ask.from.id != Profiles.currentId) {
                Profiles.choose(Profiles.list().firstOrNull { it.id == ask.from.id }
                    ?: Profile(ask.from.id, ask.from.name, ask.from.avatar, ask.from.isAdmin))
            }
            activity.startActivity(WatchActivity.intent(activity, title.type, title.id, title.name, title.episode, title.art))
            before?.close()
            asking = false
            return
        }
        val link = ask.link ?: return run { asking = false }
        // Kept in this profile's history (one played before resumes where it got to), then played.
        io.execute {
            val sent = runCatching { addLink(link) }.onFailure { Log.w(TAG, "Couldn't add the link", it) }.getOrNull()
            reply(ask, sent != null)
            handler.post {
                asking = false
                if (sent == null) return@post Notice.show(activity, "Couldn't play that link.")
                activity.startActivity(PlayerActivity.intent(activity, sent))
                before?.close()
            }
        }
    }

    private fun addLink(link: Link): SentLink {
        val body = JSONObject().put("url", link.url).apply { link.name?.let { put("name", it) } }
        val o = Feed.http.newCall(Request.Builder().url("${Server.url}/launcher/sent")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()).execute()
            .use { r -> check(r.isSuccessful) { "Server answered ${r.code}" }; JSONObject(r.body!!.string()) }
        return SentLink(o.getString("id"), o.getString("url"), o.optString("name", link.site), o.optLong("position"),
            o.optLong("duration"), o.optDouble("sent_at"), o.optBoolean("thumb"))
    }

    private fun reply(ask: Ask, accept: Boolean) = io.execute {
        // (Once more after a moment if the network blinked: the phone is waiting on it.)
        for (attempt in 0..1) {
            val ok = runCatching {
                Feed.http.newCall(Request.Builder().url("${Server.url}/launcher/inbox/${ask.id}/answer")
                    .post(JSONObject().put("accept", accept).toString().toRequestBody("application/json".toMediaType())).build())
                    .execute().use { it.isSuccessful }
            }.onFailure { Log.w(TAG, "Couldn't answer the request", it) }.getOrDefault(false)
            if (ok) break
            if (attempt == 0) Thread.sleep(2_000)
        }
    }
}
