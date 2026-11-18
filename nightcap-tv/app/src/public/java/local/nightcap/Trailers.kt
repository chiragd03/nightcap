package local.nightcap

/**
 * The public build's stand-in for trailers: it has none. Home shows the title's still picture, and
 * the player moves past a video source to the next one.
 */
object Trailers {
    class Streams(val video: String, val audio: String?, val found: Long)

    /** Whether this build plays trailers. */
    const val available = false

    fun ready(key: String): Streams? = null

    fun forget(key: String) {}

    fun prefetch(key: String) {}

    /** Calls [done] at once with null: nothing is looked up. */
    fun resolve(key: String, done: (Streams?) -> Unit) = done(null)
}
