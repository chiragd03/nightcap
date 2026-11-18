package local.nightcap

import android.os.SystemClock

/**
 * Titles whose only files weren't downloaded by the service yet: the one the player asked for
 * (which started its download), remembered a while so the next open of that title tries it first.
 * In memory only: after the app restarts, the title is simply looked up as usual.
 */
object Preparing {
    private const val KEEP_MS = 30 * 60_000L
    private val started = mutableMapOf<String, Pair<String, Long>>()

    @Synchronized fun remember(videoId: String, key: String) {
        started[videoId] = key to SystemClock.elapsedRealtime()
    }

    @Synchronized fun forget(videoId: String) {
        started.remove(videoId)
    }

    /** The file whose download was started for [videoId] lately, or null. */
    @Synchronized fun key(videoId: String): String? {
        val (key, at) = started[videoId] ?: return null
        if (SystemClock.elapsedRealtime() - at > KEEP_MS) return null.also { started.remove(videoId) }
        return key
    }
}
