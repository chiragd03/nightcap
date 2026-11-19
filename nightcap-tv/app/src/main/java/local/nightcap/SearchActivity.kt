package local.nightcap

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.TextureView
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import java.net.URLEncoder
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Search as you type (TMDB titles and people) with Smart Search (the AI search
 * on the home server) one press away: the button in the bar, the card leading the results, or a
 * suggestion when the bar is empty.
 */
class SearchActivity : TvActivity() {

    private lateinit var query: EditText
    private lateinit var askAi: TextView
    private lateinit var suggestions: View
    private lateinit var details: View
    private lateinit var eyebrow: TextView
    private lateinit var title: TextView
    private lateinit var meta: TextView
    private lateinit var reason: TextView
    private lateinit var rowsView: RecyclerView
    private lateinit var hero: Hero
    private lateinit var navRail: NavRail

    private val io = Executors.newFixedThreadPool(2)
    private val handler = Handler(Looper.getMainLooper())
    private val adapter = SectionsAdapter(onFocus = ::showCard, onClick = ::open, onLongClick = ::menu)
    private var titles: Section? = null
    private var people: Section? = null
    private var ai: Section? = null
    private var aiQuery: String? = null
    @Volatile private var latest = ""
    /** The query the title results on screen are for; and Enter pressed before they came. */
    private var titlesFor: String? = null
    private var enterPending = false
    /** Pulses the Smart Search button while a smart search is running. */
    private var busyPulse: android.animation.ObjectAnimator? = null
    private val quick = Runnable { quickSearch(latest) }
    /** What's typed that results are on their way for, and what's typed that couldn't be searched. */
    private var searching: String? = null
    private var failed: String? = null
    /** Shown while nothing is typed, from Home's saved screen (no network needed). */

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_search)
        query = findViewById(R.id.query)
        askAi = findViewById(R.id.askAi)
        suggestions = findViewById(R.id.suggestions)
        details = findViewById(R.id.details)
        eyebrow = findViewById(R.id.eyebrow)
        title = findViewById(R.id.title)
        meta = findViewById(R.id.meta)
        reason = findViewById(R.id.reason)
        rowsView = findViewById(R.id.rows)
        hero = Hero(this, findViewById<ImageView>(R.id.backdrop), findViewById<TextureView>(R.id.trailer))

        rowsView.layoutManager = TopAlignLayoutManager(this)
        rowsView.itemAnimator = null
        rowsView.adapter = adapter
        rowsView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) = rowsView.fadeRowsAbove()
        })

        query.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                latest = s.toString().trim()
                enterPending = false
                handler.removeCallbacks(quick)
                showAskAi()
                if (latest.length >= 2) handler.postDelayed(quick, TYPING_PAUSE_MS) else clear()
            }
        })
        query.setOnEditorActionListener { _, action, event ->
            val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
            if (action == EditorInfo.IME_ACTION_SEARCH || enter) true.also { enter() } else false
        }
        askAi.setOnClickListener { askSmart(latest) }
        buildSuggestions()
        showAi()
        // The list kept on the TV before profiles had their own: mixed between profiles, so it goes.
        getSharedPreferences("nightcap", MODE_PRIVATE).edit().remove("recentSearches").apply()
        showRecents()
        loadRecents()

        navRail = findViewById(R.id.navRail)
        Nav.install(
            this, navRail, selected = "search",
            dim = listOf<View>(rowsView, details, suggestions, findViewById(R.id.bar)),
            fallbackFocus = { query.requestFocus() },
            onPick = { id -> if (id == "search") query.requestFocus() else Nav.open(this, id) },
        )
        show()

        query.requestFocus()
        query.post { keyboard(true) }
    }

    // Left on a row's first card opens the side menu; Right on its last card does nothing.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val focus = currentFocus
        // Back in the results goes to the search box first; Back again leaves.
        // (On the press, as the side menu and the long-press menu close on theirs: the release that
        // follows their closing is let through, and does nothing.)
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_DOWN && focus != null &&
            Nav.contains(rowsView, focus)) {
            query.requestFocus()
            return true
        }
        if (focus != null && !Nav.contains(navRail, focus) && rowEdgeKey(focus, event, onStartLeft = navRail::enter)) return true
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        // The screen is gone: drop its timers; work already started finishes, then its thread ends.
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        super.onDestroy()
    }

    override fun onPause() {
        super.onPause()
        hero.pause()
    }

    /** Smart Search ideas, two to a row. */
    private fun buildSuggestions() {
        val rows = listOf(findViewById<LinearLayout>(R.id.suggestionRow1), findViewById(R.id.suggestionRow2))
        SUGGESTIONS.forEachIndexed { i, text ->
            rows[i / 2].addView(chip(rows[i / 2], "✦  $text") { runSmart(text) })
        }
    }

    /** Your last few searches, one press to run again. */
    private fun showRecents() {
        val box = findViewById<LinearLayout>(R.id.recentChips)
        box.removeAllViews()
        // (Three fit the row, a Smart Search phrase included.)
        val recent = recents().take(3)
        // Picked again, it's as if typed and Enter pressed: a description goes to Smart Search again.
        recent.forEach { q -> box.addView(chip(box, q) { query.setText(q); query.setSelection(q.length); enter() }) }
        val visible = if (recent.isEmpty()) View.GONE else View.VISIBLE
        box.visibility = visible
        findViewById<View>(R.id.recentLabel).visibility = visible
    }

    // Inflated against its row so the chip keeps its height and spacing.
    private fun chip(row: LinearLayout, text: String, onClick: () -> Unit): TextView =
        (LayoutInflater.from(this).inflate(R.layout.chip_suggestion, row, false) as TextView).apply {
            this.text = text
            setOnClickListener { onClick() }
        }

    private fun runSmart(text: String) {
        query.setText(text)
        query.setSelection(text.length)
        askSmart(text)
    }

    /** Enter (or a recent search picked): a known title ("harry potter") jumps to the results; a
     *  description asks the AI. Decided on this query's own results: asked now if they aren't in. */
    private fun enter() {
        if (latest.length < 2) return
        if (titlesFor != latest) {
            enterPending = true
            handler.removeCallbacks(quick)
            if (searching != latest) quickSearch(latest)
            return
        }
        if (titleMatch() || !aiOn) {
            remember(latest)
            keyboard(false)
            focusFirstResult()
        } else askSmart(latest)
    }

    /** This profile's recent searches, kept by the server (each profile has its own). */
    private var recentList: List<String> = emptyList()

    private fun recents(): List<String> = recentList

    private fun loadRecents() = io.execute {
        val json = runCatching { Pages.get("/launcher/recent.json", fresh = true) }
            .onFailure { Log.w("Nightcap", "Recent searches unavailable", it) }.getOrNull() ?: return@execute
        val list = parseRecents(json)
        runOnUiThread {
            if (isFinishing) return@runOnUiThread
            recentList = list
            showRecents()
            aiOn = json.optBoolean("aiAvailable", true)
            showAi()
        }
    }

    private fun parseRecents(o: JSONObject) = o.optJSONArray("recent")?.let { a -> (0 until a.length()).map(a::getString) }.orEmpty()

    private fun remember(q: String) {
        if (q.length < 2) return
        // Shown at once; the server keeps it for this profile.
        recentList = (listOf(q) + recentList.filter { !it.equals(q, ignoreCase = true) }).take(8)
        showRecents()
        io.execute { Feed.post("/launcher/recent", JSONObject().put("q", q)) }
    }

    private fun quickSearch(q: String) {
        searching = q
        failed = null
        if (q == latest && query.hasFocus()) showTopResult()
        io.execute {
            // (Typed on since: this one isn't asked; the newest isn't kept waiting behind it.)
            if (q != latest) return@execute runOnUiThread { if (searching == q) searching = null }
            val result = runCatching { Pages.get("/launcher/search/quick.json?q=${encode(q)}") }
            runOnUiThread {
                // A newer search is on its way.
                if (q != latest) return@runOnUiThread run { if (searching == q) searching = null }
                searching = null
                result.onSuccess { json ->
                    titles = Section("titles", "Titles", "posters", Pages.parseCards(json.getJSONArray("titles")))
                    people = Section("people", "People", "cast", Pages.parseCards(json.getJSONArray("people")))
                    titlesFor = q
                }.onFailure {
                    Log.w(TAG, "Quick search failed", it)
                    failed = q
                    // (The last query's results aren't left up as if they were this one's.)
                    titles = null
                    people = null
                    titlesFor = null
                }
                show()
                if (enterPending) {
                    enterPending = false
                    if (titlesFor == q) enter()
                }
            }
        }
    }

    /** Whether this household has the AI, as the server last said (kept, so opening Search doesn't flicker).
     *  It's optional: without it, nothing about it shows here, and it all comes back once a key is added. */
    private var aiOn: Boolean
        get() = getSharedPreferences("nightcap", MODE_PRIVATE).getBoolean(KEY_AI_ON, true)
        set(on) = getSharedPreferences("nightcap", MODE_PRIVATE).edit().putBoolean(KEY_AI_ON, on).apply()

    private fun showAi() {
        val on = aiOn
        if (!on) {
            ai = null
            aiQuery = null
        }
        listOf(R.id.smartLabel, R.id.suggestionRow1, R.id.suggestionRow2).forEach {
            findViewById<View>(it).visibility = if (on) View.VISIBLE else View.GONE
        }
        showAskAi()
        show()
    }

    private fun showAskAi() {
        askAi.visibility = when {
            !aiOn -> View.GONE
            latest.length >= 2 -> View.VISIBLE
            else -> View.INVISIBLE
        }
    }

    private fun askSmart(q: String) {
        if (!aiOn || q.length < 2 || (busyPulse != null && q == aiQuery)) return
        setSearching(true)
        remember(q)
        keyboard(false)
        aiQuery = q
        ai = Section("ai", "✦  Smart Search is thinking…", "prompt", listOf(promptCard(q)))
        show()
        io.execute {
            // (Two AI calls on the server: up to a minute.)
            val result = runCatching { Pages.get("/launcher/search/ai.json?q=${encode(q)}", client = Feed.slow) }
            runOnUiThread {
                if (q != aiQuery) return@runOnUiThread
                setSearching(false)
                result.onSuccess { json ->
                    // The AI can't be used now (its monthly limit, no key): Smart Search goes away, the
                    // title results stay; this answer isn't kept for when it's back.
                    if (json.optString("note").isNotEmpty()) {
                        Pages.forget("/launcher/search/ai.json?q=${encode(q)}")
                        aiOn = false
                        return@onSuccess showAi()
                    }
                    val cards = Pages.parseCards(json.getJSONArray("items"))
                    ai = if (cards.isEmpty()) Section("ai", "✦  Smart Search found nothing — try describing it differently", "prompt", listOf(promptCard(q)))
                    else Section("ai", "✦  Smart picks", "posters", cards)
                    show()
                    // (Only if they're still waiting on it, not typing something else or browsing.)
                    if (q == latest && (query.hasFocus() || askAi.hasFocus())) focusFirstResult()
                }.onFailure {
                    Log.w(TAG, "AI search failed", it)
                    ai = Section("ai", "✦  Smart Search isn't available right now — press OK to try again", "prompt", listOf(promptCard(q)))
                    show()
                }
            }
        }
    }

    /** The button shows the search is under way: "Searching…" with a gentle pulse. */
    private fun setSearching(on: Boolean) {
        busyPulse?.cancel()
        busyPulse = null
        askAi.alpha = 1f
        askAi.text = if (on) "✦  Searching…" else "✦  Smart Search"
        if (on) {
            busyPulse = android.animation.ObjectAnimator.ofFloat(askAi, View.ALPHA, 1f, 0.45f).apply {
                duration = 700
                repeatMode = android.animation.ValueAnimator.REVERSE
                repeatCount = android.animation.ValueAnimator.INFINITE
                start()
            }
        }
    }

    private fun promptCard(q: String) = Card(
        id = "ask", type = null, name = q, episode = null, overview = null, thumbnail = null, aired = null,
        rating = null, character = null, photo = null, poster = null, reason = null, year = null,
    )

    /** True when what's typed is (part of) a real title name, i.e. a plain title search. */
    private fun titleMatch(): Boolean {
        val q = normalise(latest)
        if (q.isEmpty()) return false
        // (Typed words are the start of the title's ("interst" is Interstellar); a title's are whole words
        // in what's typed ("It" isn't in "a heist with a twist").)
        return titles?.cards?.take(3)?.any { normalise(it.name).let { n -> n.isNotEmpty() && (" $n".contains(" $q") || " $q ".contains(" $n ")) } } == true
    }

    /** Lower case, letters and digits of any script (Hindi too), single spaces. */
    private fun normalise(s: String) = s.lowercase().replace(Regex("[^\\p{L}\\p{N} ]"), "").replace(Regex(" +"), " ").trim()

    /**
     * A title search puts Titles first; anything else leads with the AI's row (its picks, or the
     * Ask AI card). People follow. With nothing typed, the suggestions show instead.
     */
    private fun show() {
        val typed = latest.length >= 2
        val aiRow = ai?.takeIf { aiQuery == latest } ?: if (typed && aiOn) Section("ask", "✦  Smart Search", "prompt", listOf(promptCard(latest))) else null
        val aiFirst = aiOn && (ai?.takeIf { aiQuery == latest } != null || !titleMatch())
        val order = when {
            !typed -> emptyList()
            aiFirst -> listOf(aiRow, titles, people)
            else -> listOf(titles, aiRow, people)
        }
        adapter.submit(order.filterNotNull().filter { it.cards.isNotEmpty() })
        val inRows = currentFocus?.let { Nav.contains(rowsView, it) } == true
        suggestions.visibility = if (typed || inRows) View.GONE else View.VISIBLE
        details.visibility = if (typed || inRows) View.VISIBLE else View.GONE
        // While typing, preview the top match; once browsing the rows, focus drives the details.
        if (typed && query.hasFocus()) showTopResult()
    }

    private fun showTopResult() {
        val top = titles?.cards?.firstOrNull()
        Waiting.off(meta)
        if (top != null) showCard(titles!!, top) else {
            eyebrow.text = "Search"
            title.text = latest
            // While results are on their way, say so (gently breathing); if they couldn't come, say that.
            meta.text = when (latest) {
                searching -> "Searching…"
                failed -> "Couldn't search right now. Check the connection and try again."
                else -> if (titles != null) "No titles found" else null
            }
            if (latest == searching) Waiting.on(meta)
            reason.text = if (aiOn) "Press ✦ Smart Search to find titles that match this description." else null
        }
    }

    private fun clear() {
        titles = null
        people = null
        if (aiQuery != latest) ai = null
        show()
        hero.clear()
    }

    private fun focusFirstResult() = rowsView.post {
        (rowsView.findViewHolderForAdapterPosition(0) as? SectionsAdapter.SectionHolder)?.focusCard(0)
    }

    private fun showCard(section: Section, card: Card) {
        Waiting.off(meta)
        Motion.refresh(details)
        when (section.kind) {
            "prompt" -> {
                eyebrow.text = "✦  Smart Search"
                title.text = card.name
                meta.text = "Understands moods, plots, actors and roles"
                reason.text = "Press OK to find titles that fit this description."
            }
            "cast" -> {
                eyebrow.text = "People"
                title.text = card.name
                meta.text = card.character?.let { "Known for $it" }
                reason.text = "Press OK to see their films and series"
            }
            else -> {
                eyebrow.text = when (section.id) {
                    "ai" -> "✦  Smart pick"
                    else -> "Titles"
                }
                title.text = card.name
                meta.text = listOfNotNull(if (card.type == "series") "Series" else "Film", card.year, card.rating?.let { "★ $it" })
                    .joinToString("  ·  ")
                reason.text = card.reason?.let { "✦  $it" } ?: card.overview
            }
        }
        val item = Item(
            id = card.id, type = card.type ?: "movie", name = card.name, year = null, rating = null, poster = null,
            backdrop = card.backdrop, trailer = null, overview = null, reason = null, episode = null, progress = null, videoId = null,
        )
        hero.show(Row(section.id, section.title, emptyList()), item)
    }

    private fun open(section: Section, card: Card) {
        if (section.kind != "prompt") remember(latest)
        when (section.kind) {
            "prompt" -> askSmart(card.name)
            "cast" -> startActivity(TitleActivity.intent(this, "person", card.id, card.name))
            else -> {
                Feed.interaction(card.id, "searched_opened", SEARCH)
                startActivity(TitleActivity.intent(this, card.type ?: "movie", card.id, card.name, SEARCH))
            }
        }
    }

    /** Holding OK on a film or show: mark it watched (a show: every aired episode), not interested, or
     *  put it on My List (results are the same for everyone, so they can't say it's on it already:
     *  adding it twice is harmless). */
    private fun menu(section: Section, card: Card) {
        val type = card.type?.takeIf { it == "movie" || it == "series" } ?: return
        if (section.kind == "cast" || section.kind == "prompt") return
        val who = Profiles.currentId
        fun save(path: String, body: org.json.JSONObject, done: String, drop: Boolean = false, onList: Boolean = false) = io.execute {
            val ok = Feed.post(path, body, changes = !onList)
            // (Noted before Home hears of the change, so it never sees one without the other.)
            if (ok && onList) { MyListEdits.note(who, MyListEdits.item(card.id, type, card.name, card.year, card.poster, card.backdrop), true); Feed.markChanged() }
            runOnUiThread {
                Notice.show(this, if (ok) done else "Couldn't save that. Try again.")
                // ("You won't see it again": it goes from the results too.)
                if (ok && drop) {
                    titles = titles?.let { s -> s.copy(cards = s.cards.filter { it.id != card.id }) }
                    ai = ai?.let { s -> s.copy(cards = s.cards.filter { it.id != card.id }) }
                    show()
                }
            }
        }
        Sheet.show(this, currentFocus, card.name, listOfNotNull(if (type == "series") "Series" else "Film", card.year)
            .joinToString("  ·  "), listOf(
            Sheet.Action(R.drawable.ic_act_watched, "Mark as watched") {
                save("/launcher/watched", org.json.JSONObject().put("type", type).put("id", card.id).put("watched", true),
                    "${card.name} marked as watched")
            },
            Sheet.Action(R.drawable.ic_act_not_interested, "Not interested") {
                save("/launcher/hide", org.json.JSONObject().put("id", card.id).put("kind", "notInterested").put("hidden", true),
                    "You won't see ${card.name} again", drop = true)
            },
            Sheet.Action(R.drawable.ic_add, "Add to My List") {
                save("/launcher/mylist", org.json.JSONObject().put("id", card.id).put("type", type).put("on", true),
                    "${card.name} added to My List", onList = true)
            },
        ))
    }

    private fun keyboard(show: Boolean) {
        val imm = getSystemService(InputMethodManager::class.java)
        if (show) imm.showSoftInput(query, InputMethodManager.SHOW_IMPLICIT) else imm.hideSoftInputFromWindow(query.windowToken, 0)
    }

    private fun encode(q: String) = URLEncoder.encode(q, "UTF-8")

    private val SEARCH = PlaySource("search")

    companion object {
        private const val TAG = "Nightcap"
        private const val TYPING_PAUSE_MS = 300L
        private const val KEY_AI_ON = "aiAvailable"
        private val SUGGESTIONS = listOf(
            "Something funny and light for a tired evening",
            "A thriller where the villain wins in the end",
            "A small town hiding a dark secret",
            "A slow-burn series with a mind-blowing ending",
        )
    }
}
