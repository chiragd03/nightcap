package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * A title's page (seasons and episodes, or a Watch card for films, then cast and similar
 * titles) or an actor's page (their best-known titles). Episodes play in the Nightcap player;
 * holding OK offers watched, alerts and rating.
 */
class TitleActivity : TvActivity() {

    private lateinit var rowsView: RecyclerView
    private lateinit var eyebrow: TextView
    private lateinit var title: TextView
    private lateinit var meta: TextView
    private lateinit var reason: TextView
    private lateinit var overview: TextView
    private lateinit var status: TextView
    private lateinit var hero: Hero
    private lateinit var navRail: NavRail

    private val io = Executors.newSingleThreadExecutor()
    /** For the AI's More like this picks (a few seconds): never holds up [io]. */
    private val slowIo = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    /** The page that failed to load, while "Press OK to try again" shows. */
    private var retryPath: String? = null
    /** The card last focused, so reloads put focus back on it. */
    private var focusedCard: String? = null
    /** The last change (Feed.changedAt) this page has caught up with. */
    private var seenChange = Feed.changedAt
    private val adapter = SectionsAdapter(onFocus = ::showCard, onClick = ::open, onLongClick = ::cardMenu)
    private var page: Page? = null
    private var heroItem: Item? = null
    private var similarShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_title)
        rowsView = findViewById(R.id.rows)
        eyebrow = findViewById(R.id.eyebrow)
        title = findViewById(R.id.title)
        meta = findViewById(R.id.meta)
        reason = findViewById(R.id.reason)
        overview = findViewById(R.id.overview)
        status = findViewById(R.id.status)
        // A title's page is for reading and choosing: its trailer plays without sound.
        hero = Hero(this, findViewById<ImageView>(R.id.backdrop), findViewById<TextureView>(R.id.trailer), silent = true)

        rowsView.layoutManager = TopAlignLayoutManager(this)
        rowsView.setItemViewCacheSize(12)
        rowsView.itemAnimator = null
        rowsView.adapter = adapter
        rowsView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) = rowsView.fadeRowsAbove()
        })

        navRail = findViewById(R.id.navRail)
        Nav.install(
            this, navRail, selected = "home", dim = listOf<View>(rowsView, findViewById(R.id.hero)),
            fallbackFocus = { rowsView.requestFocus() },
        )

        val id = intent.getStringExtra(EXTRA_ID)!!
        val type = intent.getStringExtra(EXTRA_TYPE)!!
        title.text = intent.getStringExtra(EXTRA_NAME).orEmpty()
        status.text = "Loading…"
        status.visibility = View.VISIBLE
        Waiting.on(status)
        load(when (type) {
            "person" -> Pages.personPath(id)
            "browse" -> Pages.browsePath(id)
            else -> Pages.titlePath(type, id)
        })
        if (type != "person" && type != "browse") loadSimilar(type, id)
    }

    override fun onResume() {
        super.onResume()
        heroItem?.let { hero.show(HERO_ROW, it) }
        // Back from the player (or a change made elsewhere): reload so ticks and progress are current;
        // and again whenever a change lands while this page is in front (the player's last save comes
        // after this page is back).
        Feed.onChange = ::catchUp
        catchUp()
    }

    private fun catchUp() {
        val h = page?.header
        // (This page's own saves reload it themselves, focus kept on the card acted on.)
        if (h == null || h.type == "person" || h.type == "browse" || saving > 0 || Feed.changedAt <= seenChange) return
        seenChange = Feed.changedAt
        val before = page
        io.execute {
            val fresh = runCatching { Pages.parsePage(Pages.get(Pages.titlePath(h.type, h.id), fresh = true)) }.getOrNull()
            runOnUiThread {
                if (isFinishing || fresh == null) return@runOnUiThread
                // The player moved you on (the next episode, another season): focus follows it.
                val moved = before != null && focusCardId(fresh) != focusCardId(before)
                refreshKeepingFocus(fresh, if (moved) focusCardId(fresh) else focusedCard)
                // (Rows the same, cards updated in place: focus is moved here. Never behind an open menu.)
                if (moved && !Sheet.open) fresh.sections.indexOfFirst { it.id == fresh.focusSection }
                    .takeIf { it >= 0 }?.let { focus(it, fresh.focusIndex) }
            }
        }
    }

    /** Saves of this page's own under way (main thread only). */
    private var saving = 0

    /** One of this page's own saves is done: the change it made is caught up with. */
    private fun saved() {
        saving--
        seenChange = Feed.changedAt
    }

    /** The card the server says is the one to be on (the episode you're up to). */
    private fun focusCardId(p: Page) = p.sections.firstOrNull { it.id == p.focusSection }?.cards?.getOrNull(p.focusIndex)?.id

    // Left on a row's first card opens the side menu; Right on its last card does nothing.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val retry = retryPath
        if (retry != null && page == null && event.keyCode in OK_KEYS) {
            if (event.action == KeyEvent.ACTION_UP) {
                retryPath = null
                status.text = "Loading…"
                Waiting.on(status)
                load(retry)
                // (More like this failed with it: asked again too.)
                val type = intent.getStringExtra(EXTRA_TYPE)!!
                if (type != "person" && type != "browse" && !similarShown) loadSimilar(type, intent.getStringExtra(EXTRA_ID)!!)
            }
            return true
        }
        val focus = currentFocus
        if (focus != null && !Nav.contains(navRail, focus) && rowEdgeKey(focus, event, onStartLeft = navRail::enter)) return true
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        // The screen is gone: drop its timers; work already started finishes, then its thread ends.
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        slowIo.shutdown()
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        if (Feed.onChange == ::catchUp) Feed.onChange = null
        hero.pause()
    }

    /** Loads the page, quietly trying again a few times (the server may be restarting). */
    private fun load(path: String, attempt: Int = 0): Unit = io.execute {
        // Browse pages always come fresh: the server leaves out what this profile has watched since.
        // A title's page too: what was watched since (here, on Home, on the phone) shows.
        val result = runCatching { Pages.parsePage(Pages.get(path, fresh = attempt > 0 || path.startsWith(BROWSE_PREFIX) ||
            path.startsWith(TITLE_PREFIX))) }
        runOnUiThread {
            if (isFinishing) return@runOnUiThread
            result.onSuccess(::render).onFailure {
                Log.w(TAG, "Page failed (attempt ${attempt + 1})", it)
                if (attempt < LOAD_TRIES - 1) {
                    handler.postDelayed({ load(path, attempt + 1) }, 2_000L * (attempt + 1))
                } else {
                    retryPath = path
                    Waiting.off(status)
                    status.text = "This page isn't available right now. Press OK to try again."
                }
            }
        }
    }

    /** Shows TMDB's list at once and swaps in the AI's ranked picks when they're ready. */
    /** More like this: what the server has at once (TMDB's list, or the AI's picks if it has them),
     *  then, if those aren't the AI's, its picks once they're worked out. */
    private fun loadSimilar(type: String, id: String): Unit = io.execute {
        val json = runCatching { Pages.get(Pages.similarPath(type, id)) }.getOrNull() ?: return@execute
        showSimilar(json)
        // (Not once the page is gone: its thread has stopped taking work.)
        if (!json.optBoolean("ai") && !isDestroyed) runCatching {
            slowIo.execute { runCatching { Pages.rankSimilar(type, id) }.onSuccess(::showSimilar) }
        }
    }

    private fun showSimilar(json: JSONObject) {
        val cards = Pages.parseCards(json.getJSONArray("items"))
        runOnUiThread {
            if (!isFinishing && cards.isNotEmpty()) similarShown = true
            if (!isFinishing && cards.isNotEmpty()) adapter.putSimilar(Section("similar", "More like this", "posters", cards))
        }
    }

    private fun render(p: Page) {
        page = p
        Waiting.off(status)
        status.visibility = View.GONE
        heroItem = Item(
            id = p.header.id, type = p.header.type, name = p.header.name, year = null, rating = null, poster = null,
            // Title pages show the art only; trailers play on Home.
            backdrop = p.header.backdrop, trailer = null, overview = p.header.overview,
            reason = null, episode = null, progress = null, videoId = null,
        ).also { hero.show(HERO_ROW, it) }
        showHeader()
        adapter.fallbackArt = p.header.backdrop
        adapter.submit(p.sections)
        val section = p.sections.indexOfFirst { it.id == p.focusSection }.takeIf { it >= 0 } ?: 0
        val index = if (section > 0 || p.focusSection != null) p.focusIndex else 0
        focus(section, index)
    }

    private fun focus(section: Int, index: Int) {
        rowsView.scrollToPosition(section)
        rowsView.post {
            val row = rowsView.findViewHolderForAdapterPosition(section) as? SectionsAdapter.SectionHolder ?: return@post
            row.focusCard(index)
        }
    }

    private fun showHeader() {
        val h = page?.header ?: return
        eyebrow.text = when (h.type) { "person" -> "Cast"; "browse" -> "Browse"; "series" -> "Series"; else -> "Film" }
        setTitle(h.name)
        meta.text = listOfNotNull(h.facts.takeIf { it.isNotEmpty() }, h.rating?.let { "★ $it" }).joinToString("  ·  ")
        reason.visibility = View.GONE
        overview.text = h.overview
    }

    private fun setTitle(name: String) {
        title.text = name
        title.textSize = if (name.length > 18) 38f else 50f
    }

    private fun showCard(section: Section, card: Card) {
        focusedCard = card.id
        val h = page?.header ?: return
        Motion.refresh(findViewById(R.id.hero))
        when (section.kind) {
            "episodes" -> {
                eyebrow.text = if (h.type == "series") "${h.name}  ·  ${section.title}" else h.name
                setTitle(card.name)
                val date = niceDate(card.aired)
                meta.text = listOfNotNull(
                    card.episode,
                    if (card.upcoming) (date?.let { "Coming $it" } ?: "Coming soon") else date?.let { "Aired $it" },
                    card.rating?.let { "★ $it" },
                ).joinToString("  ·  ")
                reason.visibility = View.GONE
                overview.text = card.overview
            }
            "cast" -> {
                eyebrow.text = "Cast"
                setTitle(card.name)
                meta.text = card.character?.let { "as $it" }
                reason.text = "Press OK to see their films and series"
                reason.visibility = View.VISIBLE
                overview.text = null
            }
            else -> {
                // On an actor's or a Browse page keep its name in view while browsing its titles.
                eyebrow.text = if (h.type == "person" || h.type == "browse") "${h.name}  ·  ${section.title}" else section.title
                // A Browse page has no title of its own, so the picture follows the focused card.
                if (h.type == "browse" && card.backdrop != null) hero.show(HERO_ROW, Item(
                    id = card.id, type = card.type ?: "movie", name = card.name, year = card.year, rating = null,
                    poster = card.poster, backdrop = card.backdrop, trailer = null, overview = card.overview,
                    reason = null, episode = null, progress = null, videoId = null,
                ))
                setTitle(card.name)
                meta.text = listOfNotNull(if (card.type == "series") "Series" else "Film", card.year, card.rating?.let { "★ $it" })
                    .joinToString("  ·  ")
                reason.text = card.reason?.let { if (h.type == "person") it else "✦  $it" }
                reason.visibility = if (card.reason != null) View.VISIBLE else View.GONE
                overview.text = card.overview
            }
        }
    }

    private fun open(section: Section, card: Card) {
        val h = page?.header ?: return
        when (section.kind) {
            "episodes" -> if (card.upcoming) {
                val date = niceDate(card.aired)
                Notice.show(this, if (date != null) "Not out yet. Arrives $date" else "Not out yet")
            } else startActivity(WatchActivity.intent(this, h.type, card.id, h.name, episodeLabel(card), h.backdrop,
                source = PlaySource.from(intent)))
            "cast" -> startActivity(intent(this, "person", card.id, card.name))
            else -> {
                // A title from this page's rows (More like this, an actor's or a Browse page's titles).
                val source = PlaySource("row", if (h.type == "browse") "${h.id}/${section.id}" else section.id, section.cards.indexOf(card))
                Feed.interaction(card.id, "opened", source)
                startActivity(intent(this, card.type ?: "movie", card.id, card.name, source))
            }
        }
    }

    /** "S5 E13  ·  Stress Relief" for an episode; null for a film's Watch card. */
    private fun episodeLabel(card: Card): String? {
        val parts = card.id.split(':')
        return if (parts.size == 3) "S${parts[1]} E${parts[2]}  ·  ${card.name}" else null
    }

    /** Holding OK on an episode (or a film's Watch card): watched or not, new-episode alerts, rating, My List. */
    private fun cardMenu(section: Section, card: Card) {
        val h = page?.header ?: return
        if (section.kind != "episodes" && (card.type == "movie" || card.type == "series")) return posterActions(section, card)
        if (section.kind != "episodes") return
        val series = h.type == "series"
        val what = if (series) card.episode ?: "Episode" else h.name
        // Watched: offer unwatched. Not started: offer watched. Partly watched: both.
        val started = (card.progress ?: 0f) > 0.01f
        val actions = mutableListOf<Sheet.Action>()
        // (Not out yet: nothing to mark; alerts and rating still.)
        if (!card.watched && !card.upcoming) actions += Sheet.Action(R.drawable.ic_act_watched, "Mark as watched") {
            markWatched(h, card, true, "$what marked as watched")
        }
        if ((card.watched || started) && !card.upcoming) actions += Sheet.Action(R.drawable.ic_act_unwatched, "Mark as unwatched") {
            markWatched(h, card, false, "$what marked as unwatched")
        }
        if (series) {
            // The rest of the season, or the whole show, in one go.
            val season = section.id.removePrefix("s").toIntOrNull()
            val aired = section.cards.filter { !it.upcoming }
            if (season != null && season > 0 && aired.any { !it.watched }) {
                actions += Sheet.Action(R.drawable.ic_act_watched, "Mark Season $season as watched") {
                    markMany(h, season, true, "Season $season marked as watched")
                }
            }
            if (season != null && season > 0 && aired.any { it.watched }) {
                actions += Sheet.Action(R.drawable.ic_act_unwatched, "Mark Season $season as unwatched") {
                    markMany(h, season, false, "Season $season marked as unwatched")
                }
            }
            val unwatchedAnywhere = page?.sections.orEmpty()
                .any { sec -> sec.kind == "episodes" && sec.id != "s0" && sec.cards.any { !it.upcoming && !it.watched } }
            if (unwatchedAnywhere) actions += Sheet.Action(R.drawable.ic_act_watched, "Mark the whole show as watched") {
                markMany(h, null, true, "${h.name} marked as watched")
            }
        }
        if (series) actions += if (h.notify) Sheet.Action(R.drawable.ic_act_bell_off, "Don't tell me about new episodes") {
            setNotify(h, false, "No more new-episode alerts for ${h.name}", card.id)
        } else Sheet.Action(R.drawable.ic_act_bell, "Tell me about new episodes") {
            setNotify(h, true, "You'll hear about new episodes of ${h.name}", card.id)
        }
        actions += Sheet.Action(R.drawable.ic_act_rate, h.myRating?.let { "Your rating: ${RATINGS[it]}" } ?: "Rate ${h.name}") {
            rateMenu(h)
        }
        actions += if (h.inList) Sheet.Action(R.drawable.ic_act_close, "Remove from My List") { setInList(h, false) }
        else Sheet.Action(R.drawable.ic_add, "Add to My List") { setInList(h, true) }
        Sheet.show(this, currentFocus, if (series) card.name else h.name, if (series) card.episode else h.facts, actions)
    }

    /** A poster (More like this, an actor's titles, a Browse page): watched already, not for you, or on
     *  My List (these lists don't say what's on it already: adding it twice is harmless). */
    private fun posterActions(section: Section, card: Card) {
        val type = card.type ?: return
        Sheet.show(this, currentFocus, card.name, listOfNotNull(if (type == "series") "Series" else "Film", card.year)
            .joinToString("  ·  "), listOf(
            Sheet.Action(R.drawable.ic_act_watched, "Mark as watched") {
                dropPoster(section, card, "${card.name} marked as watched", "/launcher/watched",
                    org.json.JSONObject().put("type", type).put("id", card.id).put("watched", true))
            },
            Sheet.Action(R.drawable.ic_act_not_interested, "Not interested") {
                dropPoster(section, card, "You won't see ${card.name} again", "/launcher/hide",
                    org.json.JSONObject().put("id", card.id).put("kind", "notInterested").put("hidden", true)
                        .put("name", card.name).put("type", type))
            },
            Sheet.Action(R.drawable.ic_add, "Add to My List") {
                addToList(card.id, type, card.name, MyListEdits.item(card.id, type, card.name, card.year, card.poster, card.backdrop))
            },
        ))
    }

    /** A title shown on this page (not the page's own) put on My List: nothing on the page changes. */
    private fun addToList(id: String, type: String, name: String, item: Item) {
        saving++
        val who = Profiles.currentId
        io.execute {
            val ok = Feed.post("/launcher/mylist", org.json.JSONObject().put("id", id).put("type", type).put("on", true), changes = false)
            // (Noted before Home hears of the change, so it never sees one without the other.)
            if (ok) { MyListEdits.note(who, item, true); Feed.markChanged() }
            runOnUiThread {
                saved()
                Notice.show(this, if (ok) "$name added to My List" else "Couldn't save that. Try again.")
            }
        }
    }

    /** Takes the poster out of the page in place (every row it's in), then saves; puts it back if that fails. */
    private fun dropPoster(section: Section, card: Card, done: String, path: String, body: org.json.JSONObject) {
        val without = section.copy(cards = section.cards.filter { it.id != card.id })
        val before = page
        // (Focus goes to its neighbour in the row, or, the row gone, to the next row's first card.)
        val at = section.cards.indexOfFirst { it.id == card.id }
        val next = without.cards.getOrNull(at.coerceAtMost(without.cards.size - 1))?.id
            ?: before?.sections?.dropWhile { it.id != section.id }?.drop(1)?.firstOrNull { it.cards.isNotEmpty() }?.cards?.first()?.id
        if (section.id == "similar") adapter.updateSimilar(without)
        else before?.let { p ->
            refreshKeepingFocus(p.copy(sections = p.sections.map { sec -> sec.copy(cards = sec.cards.filter { it.id != card.id }) }
                .filter { it.cards.isNotEmpty() }), next)
        }
        saving++
        io.execute {
            val ok = Feed.post(path, body)
            // (The More like this lists kept here would bring it back.)
            if (ok) Pages.forgetSimilar()
            runOnUiThread {
                saved()
                Notice.show(this, if (ok) done else "Couldn't save that. Try again.")
                if (!ok) {
                    if (section.id == "similar") adapter.updateSimilar(section) else before?.let { refreshKeepingFocus(it) }
                }
            }
        }
    }

    private fun markWatched(h: Header, card: Card, watched: Boolean, done: String) {
        val before = page ?: return
        // Show it at once; the server confirms (or we put it back) a moment later.
        refreshKeepingFocus(before.copy(sections = before.sections.map { sec ->
            sec.copy(cards = sec.cards.map { if (it.id == card.id) it.copy(watched = watched, progress = if (watched) null else it.progress) else it })
        }), card.id)
        post("/launcher/watched", org.json.JSONObject().put("type", h.type).put("id", card.id).put("watched", watched), done, before, card.id)
    }

    /** Not for me / I like it / Love it, for the whole title; it can be changed or cleared any time. */
    private fun rateMenu(h: Header) {
        val options = listOf(-1 to R.drawable.ic_rate_down, 1 to R.drawable.ic_rate_up, 2 to R.drawable.ic_rate_love)
            .map { (value, icon) ->
                Sheet.Action(icon, (if (h.myRating == value) "✓  " else "") + RATINGS.getValue(value)) { rate(h, value) }
            }.toMutableList()
        if (h.myRating != null) options += Sheet.Action(R.drawable.ic_act_close, "Clear my rating") { rate(h, null) }
        Sheet.show(this, currentFocus, h.name, "Your rating", options)
    }

    private fun rate(h: Header, value: Int?) {
        val before = page ?: return
        page = before.copy(header = h.copy(myRating = value))
        saving++
        io.execute {
            val ok = Feed.post("/launcher/rating", org.json.JSONObject().put("id", h.id).put("value", value ?: org.json.JSONObject.NULL))
            runOnUiThread {
                saved()
                if (!ok) page = before
                Notice.show(this, when {
                    !ok -> "Couldn't save that. Try again."
                    value == null -> "Rating cleared"
                    else -> "Rated: ${RATINGS[value]}"
                })
            }
        }
    }

    /** This title on My List, or off it: shown at once, put back if it couldn't be saved. */
    private fun setInList(h: Header, on: Boolean) {
        val before = page ?: return
        page = before.copy(header = h.copy(inList = on))
        saving++
        val who = Profiles.currentId
        io.execute {
            val ok = Feed.post("/launcher/mylist", org.json.JSONObject().put("id", h.id).put("type", h.type).put("on", on), changes = false)
            // (No poster on this page: Home uses its own card for the title if it has one. Noted before
            // Home hears of the change, so it never sees one without the other.)
            if (ok) { MyListEdits.note(who, MyListEdits.item(h.id, h.type, h.name, null, null, h.backdrop), on); Feed.markChanged() }
            runOnUiThread {
                saved()
                if (!ok) page = before
                Notice.show(this, when {
                    !ok -> "Couldn't save that. Try again."
                    on -> "${h.name} added to My List"
                    else -> "${h.name} removed from My List"
                })
            }
        }
    }

    /** A whole season ([season]) or the whole show (null): every aired episode ticked or unticked. */
    private fun markMany(h: Header, season: Int?, watched: Boolean, done: String) {
        val before = page ?: return
        val sectionId = season?.let { "s$it" }
        refreshKeepingFocus(before.copy(sections = before.sections.map { sec ->
            if (sec.kind != "episodes" || sec.id == "s0" || (sectionId != null && sec.id != sectionId)) sec
            else sec.copy(cards = sec.cards.map { if (it.upcoming) it else it.copy(watched = watched, progress = if (watched) null else it.progress) })
        }))
        val body = org.json.JSONObject().put("type", "series").put("id", h.id).put("watched", watched)
        season?.let { body.put("season", it) }
        post("/launcher/watched", body, done, before, focusedCard ?: h.id)
    }

    private fun setNotify(h: Header, on: Boolean, done: String, cardId: String) {
        val before = page ?: return
        page = before.copy(header = h.copy(notify = on))
        post("/launcher/notify", org.json.JSONObject().put("id", h.id).put("on", on), done, before, cardId)
    }

    /** Sends a change to the server, then reloads this page; if it didn't save, puts [before] back. */
    private fun post(path: String, body: org.json.JSONObject, done: String, before: Page, cardId: String) {
        saving++
        io.execute { postNow(path, body, done, before, cardId) }
    }

    private fun postNow(path: String, body: org.json.JSONObject, done: String, before: Page, cardId: String) {
        val ok = Feed.post(path, body)
        val h = before.header
        val fresh = if (ok) runCatching { Pages.parsePage(Pages.get(Pages.titlePath(h.type, h.id), fresh = true)) }.getOrNull() else null
        runOnUiThread {
            saved()
            Notice.show(this, if (ok) done else "Couldn't save that. Try again.")
            (if (ok) fresh else before)?.let { refreshKeepingFocus(it, cardId) }
        }
    }

    /**
     * Swaps in the reloaded page with focus back on [cardId] (the card you acted on, or were on).
     * Found by id, not by what has focus: a closing menu briefly leaves nothing focused.
     */
    private fun refreshKeepingFocus(p: Page, cardId: String? = focusedCard) {
        page = p
        // Same rows as now: only changed cards update, focus stays put, nothing scrolls.
        if (adapter.update(p.sections)) return
        adapter.submit(p.sections)
        val section = p.sections.indexOfFirst { sec -> sec.cards.any { it.id == cardId } }
        if (section >= 0) focus(section, p.sections[section].cards.indexOfFirst { it.id == cardId })
        else focus(0, 0)
    }

    companion object {
        private const val TAG = "Nightcap"
        private const val LOAD_TRIES = 3
        private val BROWSE_PREFIX = Pages.browsePath("").removeSuffix(".json")
        private val TITLE_PREFIX = Pages.titlePath("", "").substringBefore("/.json").substringBeforeLast('/')
        private val OK_KEYS = setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)
        private const val EXTRA_TYPE = "type"
        private const val EXTRA_ID = "id"
        private const val EXTRA_NAME = "name"
        private val RATINGS = mapOf(-1 to "Not for me", 1 to "I like it", 2 to "Love it")
        private val HERO_ROW = Row("title", "", emptyList())

        /** [type] is "movie", "series" or "person". */
        fun intent(context: Context, type: String, id: String, name: String?, source: PlaySource = PlaySource.DIRECT): Intent =
            source.into(Intent(context, TitleActivity::class.java)
                .putExtra(EXTRA_TYPE, type).putExtra(EXTRA_ID, id).putExtra(EXTRA_NAME, name))
    }
}

