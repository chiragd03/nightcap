package local.nightcap

import android.content.Context

/** Whether Home's trailers play with sound. One choice for the whole TV, every profile. */
object TrailerSound {
    private const val PREFS = "tv"
    private const val KEY_MUTED = "trailersMuted"

    fun muted(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_MUTED, false)

    fun setMuted(context: Context, muted: Boolean) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_MUTED, muted).apply()
}
