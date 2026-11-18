package local.nightcap

import android.os.SystemClock
import android.util.Log
import okhttp3.Call
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * The next episode's play info (its ranked sources), asked for while the current episode is in
 * its last minutes, so the next one starts without the wait for sources. Held here on the TV for
 * one hand-over, because the server forgets lists from the extra add-ons after two minutes.
 *
 * Two answers per episode: the play answer, and, when it doesn't have the viewer's picked language
 * and the server has more to ask, every source (more=1), asked straight after, unseen. The player
 * takes the first as soon as it's in and merges the second when it comes. A fetch for another path
 * cancels the old one's requests (a blocking request doesn't stop on an interrupt).
 */
object NextUp {
    class Taken(val answer: JSONObject, val more: Future<JSONObject?>?)

    private class Entry(val path: String, val at: Long) {
        lateinit var answer: Future<JSONObject?>
        @Volatile var more: Future<JSONObject?>? = null
        val calls = mutableListOf<Call>()
        @Volatile var cancelled = false
    }

    @Volatile private var entry: Entry? = null
    private val pool = Executors.newFixedThreadPool(2)
    /** Older than this, the sources may have changed or their links expired: ask again. */
    private const val MAX_AGE_MS = 15 * 60_000L
    /** The player waits this long for sources (as for its own play request). */
    private const val WAIT_S = 90L

    /**
     * Starts fetching [path] (once; a second call for the same path does nothing). [call] makes the
     * request for a path; [moreOf] gives the every-source path when an answer calls for it, else null.
     */
    fun fetch(path: String, call: (String) -> Call, moreOf: (JSONObject) -> String?) {
        if (entry?.path == path) return
        cancel(entry)
        Log.i("Nightcap", "Looking up the next episode ahead: $path")
        val e = Entry(path, SystemClock.elapsedRealtime())
        e.answer = pool.submit(Callable {
            val json = run(e, call(path)) ?: return@Callable null
            moreOf(json)?.let { morePath -> if (!e.cancelled) e.more = pool.submit(Callable { run(e, call(morePath)) }) }
            json
        })
        entry = e
    }

    private fun run(e: Entry, c: Call): JSONObject? {
        synchronized(e.calls) {
            if (e.cancelled) return null
            e.calls += c
        }
        return runCatching { c.execute().use { r -> JSONObject(r.body!!.string()) } }
            .onFailure { if (!e.cancelled) Log.w("Nightcap", "Next episode lookup failed", it) }.getOrNull()
    }

    private fun cancel(e: Entry?) {
        e ?: return
        e.cancelled = true
        synchronized(e.calls) { e.calls.forEach { it.cancel() } }
    }

    /**
     * What was fetched for [path], waiting for it if it's still on its way; null when nothing was,
     * it's too old, or it found no sources. Runs on a background thread.
     */
    fun take(path: String): Taken? {
        val e = entry?.takeIf { it.path == path }
        if (e == null) {
            Log.i("Nightcap", "No early lookup for $path (have ${entry?.path})")
            cancel(entry)
            entry = null
            return null
        }
        entry = null
        if (SystemClock.elapsedRealtime() - e.at > MAX_AGE_MS) return null.also { cancel(e) }
        val json = runCatching { e.answer.get(WAIT_S, TimeUnit.SECONDS) }.onFailure { Log.w("Nightcap", "Early lookup unusable", it) }
            .getOrNull() ?: return null.also { cancel(e) }
        val ok = !json.has("error") && (json.optJSONArray("streams")?.length() ?: 0) > 0
        Log.i("Nightcap", "Early lookup for $path: ${if (ok) "used" else "no sources, asking again"}")
        return if (ok) Taken(json, e.more) else null
    }
}