/** Rows of a title page; each section draws its own kind of card. */
class SectionsAdapter(
    private val onFocus: (Section, Card) -> Unit,
    private val onClick: (Section, Card) -> Unit,
    private val onLongClick: (Section, Card) -> Unit = { _, _ -> },
) : RecyclerView.Adapter<SectionsAdapter.SectionHolder>() {

    private var sections: List<Section> = emptyList()
    private var similar: Section? = null
    /** The show's backdrop, for episodes without a still of their own (e.g. not aired yet). */
    var fallbackArt: String? = null

    fun submit(newSections: List<Section>) {
        sections = newSections
        notifyDataSetChanged()
    }

    /** The same rows with some cards changed: updates just those, in place. False if the rows differ. */
    fun update(newSections: List<Section>): Boolean {
        if (sections.isEmpty() || newSections.map { it.id } != sections.map { it.id }) return false
        val old = sections
        sections = newSections
        old.forEachIndexed { i, sec -> if (sec != newSections[i]) notifyItemChanged(i, PAYLOAD_CARDS) }
        return true
    }

    /** Adds or refreshes "More like this" at the end, leaving the row alone while it has focus. */
    fun putSimilar(section: Section) {
        val existing = similar
        similar = section
        if (sections.isEmpty()) return  // the page itself hasn't arrived; submit() will include it
        if (existing == null) notifyItemInserted(itemCount - 1) else notifyItemChanged(itemCount - 1, PAYLOAD_SIMILAR)
    }

    /** "More like this" with a card taken out: updated in place, even while it has focus. */
    fun updateSimilar(section: Section) {
        similar = section
        if (sections.isNotEmpty()) notifyItemChanged(itemCount - 1, PAYLOAD_CARDS)
    }

    private fun all() = sections + listOfNotNull(similar)

    override fun getItemCount() = if (sections.isEmpty()) 0 else all().size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        SectionHolder(LayoutInflater.from(parent.context).inflate(R.layout.row, parent, false) as RowLayout)

    override fun onBindViewHolder(holder: SectionHolder, position: Int) = holder.bind(all()[position])

    override fun onBindViewHolder(holder: SectionHolder, position: Int, payloads: MutableList<Any>) {
        if (PAYLOAD_SIMILAR in payloads && holder.itemView.hasFocus()) return
        if (PAYLOAD_CARDS in payloads) return holder.update(all()[position])
        holder.bind(all()[position])
    }

    inner class SectionHolder(view: RowLayout) : RecyclerView.ViewHolder(view) {
        private val title: TextView = view.findViewById(R.id.rowTitle)
        private val cards: RecyclerView = view.findViewById(R.id.cards)
        private var section: Section? = null
        private var lastFocused = 0
        private val cardsAdapter = object : RecyclerView.Adapter<CardHolder>() {
            override fun getItemCount() = section?.cards?.size ?: 0
            override fun getItemViewType(position: Int) = when (section?.kind) {
                "episodes" -> 0; "cast" -> 1; "prompt" -> 3; else -> 2
            }
            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CardHolder {
                val layout = when (viewType) {
                    0 -> R.layout.card_episode; 1 -> R.layout.card_cast; 3 -> R.layout.card_prompt; else -> R.layout.card_poster
                }
                val v = LayoutInflater.from(parent.context).inflate(layout, parent, false)
                if (viewType != 1) {
                    v.outlineProvider = ViewOutlineProvider.BACKGROUND
                    v.clipToOutline = true
                }
                return CardHolder(v, viewType)
            }
            override fun onBindViewHolder(holder: CardHolder, position: Int) = holder.bind(section!!.cards[position])
        }

        init {
            cards.layoutManager = AnchorStartLayoutManager(view.context)
            cards.itemAnimator = InPlace.animator()
            cards.adapter = cardsAdapter
            view.remembered = { cards.findViewHolderForAdapterPosition(lastFocused)?.itemView }
        }

        fun bind(s: Section) {
            section = s
            title.text = s.title
            lastFocused = 0
            cardsAdapter.notifyDataSetChanged()
        }

        /** Same row, some cards changed: rebind only those (see InPlace). */
        fun update(s: Section) {
            val old = section?.cards.orEmpty()
            InPlace.update(cards, cardsAdapter, old, s.cards, { it.id }) { section = s }
        }

        fun focusCard(index: Int) {
            cards.scrollToPosition(index)
            cards.post { (cards.findViewHolderForAdapterPosition(index)?.itemView ?: cards).requestFocus() }
        }

        inner class CardHolder(view: View, private val viewType: Int) : RecyclerView.ViewHolder(view) {
            private var card: Card? = null

            init {
                view.setOnFocusChangeListener { v, focused ->
                    Motion.focus(v, focused, if (viewType == 1) 1.1f else 1.12f)
                    title.setTextColor(v.context.getColor(if (focused) R.color.text else R.color.muted))
                    if (focused) {
                        lastFocused = bindingAdapterPosition
                        card?.let { onFocus(section!!, it) }
                    }
                }
                view.setOnClickListener { card?.let { onClick(section!!, it) } }
                view.setOnLongClickListener { card?.let { onLongClick(section!!, it) }; true }
            }

            fun bind(c: Card) {
                card = c
                when (viewType) {
                    0 -> {
                        val still = itemView.findViewById<ImageView>(R.id.still)
                        // (An episode's number, "E3" of "S1 E3"; a film's card has its facts there instead.)
                        val number = c.episode?.takeIf { c.id.count { it == ':' } == 2 }?.substringAfter(' ')
                        if (c.upcoming) {
                            // Not aired: the show's art, dimmed, with when it arrives.
                            still.load(fallbackArt)
                            still.alpha = 0.4f
                            val date = niceDate(c.aired)?.substringBeforeLast(' ')
                            itemView.findViewById<TextView>(R.id.label).text =
                                listOfNotNull(number, date?.let { "Coming $it" } ?: "Coming soon").joinToString("  ·  ")
                        } else {
                            still.alpha = 1f
                            still.load(c.thumbnail) { listener(onError = { _, _ -> still.load(fallbackArt) }) }
                            itemView.findViewById<TextView>(R.id.label).text = listOfNotNull(number, c.name).joinToString("  ·  ")
                        }
                        itemView.findViewById<View>(R.id.watched).visibility = if (c.watched) View.VISIBLE else View.GONE
                        val progress = c.progress?.takeIf { it > 0.01f }
                        itemView.findViewById<View>(R.id.progressTrack).visibility = if (progress != null) View.VISIBLE else View.GONE
                        itemView.findViewById<View>(R.id.progressFill).scaleX = (progress ?: 0f).coerceIn(0f, 1f)
                    }
                    3 -> itemView.findViewById<TextView>(R.id.promptQuery).text = "“${c.name}”"
                    1 -> {
                        // Round by clipping the view (not by redrawing the photo, which a TV whose density
                        // Nightcap corrects would draw at the wrong size: see TvActivity).
                        itemView.findViewById<ImageView>(R.id.photo).apply {
                            outlineProvider = ROUND
                            clipToOutline = true
                        }.load(c.photo)
                        itemView.findViewById<TextView>(R.id.name).text = c.name
                        itemView.findViewById<TextView>(R.id.character).text = c.character
                    }
                    else -> {
                        itemView.findViewById<ImageView>(R.id.poster).loadPoster(c.poster, itemView.findViewById(R.id.posterName), c.name)
                        listOf(R.id.badge, R.id.newBadge, R.id.progressTrack).forEach { itemView.findViewById<View>(it).visibility = View.GONE }
                    }
                }
            }
        }
    }

    companion object {
        private const val PAYLOAD_SIMILAR = "similar"
        private const val PAYLOAD_CARDS = "cards"
    }
}

/** A view's outline as the circle that fits it (cast photos are clipped to it). */
private val ROUND = object : android.view.ViewOutlineProvider() {
    override fun getOutline(view: View, outline: android.graphics.Outline) = outline.setOval(0, 0, view.width, view.height)
}
