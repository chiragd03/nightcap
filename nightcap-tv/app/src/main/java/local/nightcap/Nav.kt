package local.nightcap

import android.app.Activity
import android.content.Intent
import android.view.View
import android.view.animation.PathInterpolator

/** The side menu, set up the same way on every screen. */
object Nav {
    /** Tells Home which entry was picked on another screen ("home", "apps"). */
    const val EXTRA = "nav"

    private val ENTRIES = listOf(
        NavRail.Entry("search", R.drawable.ic_nav_search, "Search"),
        NavRail.Entry("home", R.drawable.ic_nav_home, "Home"),
        NavRail.Entry("shows", R.drawable.ic_nav_shows, "Shows"),
        NavRail.Entry("movies", R.drawable.ic_nav_movies, "Movies"),
        NavRail.Entry("live", R.drawable.ic_nav_live, "Live TV"),
        NavRail.Entry("apps", R.drawable.ic_nav_apps, "Apps"),
        NavRail.Entry("settings", R.drawable.ic_nav_settings, "Settings"),
    )

    /**
     * Wires [rail] into [activity]: [dim] recedes while it's open, closing it returns focus to
     * where you were (or [fallbackFocus]), and picks go to [onPick] or the default handling.
     */
    fun install(
        activity: Activity,
        rail: NavRail,
        selected: String,
        dim: List<View>,
        fallbackFocus: () -> Unit,
        onOpen: (Boolean) -> Unit = {},
        onPick: (String) -> Unit = { open(activity, it) },
    ) {
        var lastContentFocus: View? = null
        rail.window = activity.window
        rail.setup(ENTRIES, selected, onProfile = { activity.startActivity(ProfilesActivity.fromMenu(activity)) }, onPick) {
            lastContentFocus?.takeIf { it.isAttachedToWindow && it.isShown }?.requestFocus() ?: fallbackFocus()
        }
        val ease = PathInterpolator(0.2f, 0f, 0f, 1f)
        rail.onOpenChanged = { open ->
            dim.forEach { it.animate().alpha(if (open) 0.6f else 1f).setDuration(260).setInterpolator(ease).start() }
            onOpen(open)
        }
        activity.window.decorView.viewTreeObserver.addOnGlobalFocusChangeListener { _, now ->
            if (now != null && !contains(rail, now)) lastContentFocus = now
        }
    }

    /** Default handling for screens other than Home: Home's entries reopen Home at that spot. */
    fun open(activity: Activity, id: String) {
        when (id) {
            "search" -> if (activity !is SearchActivity) activity.startActivity(Intent(activity, SearchActivity::class.java))
            "settings" -> if (activity !is SettingsActivity) activity.startActivity(SettingsActivity.intent(activity))
            "live" -> if (activity !is LiveActivity) activity.startActivity(LiveActivity.intent(activity))
            else -> activity.startActivity(
                Intent(activity, HomeActivity::class.java).putExtra(EXTRA, id)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    fun contains(rail: View, view: View): Boolean {
        var v: View? = view
        while (v != null) {
            if (v === rail) return true
            v = v.parent as? View
        }
        return false
    }
}
