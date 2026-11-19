package local.nightcap

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.TextureView
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject
import java.util.concurrent.Executors

class HomeActivity : TvActivity() {

    private lateinit var rowsView: RecyclerView
    private lateinit var eyebrow: TextView
    private lateinit var title: TextView
    private lateinit var meta: TextView
    private lateinit var reason: TextView
    private lateinit var overview: TextView
    private lateinit var status: TextView
    private lateinit var hero: Hero
    private lateinit var widgets: Widgets
    private lateinit var navRail: NavRail
    private var focused: Pair<Row, Item>? = null

    private val io = Executors.newSingleThreadExecutor()
    /** Reading the saved Home from disk. */
    private val disk = Executors.newSingleThreadExecutor()
    /** For refreshing Home on the server, which can take a minute or two: never holds up [io]. */
    private val slowIo = Executors.newSingleThreadExecutor()
    private val adapter = RowsAdapter(
        onFocus = ::showInfo, onClick = ::open, onLongPress = ::longPress,
        onFeaturedStart = { navRail.enter() }, heroBusy = { hero.playingTrailer() },
    )
    private var glassTicker: Runnable? = null
    /** The Home on screen, as read (its JSON tells a changed one). */
    private var shown: Feed.Home? = null
    /** Whose Home is on screen: another profile may have been chosen while this screen was hidden. */
    private var shownFor: String? = null
    private var pending: Feed.Home? = null
    private var lastFetch = 0L
    // Changes from Home whose updated Home hasn't come back yet: meanwhile the Home saved before them
    // (marked stale) isn't shown, it would put back what was changed.
    private var changesSaving = 0
    /** Back after a long while: the next Home from the server is shown in full, not held. */
    private var freshStart = false
    /** The last change (Feed.changedAt) this screen has caught up with. */
    private var seenChange = 0L
    /** Bumped on every change made here, so an older download can't overwrite a newer change. */
    private var generation = 0
    private var feedRows: List<Row> = emptyList()
    /** A row the side menu brought up, removed again once focus moves to another row. */
    private var onDemand: String? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A new TV (or one the server no longer knows): which server and household, first.
        if (!Server.ready) {
            startActivity(ConnectActivity.intent(this))
            return finish()
        }
        setContentView(R.layout.activity_home)
        // Keeps an eye out for the TV waking onto Google TV's home (see WakeService).
        WakeService.start(this)
        rowsView = findViewById(R.id.rows)
        eyebrow = findViewById(R.id.eyebrow)
        title = findViewById(R.id.title)
        meta = findViewById(R.id.meta)
        reason = findViewById(R.id.reason)
        overview = findViewById(R.id.overview)
        status = findViewById(R.id.status)
        hero = Hero(this, findViewById<ImageView>(R.id.backdrop), findViewById<TextureView>(R.id.trailer))
        widgets = Widgets(this, io)
        val sound = findViewById<ImageView>(R.id.trailerSound)
        // (A build without trailers has no sound to turn on.)
        if (!Trailers.available) sound.visibility = View.GONE
        fun showSound() = sound.setImageResource(if (TrailerSound.muted(this)) R.drawable.ic_sound_off else R.drawable.ic_sound_on)
        showSound()
        sound.setOnClickListener {
            TrailerSound.setMuted(this, !TrailerSound.muted(this))
            showSound()
            hero.soundChanged()
        }
        // Up from the top row reaches it; Down or Back returns to the card you came from.
        var beforeSound: View? = null
        sound.viewTreeObserver.addOnGlobalFocusChangeListener { old, new -> if (new === sound && old !== sound) beforeSound = old }
        sound.setOnKeyListener { _, code, e ->
            when (code) {
                android.view.KeyEvent.KEYCODE_DPAD_DOWN, android.view.KeyEvent.KEYCODE_BACK -> true.also {
                    if (e.action == android.view.KeyEvent.ACTION_DOWN)
                        beforeSound?.takeIf { it.isAttachedToWindow && it.isShown }?.requestFocus() ?: focusHome()
                }
                android.view.KeyEvent.KEYCODE_DPAD_LEFT, android.view.KeyEvent.KEYCODE_DPAD_RIGHT, android.view.KeyEvent.KEYCODE_DPAD_UP -> true
                else -> false
            }
        }
        val backdropView = findViewById<ImageView>(R.id.backdrop)
        val weatherGlass = findViewById<ImageView>(R.id.weatherGlass)
        val trailerView = findViewById<TextureView>(R.id.trailer)
        var backdropImage: android.graphics.drawable.Drawable? = null
        hero.onBackdrop = { image -> backdropImage = image; Glass.show(weatherGlass, backdropView, image) }
        // While a trailer plays, the glass follows the video using a tiny frame a few times a second.
        val frame = android.graphics.Bitmap.createBitmap(168, 95, android.graphics.Bitmap.Config.ARGB_8888)
        var onVideo = false
        glassTicker = object : Runnable {
            override fun run() {
                val f = hero.trailerFrame(frame)
                if (f != null) {
                    Glass.showFrame(weatherGlass, trailerView, f)
                    onVideo = true
                } else if (onVideo) {
                    onVideo = false
                    Glass.show(weatherGlass, backdropView, backdropImage)
                }
                handler.postDelayed(this, GLASS_FRAME_MS)
            }
        }
        navRail = findViewById(R.id.navRail)
        val navHint = findViewById<View>(R.id.navHint)
        Nav.install(
            this, navRail, selected = "home", dim = listOf<View>(rowsView, findViewById(R.id.hero)),
            fallbackFocus = ::focusFirstCard,
            onOpen = { open -> navHint.animate().alpha(if (open) 0f else 1f).setDuration(200).start() },
            onPick = ::navigate,
        )

