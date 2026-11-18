package local.nightcap

import android.content.Context
import android.content.Intent

/** Installed TV apps for the Apps row: favourites first, then the rest by name. */
object Apps {
    const val ROW_ID = "apps"
    /** Google TV's home screen: the way back while Home opens Nightcap. */
    const val GOOGLE_HOME = "com.google.android.apps.tv.launcherx"

    private val FAVOURITES = listOf(
        "org.smarttube.stable",              // SmartTube
        "com.amazon.amazonvideo.livingroom", // Prime Video
        "com.netflix.ninja",
        "com.disney.disneyplus",
        "ca.bellmedia.cravetv",
        "com.apple.atve.sony.appletv",
        "com.google.android.youtube.tv",
    )

    // Sony's built-in helpers (eco dashboard, timers, promos…) just add clutter; keep Live TV.
    private fun hidden(pkg: String) = pkg.startsWith("com.sony.dtv.") && pkg != "com.sony.dtv.tvx"

    fun load(context: Context): Row {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
        val apps = pm.queryIntentActivities(intent, 0)
            .map { it.activityInfo }
            .filter { it.packageName != context.packageName && !hidden(it.packageName) }
            .distinctBy { it.packageName }
            .map { info ->
                Item(
                    id = info.packageName, type = "app", name = info.loadLabel(pm).toString(),
                    year = null, rating = null, poster = null, backdrop = null, trailer = null,
                    overview = null, reason = null, episode = null, progress = null, videoId = null,
                )
            }
            .sortedWith(compareBy({ FAVOURITES.indexOf(it.id).let { i -> if (i < 0) Int.MAX_VALUE else i } }, { it.name.lowercase() }))
        val googleHome = runCatching { pm.getApplicationInfo(GOOGLE_HOME, 0) }.getOrNull()?.let {
            Item(
                id = GOOGLE_HOME, type = "app", name = "Google TV",
                year = null, rating = null, poster = null, backdrop = null, trailer = null,
                overview = null, reason = null, episode = null, progress = null, videoId = null,
            )
        }
        // First, so the way back to Google TV is always one press away.
        return Row(ROW_ID, "Apps", listOfNotNull(googleHome) + apps)
    }

    fun launchIntent(context: Context, pkg: String): Intent? {
        if (pkg == GOOGLE_HOME) {
            return Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                .setClassName(GOOGLE_HOME, "$GOOGLE_HOME.home.HomeActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return context.packageManager.getLeanbackLaunchIntentForPackage(pkg)
    }
}