        rowsView.layoutManager = TopAlignLayoutManager(this)
        rowsView.setItemViewCacheSize(10)   // rows just scrolled past kept as they are (scroll positions too)
        rowsView.itemAnimator = null
        rowsView.adapter = adapter
        // Spare cards made while the TV is idle, so the first scroll through Home doesn't make them.
        adapter.warmCards(rowsView) { lastKeyAt }
        // Rows leaving the top fade out as they slide up instead of vanishing.
        rowsView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) = rowsView.fadeRowsAbove()
        })
        rowsView.viewTreeObserver.addOnGlobalLayoutListener { rowsView.fadeRowsAbove() }

        // Draw the last saved screen straight away, then refresh from the server.
        showSaved { showStatus("Loading ${pageName()}…", pulse = true) }
        rowsView.requestFocus()
        refresh()
    }

    override fun onResume() {
        super.onResume()
        // The TV just woke or started: ask who's watching first.
        if (Profiles.shouldAsk()) return startActivity(ProfilesActivity.intent(this))
        // (Once a day: a newer version of the app, offered over Home.)
        Updater.check(this)
        // A Home that arrived while you were browsing, held back: now, keeping focus where it was.
        pending?.let { pending = null; apply(it, focused?.let { (row, item) -> row.id to item.id }) }
        val listEdits = myListEdits()
        // (And a save that lands while Home's in front: Back pressed before it was done.)
        Feed.onChange = ::catchUpMyList
        focused?.let { (row, item) -> hero.show(row, item) }
        widgets.start()
        glassTicker?.let { handler.removeCallbacks(it); handler.post(it) }
        when {
            // Something changed on another screen (watched, alerts, a saved position): show it now.
            Feed.changedAt > seenChange || listEdits -> {
                seenChange = Feed.changedAt
                refresh(keepFocus = focused?.let { (row, item) -> row.id to item.id } ?: ("" to ""), afterEdit = listEdits)
            }
            SystemClock.elapsedRealtime() - lastFetch > 60_000 -> refresh()
            // Still nothing to show, or a first Home still setting up: asked again now (not right after
            // a fetch: the first start's own).
            (shown == null || shown?.building == true) &&
                SystemClock.elapsedRealtime() - lastFetch > RETRY_MS -> refresh()
        }
    }

    override fun onPause() {
        super.onPause()
        if (Feed.onChange == ::catchUpMyList) Feed.onChange = null
        handler.removeCallbacks(retry)
        hero.pause()
        widgets.stop()
        glassTicker?.let(handler::removeCallbacks)
    }

    override fun onDestroy() {
        // The screen is gone: drop its timers; work already started finishes, then its thread ends.
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        disk.shutdown()
        slowIo.shutdown()
        super.onDestroy()
    }

    // Going to sleep: blank the screen's content, so waking onto Who's watching doesn't show a
    // stale frame of Home first. It's back before Home is next drawn.
    override fun onStop() {
        super.onStop()
        if (!getSystemService(android.os.PowerManager::class.java).isInteractive) {
            rowsView.rootView.alpha = 0f
            // (Waking after a sleep: the fresh Home is shown in full, yesterday's picks don't wait.)
            freshStart = shown != null
        }
    }

    override fun onStart() {
        super.onStart()
        rowsView.rootView.alpha = 1f
        // Another profile was chosen while this screen was hidden (Play on TV switches to the
        // sender's): its own Home before anything is drawn, never a moment of the last one's.
        if (shown != null && shownFor != Profiles.currentId) {
            showProfile()
            seenChange = Feed.changedAt
        }
    }

    // Pressing Home while already here jumps back to the first row; the side menu on another
    // screen can ask for a particular spot (Apps).
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_PROFILE_CHOSEN, false)) {
            leaveMenu()
            return showProfile()
        }
        val spot = intent.getStringExtra(Nav.EXTRA)
        if (spot != null) {
            rowsView.post { navigate(spot) }
            return
        }
        rowsView.scrollToPosition(0)
        focusHome()
    }

    // Left on a row's first card opens the side panel; Right on its last card does nothing.
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
        lastKeyAt = SystemClock.uptimeMillis()
        // An arrow held down moves along at a steady pace (one step each HELD_STEP_MS), rather than as
        // fast as the remote repeats: each step brings in a row's cards, and a burst of them froze Home.
        if (event.action == android.view.KeyEvent.ACTION_DOWN && event.repeatCount > 0 && event.keyCode in HELD_KEYS) {
            val now = SystemClock.uptimeMillis()
            if (now - lastHeldStep < HELD_STEP_MS) return true
            lastHeldStep = now
        }
        val focus = currentFocus
        // No rows yet (can't connect, still loading): Left still opens the side menu (Settings, Apps…).
        if (adapter.itemCount == 0 && event.action == android.view.KeyEvent.ACTION_DOWN &&
            event.keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT && (focus == null || !Nav.contains(navRail, focus)))
            return true.also { navRail.enter() }
        if (focus != null && !Nav.contains(navRail, focus) && rowEdgeKey(focus, event, onStartLeft = navRail::enter)) return true
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent): Boolean {
        if (keyCode == android.view.KeyEvent.KEYCODE_SEARCH) {
            openSearch()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun openSearch() = startActivity(Intent(this, SearchActivity::class.java))

    private fun navigate(id: String) {
        when (id) {
            "search" -> openSearch()
            "home" -> showPage(null)
            "shows" -> showPage("tv")
            "movies" -> showPage("movie")
            "apps" -> {
                // (Apps comes up on Home.)
                if (page != null) showPage(null)
                bringUp(Apps.load(this), at = 0)
            }
            "settings" -> startActivity(SettingsActivity.intent(this))
            "live" -> startActivity(LiveActivity.intent(this))
        }
    }

    /** Shows a row the side menu asked for (Apps) and focuses it; it goes once you move on. */
    private fun bringUp(row: Row, at: Int) {
        onDemand = row.id
        adapter.setRow(row.id, row, at)
        val first = row.items.firstOrNull()?.id ?: return
        afterNextLayout { focusItem(row.id, first) }
    }

    private fun alignFocusedRow() {
        val focus = rowsView.focusedChild ?: return
        val dy = focus.top - rowsView.paddingTop
        if (dy != 0) rowsView.smoothScrollBy(0, dy, Motion.ease, 260)
    }

    @Deprecated("Back on the home screen should do nothing but return to the top.")
    override fun onBackPressed() {
        // On Shows or Movies, Back is Home; on Home, back to its top.
        if (page != null) return showPage(null)
        rowsView.scrollToPosition(0)
        focusHome()
    }

    /**
     * Fetches Home again. [keepFocus] (a row and card) means the viewer just changed something:
     * show the new Home at once, with focus still on that card wherever it moved to.
     */
    /** The last saved Home for this profile and page, read off the main thread, then shown (unless the
     *  server's came first, or the page or profile changed meanwhile); [none] when there isn't one. */
    private fun showSaved(none: () -> Unit) {
        val at = generation
        val p = page
        // (Its own thread: never waiting behind a slow server call on io.)
        disk.execute {
            val saved = Feed.cached(this, p)
            runOnUiThread {
                if (isFinishing || at != generation || shown != null) return@runOnUiThread
                if (saved != null) apply(saved) else none()
            }
        }
    }

    /** Another profile was picked: its own last Home at once (if any), then fresh from the server. */
    private fun showProfile() {
        generation++
        shown = null
        shownFor = null
        pending = null
        rowsView.scrollToPosition(0)
        // (The last profile's rows go at once, and nothing of it is left above them: its title, picture
        // or trailer. Focus waits in the empty rows, not on the sound button.)
        adapter.submit(emptyList())
        focused = null
        hero.clear()
        eyebrow.text = null
        title.text = null
        meta.text = null
        overview.text = null
        reason.visibility = View.GONE
        // (After the layout that takes the old cards away: until then a card would take it back.)
        afterNextLayout { if (adapter.itemCount == 0 && !navRail.hasFocus()) rowsView.requestFocus() }
        showSaved { showStatus("Loading ${pageName()}…", pulse = true) }
        refresh()
    }

    // ---------- Home's pages: Shows and Movies share this screen ----------

    /** The page shown: null for Home, "tv" for Shows, "movie" for Movies. */
    private var page: String? = null

    private fun pageName() = when (page) { "tv" -> "Shows"; "movie" -> "Movies"; else -> "your home screen" }

    /** Shows Home or one of its pages, in place: the same screen (its cards, picture and smooth
     *  scrolling kept), the page's own rows, its last saved copy at once, then fresh. */
    private fun showPage(next: String?) {
        if (next == page) return focusHome()
        leaveMenu()
        page = next
        navRail.select(when (next) { "tv" -> "shows"; "movie" -> "movies"; else -> "home" })
        showProfile()
    }

    /** [afterEdit]: My List was just changed here from another screen's save (see [myListEdits]): the
     *  Home saved before it isn't shown meanwhile, as for a change made on Home. */
    private fun refresh(keepFocus: Pair<String, String>? = null, afterEdit: Boolean = false) {
        lastFetch = SystemClock.elapsedRealtime()
        val startedAt = generation
        // (A Home asked for one profile is never shown, or kept, as another's.)
        val who = Profiles.currentId
        if (afterEdit) changesSaving++
        io.execute {
            val p = page
            val result = runCatching { Feed.download(this, p) }
            val slow = result.getOrNull()?.stale == true
            // Home first: the other calls below don't hold it up.
            runOnUiThread {
                if (afterEdit && !slow) changesSaving--
                if (isFinishing) return@runOnUiThread
                // The profile was removed elsewhere (the server didn't know it): Who's watching.
                if (who != null && Profiles.currentId == null) {
                    if (NightcapApp.resumed === this) startActivity(ProfilesActivity.intent(this))
                    return@runOnUiThread
                }
                if (who != Profiles.currentId) return@runOnUiThread
                result.onSuccess { deliver(it, keepFocus, startedAt) }
                result.onFailure { e ->
                    Log.w(TAG, "Feed download failed", e)
                    freshStart = false
                    // Nothing to show yet: say so and keep trying quietly.
                    if (shown == null) {
                        showStatus("Nightcap can't connect right now. Trying again…", pulse = true)
                        handler.removeCallbacks(retry)
                        handler.postDelayed(retry, RETRY_MS)
                    }
                }
            }
            // Home as saved is out of date: the server brings it up to date, and that's shown the
            // same way (as any background update: never pulling focus); then the Browse pages are built
            // ahead of time.
            if (slow) slowIo.execute {
                val fresh = runCatching { Feed.refresh(this, p) }.onFailure { Log.w(TAG, "Home refresh failed", it) }.getOrNull()
                runOnUiThread {
                    if (afterEdit) changesSaving--
                    if (isFinishing || who != Profiles.currentId) return@runOnUiThread
                    if (fresh != null) {
                        setupRetryMs = SETUP_RETRY_FIRST_MS
                        deliver(fresh, null, startedAt)
                    }
                    // A first Home still being set up: asked again, less often each time, not left
                    // "Setting up…" for good.
                    else if (startedAt == generation && shown?.building == true) {
                        handler.removeCallbacks(retry)
                        handler.postDelayed(retry, setupRetryMs)
                        setupRetryMs = (setupRetryMs * 2).coerceAtMost(SETUP_RETRY_MAX_MS)
                    }
                }
                if (fresh != null && p == null) Feed.warmBrowse()
            }
            // Keeps Who's watching up to date (names, avatars, new profiles).
            runCatching { Profiles.fetch() }
            // The profile's audio and subtitle choices, as the server keeps them.
            PlayerPrefs.sync(this)
        }
    }

    private fun focusedIds() = focused?.let { (row, item) -> row.id to item.id }

    /** Asking again: while nothing could be shown, or a first Home's setting up failed. Only while
     *  this screen is in front (it's asked again on coming back). */
    private var setupRetryMs = SETUP_RETRY_FIRST_MS
    private val retry = Runnable { if (shown == null || shown?.building == true) refresh() }

    /** Shows a Home that just came from the server, without reshuffling under someone browsing. */
    private fun deliver(json: Feed.Home, keepFocus: Pair<String, String>?, startedAt: Int) {
        when {
            // A change made since this download began wins; its own refresh follows.
            startedAt != generation -> Unit
            changesSaving > 0 && json.stale -> Unit
            keepFocus != null -> apply(json, keepFocus)
            json.json == shown?.json -> freshStart = false
            // Back after a long while (a night's sleep): the fresh Home in full, not held.
            freshStart -> { freshStart = false; apply(json, focusedIds()) }
            // The first Home was still being set up (only Continue watching): the full one replaces it,
            // focus staying on the card it was on.
            shown?.building == true -> apply(json, focusedIds())
            // Home is on screen (or just coming back to it): never redraw it under the viewer.
            shown != null -> applyWhileBrowsing(json)
            else -> apply(json)
        }
    }

    /**
     * A fresh Home once one is showing: what the viewer can't be disturbed by stays as it is,
     * everything else updates in place. The row they're in, and the featured carousel (always on
     * screen), take the fresh version only if it has the same titles in the same order (a card's
     * details changed); rows added or taken away above where they are would move them, so those
     * wait. Whatever waits is applied when they next come back to Home.
     */
    private fun applyWhileBrowsing(json: Feed.Home) {
        val rows = json.rows
        val fresh = withLocalRows(rows)
        val current = adapter.rows
        val here = focused?.first?.id?.takeIf { focusedOnHome() }
        val steady = setOfNotNull(here, Feed.FEATURED)
        var waits = false
        val merged = fresh.map { row ->
            val old = current.firstOrNull { it.id == row.id }
            if (row.id in steady && old != null && old.items.map { it.id } != row.items.map { it.id }) old.also { waits = true }
            else row
        }
        val at = current.indexOfFirst { it.id == here }
        val applied = adapter.applyInPlace(merged) || (at >= 0 && adapter.applyBelow(merged, at))
        if (!applied) {
            pending = json
            return
        }
        feedRows = rows
        shown = json
        shownFor = Profiles.currentId
        pending = if (waits) json else null
    }

    /** Whether focus is on one of Home's rows (not the side menu, the sound button…). */
    private fun focusedOnHome() = rowsView.hasFocus()

    /** The row this screen adds itself (Apps, when the menu brings it up), kept where it is. */
    private fun withLocalRows(rows: List<Row>) = rows.toMutableList().apply {
        adapter.rows.forEachIndexed { i, r -> if (r.id == Apps.ROW_ID) add(i.coerceAtMost(size), r) }
    }

    private fun apply(json: Feed.Home, focusOn: Pair<String, String>? = null) {
        // (A Home held back earlier is older than this one.)
        pending = null
        val rows = json.rows
        // Same rows as now (the usual case after a change): update in place, no redraw, focus stays.
        val inPlace = withLocalRows(rows)
        if (shown != null && focusOn != null && adapter.applyInPlace(inPlace)) {
            shown = json
            shownFor = Profiles.currentId
            feedRows = rows
            if (!json.building) { if (rows.isEmpty()) showStatus("Nothing here yet.") else hideStatus() }
            return
        }
        shown = json
        shownFor = Profiles.currentId
        hideStatus()
        feedRows = rows
        onDemand = null
        adapter.submit(rows)
        // (A page with nothing on it, not being set up: said, not a blank screen.)
        if (rows.isEmpty() && !json.building) showStatus("Nothing here yet.")
        // A profile's first Home, still being set up on the server (it comes on its own, by the refresh).
        if (json.building) showStatus(if (rows.isEmpty()) "Setting up ${pageName()}…" else "Setting up the rest of ${pageName()}…",
            pulse = true, low = rows.isNotEmpty())
        // (Someone in the side menu stays there: Right comes back to the rows.)
        if (navRail.hasFocus()) return
        if (focusOn != null) afterNextLayout { focusItem(focusOn.first, focusOn.second) } else focusFirstCard()
    }

    private fun afterNextLayout(action: () -> Unit) {
        rowsView.viewTreeObserver.addOnGlobalLayoutListener(object : android.view.ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                rowsView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                rowsView.post(action)
            }
        })
    }

    /** Focuses a card; if it has gone, its row's first card; if the row has gone, the first row. */
    private fun focusItem(rowId: String, itemId: String) {
        val index = adapter.rows.indexOfFirst { it.id == rowId }.takeIf { it >= 0 } ?: return focusFirstCard()
        rowsView.scrollToPosition(index)
        rowsView.post {
            when (val holder = rowsView.findViewHolderForAdapterPosition(index)) {
                is RowsAdapter.FeaturedHolder -> holder.dots.requestFocus()
                is RowsAdapter.RowHolder -> holder.focusItem(itemId)
                else -> focusFirstCard()
            }
        }
    }

    /**
     * Long-press OK: Continue watching offers watched, alerts and removal; My List, taking it off;
     * any other title offers watched, "Not interested" or putting it on My List.
     */
    private fun longPress(row: Row, item: Item) {
        if (row.id == "continue") return continueActions(item)
        if (row.id == "mylist" && (item.type == "movie" || item.type == "series")) return myListActions(row, item)
        if (item.type == "movie" || item.type == "series") titleActions(row, item)
    }

    private fun continueActions(item: Item) {
        val series = item.type == "series"
        val video = item.videoId ?: item.id
        val what = if (series) item.episode ?: "This episode" else item.name
        val actions = mutableListOf(
            Sheet.Action(R.drawable.ic_act_watched, if (series) "Mark ${item.episode ?: "episode"} as watched" else "Mark as watched") {
                // A film leaves the row; a show moves on to its next episode (or leaves if it's caught up).
                change(item, "$what marked as watched", "/launcher/watched",
                    JSONObject().put("type", item.type).put("id", video).put("watched", true)) {
                    if (!series || it.nextVideoId == null) null
                    else it.copy(videoId = it.nextVideoId, episode = it.nextEpisode, progress = null, nextVideoId = null, nextEpisode = null)
                }
            },
        )
        if (series) actions += if (item.muted) Sheet.Action(R.drawable.ic_act_bell, "Tell me about new episodes") {
            change(item, "You'll hear about new episodes of ${item.name}", "/launcher/notify",
                JSONObject().put("id", item.id).put("on", true)) { it.copy(muted = false) }
        } else Sheet.Action(R.drawable.ic_act_bell_off, "Don't tell me about new episodes") {
            change(item, "No more new-episode alerts for ${item.name}", "/launcher/notify",
                JSONObject().put("id", item.id).put("on", false)) { it.copy(muted = true, newEpisodes = null) }
        }
        // Started by accident, or want it from the start: back to unwatched (right after "watched").
        // A film leaves the row; a show resets this episode where it stands (and leaves if nothing
        // else was watched).
        actions.add(1, Sheet.Action(R.drawable.ic_act_unwatched,
            if (series) "Mark ${item.episode ?: "episode"} as unwatched" else "Mark as unwatched") {
            change(item, "$what marked as unwatched", "/launcher/watched",
                JSONObject().put("type", item.type).put("id", video).put("watched", false)) {
                if (series) it.copy(progress = null) else null
            }
        })
        Sheet.show(this, currentFocus, item.name, if (series) item.episode else item.year, actions)
    }

    /** Any other title: watched already, or not for you. Either way it leaves the rows (Top 10 keeps its ranks). */
    private fun titleActions(row: Row, item: Item) {
        val gone = { removeEverywhere(item.id) }
        // (A show marked watched stays on My List: only a film leaves it, as the server does.)
        val watched = { removeEverywhere(item.id, keepInMyList = item.type == "series") }
        Sheet.show(this, currentFocus, item.name, listOfNotNull(if (item.type == "series") "Series" else "Film", item.year)
            .joinToString("  ·  "), listOf(
            Sheet.Action(R.drawable.ic_act_watched, "Mark as watched") {
                change(row, item, "${item.name} marked as watched", "/launcher/watched",
                    JSONObject().put("type", item.type).put("id", item.id).put("watched", true), watched)
            },
            Sheet.Action(R.drawable.ic_act_not_interested, "Not interested") {
                change(row, item, "You won't see ${item.name} again", "/launcher/hide",
                    JSONObject().put("id", item.id).put("kind", "notInterested").put("hidden", true)
                        .put("name", item.name).put("type", item.type), gone)
            },
            // (In My List at once; it stays in the other rows too.)
            Sheet.Action(R.drawable.ic_add, "Add to My List") {
                change(row, item, "${item.name} added to My List", "/launcher/mylist",
                    JSONObject().put("id", item.id).put("type", item.type).put("on", true)) { addToMyList(item) }
            },
        ))
    }

    /** A title on My List: taking it off (it leaves that row only). */
    private fun myListActions(row: Row, item: Item) {
        Sheet.show(this, currentFocus, item.name, listOfNotNull(if (item.type == "series") "Series" else "Film", item.year)
            .joinToString("  ·  "), listOf(
            Sheet.Action(R.drawable.ic_act_close, "Remove from My List") {
                change(row, item, "${item.name} removed from My List", "/launcher/mylist",
                    JSONObject().put("id", item.id).put("type", item.type).put("on", false)) { removeFromRow(row.id, item.id) }
            },
        ))
    }

    /** Puts a title first in the My List row (in place), or makes the row, right after Continue watching.
     *  (Home only: the Shows and Movies pages have no My List.) */
    private fun addToMyList(item: Item) {
        // (One in Continue watching isn't shown in My List: it's there already, as the server has it.)
        if (page != null || adapter.rows.any { it.id == "continue" && it.items.any { i -> i.id == item.id } }) return
        val index = adapter.rows.indexOfFirst { it.id == "mylist" }
        if (index >= 0) {
            val row = adapter.rows[index]
            if (row.items.none { it.id == item.id }) adapter.setRow(row.id, row.copy(items = listOf(item) + row.items), index)
            return
        }
        val after = adapter.rows.indexOfFirst { it.id == "continue" }.takeIf { it >= 0 }
            ?: adapter.rows.indexOfFirst { it.id == Feed.FEATURED }
        adapter.setRow("mylist", Row("mylist", "My List", listOf(item)), after + 1)
    }

    /**
     * My List changes saved on another screen (a title's page, Search) for the profile on screen, shown
     * now, in place, as Home's own are; true if there were any. (The Home the server brings up to date
     * after them can be held back while browsing.) Home only: a Shows or Movies page leaves them for it.
     */
    private fun myListEdits(): Boolean {
        if (page != null) return false
        val edits = MyListEdits.take().filter { it.profile == Profiles.currentId }
        // (Nothing on screen yet, a Home on its way: the one the server brings up to date has them.)
        if (edits.isEmpty() || shown == null) return false
        // (A download begun before them would undo them; a Home held back from before them too.)
        generation++
        pending = null
        for (e in edits) {
            if (!e.on) removeFromRow("mylist", e.item.id)
            // (Home's own card for it when it has one: it has the poster.)
            else addToMyList(adapter.rows.firstNotNullOfOrNull { r -> r.items.firstOrNull { it.id == e.item.id } } ?: e.item)
        }
        return true
    }

    /** A change saved while Home's in front: a My List one from another screen is shown now. */
    private fun catchUpMyList() {
        if (!myListEdits()) return
        seenChange = Feed.changedAt
        refresh(keepFocus = focusedIds() ?: ("" to ""), afterEdit = true)
    }

    /** Takes a title out of one row (in place); the row goes if it's left empty. */
    private fun removeFromRow(rowId: String, itemId: String) {
        val index = adapter.rows.indexOfFirst { it.id == rowId }.takeIf { it >= 0 } ?: return
        val row = adapter.rows[index]
        val items = row.items.filter { it.id != itemId }
        adapter.setRow(row.id, if (items.isEmpty()) null else row.copy(items = items), index)
    }

    /** A Continue watching change: the card updates where it stands (or fades out). */
    private fun change(item: Item, done: String, path: String, body: JSONObject, update: (Item) -> Item?) =
        change(adapter.rows.firstOrNull { it.id == "continue" }, item, done, path, body) { updateContinue(item.id, update) }

    /**
     * A change from Home: shown and said at once with [local] (in place, no redraw), saved in the
     * background, then the server's Home brought up to date with it goes in, in place (as any
     * background update: nothing redraws or moves). The Home saved before the change isn't
     * shown meanwhile: it would put back what was just changed. If it couldn't be saved, Home goes
     * back to how it was.
     */
    private fun change(row: Row?, item: Item, done: String, path: String, body: JSONObject, local: () -> Unit) {
        val rowId = row?.id ?: "continue"
        val startedAt = ++generation
        val who = Profiles.currentId
        val p = page
        // (A Home held back from before the change would undo it when shown.)
        pending = null
        lastFetch = SystemClock.elapsedRealtime()
        changesSaving++
        local()
        Notice.show(this, done)
        io.execute {
            val ok = Feed.post(path, body)
            runOnUiThread {
                seenChange = Feed.changedAt
                if (!ok) {
                    changesSaving--
                    Notice.show(this, "Couldn't save that. Try again.")
                    // (Home as the server has it: this change undone, any other kept. A later change's
                    // own refresh wins over it.)
                    generation++
                    refresh(keepFocus = focusedIds() ?: (rowId to item.id))
                }
            }
            if (ok) slowIo.execute {
                val fresh = runCatching { Feed.refresh(this, p) }.onFailure { Log.w(TAG, "Home refresh failed", it) }.getOrNull()
                runOnUiThread {
                    changesSaving--
                    // (A later change wins: its own refresh follows.)
                    if (isFinishing || who != Profiles.currentId || p != page || startedAt != generation) return@runOnUiThread
                    // (Not brought up to date: what's shown stays; the next refresh catches up.) In
                    // place, as any background update: the change is on screen already, so nothing
                    // redraws, moves or takes focus.
                    // A first Home still being set up (only Continue watching) is replaced in full, as
                    // deliver does: held, "Setting up the rest…" would stay until Home is opened again.
                    if (fresh != null) {
                        if (shown?.building == true) apply(fresh, focusedIds()) else applyWhileBrowsing(fresh)
                    }
                }
            }
        }
    }

    /** Takes a title out of every row it's in (in place), except a Top 10 (top10, top10:tv…), which is a
     *  chart, and My List when [keepInMyList]. */
    private fun removeEverywhere(itemId: String, keepInMyList: Boolean = false) {
        adapter.rows.toList().forEachIndexed { index, row ->
            if (row.id.startsWith("top10") || row.id.contains(":top10") || (keepInMyList && row.id == "mylist")
                || row.items.none { it.id == itemId }) return@forEachIndexed
            val items = row.items.filter { it.id != itemId }
            adapter.setRow(row.id, if (items.isEmpty()) null else row.copy(items = items), index)
        }
    }

    /**
     * Changes one Continue watching card where it stands (its badge or episode updates, or it
     * fades out). If it belongs elsewhere now, it slides there once the server's Home arrives.
     */
    private fun updateContinue(itemId: String, update: (Item) -> Item?) {
        val index = adapter.rows.indexOfFirst { it.id == "continue" }.takeIf { it >= 0 } ?: return
        val row = adapter.rows[index]
        val items = row.items.mapNotNull { if (it.id == itemId) update(it) else it }
        adapter.setRow(row.id, if (items.isEmpty()) null else row.copy(items = items), index)
    }

    // Start on the first row (the carousel), not an Apps row the menu brought up.
    /** The viewer picked something in the side menu (a page, a profile): it closes, the rows coming. */
    private fun leaveMenu() {
        if (navRail.hasFocus()) rowsView.requestFocus()
    }

    /** A key asked for Home's start (Back, the Home key…): its first card, or with no rows the side
     *  menu, so there's always somewhere to go. */
    private fun focusHome() = if (adapter.itemCount == 0) navRail.enter() else focusFirstCard()

    private fun focusFirstCard() {
        val target = adapter.rows.indexOfFirst { it.id != Apps.ROW_ID }.coerceAtLeast(0)
        rowsView.scrollToPosition(target)
        rowsView.post {
            val holder = rowsView.findViewHolderForAdapterPosition(target) ?: return@post
            if (holder is RowsAdapter.FeaturedHolder) return@post run { holder.dots.requestFocus() }
            val cards = holder.itemView.findViewById<RecyclerView>(R.id.cards) ?: return@post
            (cards.findViewHolderForAdapterPosition(0)?.itemView ?: cards).requestFocus()
        }
    }

    private fun showInfo(row: Row, item: Item) {
        focused = row to item
        // Moving off a row the menu brought up puts it away again.
        onDemand?.takeIf { it != row.id }?.let { id ->
            onDemand = null
            rowsView.post {
                adapter.setRow(id, null, 0)
                // The rows above shifted: line the focused row up with the top again.
                afterNextLayout(::alignFocusedRow)
            }
        }
        hero.show(row, item)
        Motion.refresh(findViewById(R.id.hero))
        eyebrow.text = if (row.id == Feed.FEATURED) item.label ?: "Featured" else row.title
        title.text = item.name
        if (item.type == "app") {
            title.textSize = 50f
            meta.text = "App · press OK to open"
            reason.visibility = View.GONE
            overview.text = null
            return
        }
        if (item.type == "tile") {
            title.textSize = if (item.name.length > 18) 38f else 50f
            meta.text = "Browse  ·  press OK to open"
            reason.visibility = View.GONE
            overview.text = item.overview
            return
        }
        // Long names drop a size so two lines still leave room for the reason and plot.
        title.textSize = if (item.name.length > 18) 38f else 50f
        meta.text = listOfNotNull(
            item.episode,
            if (item.type == "series") "Series" else "Film",
            item.year,
            item.rating?.takeIf { it > 0 }?.let { "★ %.1f".format(it) },
        ).joinToString("  ·  ")
        // The AI's reason gets the marker; Continue watching shows progress; trending has only the plot.
        reason.text = when {
            item.reason != null -> "✦  ${item.reason}"
            item.progress != null && item.progress > 0.01 -> "${(item.progress * 100).toInt()}% watched"
            else -> null
        }
        reason.visibility = if (reason.text.isNullOrEmpty()) View.GONE else View.VISIBLE
        overview.text = item.overview
    }

    private fun open(row: Row, item: Item) {
        if (item.type == "app") {
            // (One disabled since, or a screen it no longer has: said, not a crash.)
            val opened = Apps.launchIntent(this, item.id)?.let { runCatching { startActivity(it) }.isSuccess } == true
            if (!opened) Notice.show(this, "Can't open ${item.name}")
            return
        }
        // Titles open their own page (it starts on the episode you're in the middle of); tiles a Browse page.
        if (item.type == "tile") {
            Feed.opened(row.id)
            return startActivity(TitleActivity.intent(this, "browse", item.id, item.name))
        }
        val source = PlaySource.ofRow(row, row.items.indexOf(item))
        Feed.interaction(item.id, "opened", source)
        startActivity(TitleActivity.intent(this, item.type, item.id, item.name, source))
    }

    /** A line on an empty Home (centred), or under its rows ([low]); [pulse]: gently breathing,
     *  for something under way. */
    private fun showStatus(text: String, pulse: Boolean = false, low: Boolean = false) {
        status.text = text
        status.visibility = View.VISIBLE
        (status.layoutParams as android.widget.FrameLayout.LayoutParams).apply {
            gravity = if (low) android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL else android.view.Gravity.CENTER
            bottomMargin = if (low) (36 * resources.displayMetrics.density).toInt() else 0
        }.also { status.layoutParams = it }
        Waiting.set(status, pulse)
    }

    private fun hideStatus() {
        Waiting.off(status)
        status.visibility = View.GONE
    }

    private var lastHeldStep = 0L
    private var lastKeyAt = 0L

    companion object {
        const val EXTRA_PROFILE_CHOSEN = "profileChosen"
        private val HELD_KEYS = setOf(android.view.KeyEvent.KEYCODE_DPAD_UP, android.view.KeyEvent.KEYCODE_DPAD_DOWN,
            android.view.KeyEvent.KEYCODE_DPAD_LEFT, android.view.KeyEvent.KEYCODE_DPAD_RIGHT)
        private const val HELD_STEP_MS = 110L
        private const val TAG = "Nightcap"
        private const val RETRY_MS = 5_000L
        /** A first Home whose setting up failed: asked again after this, doubling up to the most. */
        private const val SETUP_RETRY_FIRST_MS = 30_000L
        private const val SETUP_RETRY_MAX_MS = 300_000L
        private const val GLASS_FRAME_MS = 250L
    }
}
