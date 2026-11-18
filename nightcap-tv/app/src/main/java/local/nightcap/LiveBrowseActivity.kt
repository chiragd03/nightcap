package local.nightcap

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.util.concurrent.Executors

/**
 * Browse all, as the web app's: a grid of the channels from the household's places (its admin's
 * countries and languages; no filters for them here). From a kind's row (or its tile in More to
 * explore) it's that kind, with a search; from Search all channels it's every kind, the search
 * ready and the kinds on one line to pick from; from a household's own row, that row whole. More of
 * the grid loads as you near its end. Also lists the channels that didn't play (hidden), to try one
 * again.
 */
class LiveBrowseActivity : TvActivity() {
    private lateinit var grid: RecyclerView
    private lateinit var search: EditText
    private lateinit var pills: LinearLayout
    private lateinit var count: TextView
    private lateinit var note: TextView
    private lateinit var status: TextView
    private val io = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val adapter = GridAdapter()
    private val channels = mutableListOf<Channel>()
    private var total = 0
    private var loading = false
    private var generation = 0
    private var hiddenMode = false
    // One of the household's own rows, shown whole (no places, no filters); null for ordinary browse.
    private var rowKey: String? = null
    private var rowTitle = ""

    private var kind: String? = null
    /** Opened from a kind (its row, or its tile): that kind only, no line of kinds. */
    private var oneKind = false
    private var query = ""
    private var last: LiveBrowse? = null
    private val typed = Runnable { reload() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_live_browse)
        grid = findViewById(R.id.browseGrid)
        search = findViewById(R.id.browseSearch)
        pills = findViewById(R.id.browsePills)
        count = findViewById(R.id.browseCount)
        note = findViewById(R.id.browseNote)
        status = findViewById(R.id.browseStatus)
        hiddenMode = intent.getBooleanExtra(EXTRA_HIDDEN, false)
        kind = intent.getStringExtra(EXTRA_KIND)
        oneKind = kind != null
        rowKey = intent.getStringExtra(EXTRA_ROW)
        rowTitle = intent.getStringExtra(EXTRA_ROW_TITLE).orEmpty()
        Live.glow(findViewById(R.id.browseGlow), 220, 0x26, 320f, 0.85f, 0.1f, cornerDp = 0f)

        grid.layoutManager = GridLayoutManager(this, COLUMNS)
        grid.itemAnimator = null
        grid.adapter = adapter
        grid.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                more()
                fadeAbove()
            }
        })

        if (hiddenMode) {
            findViewById<TextView>(R.id.browseTitle).text = "Didn't play"
            search.visibility = View.GONE
            note.text = "Hidden for a week, then tried again on their own. Play one: if it plays, it's back now."
            note.visibility = View.VISIBLE
        } else if (rowKey != null) {
            // An own row shown in full: no search, no filters.
            findViewById<TextView>(R.id.browseTitle).text = rowTitle
            search.visibility = View.GONE
        } else {
            search.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    query = s.toString().trim()
                    handler.removeCallbacks(typed)
                    handler.postDelayed(typed, TYPING_PAUSE_MS)
                }
            })
            search.setOnEditorActionListener { _, action, event ->
                if (action == EditorInfo.IME_ACTION_SEARCH || event?.keyCode == KeyEvent.KEYCODE_ENTER) {
                    keyboard(false)
                    grid.post { grid.findViewHolderForAdapterPosition(0)?.itemView?.requestFocus() }
                    true
                } else false
            }
            // Search all channels: the search first, ready to type (or speak) in.
            if (intent.getBooleanExtra(EXTRA_SEARCH, false)) {
                findViewById<TextView>(R.id.browseTitle).text = "Search"
                search.post { search.requestFocus(); keyboard(true) }
            }
        }
        reload()
    }

    override fun onResume() {
        super.onResume()
        // (Back from the player: a favourite may have changed, a hidden one may play now.)
        if (last != null || hiddenMode) refreshShown()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        super.onDestroy()
    }

    // ---------- Loading ----------

    private fun reload() {
        val gen = ++generation
        loading = true
        // (Nothing in the grid yet: say so, rather than an empty screen.)
        if (channels.isEmpty()) say("Loading channels…", waiting = true)
        io.execute {
            val got = runCatching {
                if (hiddenMode) Live.hidden().let { LiveBrowse(it, it.size, it.size, it.size, false, emptyList(), emptyList(), emptyMap()) }
                else if (rowKey != null) Live.browse(null, null, null, "", 0, row = rowKey)
                else Live.browse(kind, null, null, query, 0)
            }
            handler.post {
                if (gen != generation || isFinishing) return@post
                loading = false
                got.onSuccess { b ->
                    last = b
                    channels.clear()
                    channels.addAll(b.channels)
                    total = b.count
                    adapter.notifyDataSetChanged()
                    grid.scrollToPosition(0)
                    showFilters(b)
                    val first = (currentFocus == null || currentFocus === grid) && !search.hasFocus()
                    if (first) grid.post { grid.findViewHolderForAdapterPosition(0)?.itemView?.requestFocus() ?: search.requestFocus() }
                }.onFailure {
                    Log.w(TAG, "Browse didn't load", it)
                    say("Couldn't reach the server. Try again in a moment.")
                }
            }
        }
    }

    /** The same filters again, keeping what's loaded: favourites and hidden ones change in place. */
    private fun refreshShown() {
        val gen = generation
        io.execute {
            val got = runCatching {
                if (hiddenMode) Live.hidden()
                else if (rowKey != null) Live.browse(null, null, null, "", 0, channels.size.coerceIn(60, 200), row = rowKey).channels
                else Live.browse(kind, null, null, query, 0, channels.size.coerceIn(60, 200)).channels
            }.getOrNull() ?: return@execute
            handler.post {
                if (gen != generation) return@post
                if (hiddenMode) {
                    channels.clear(); channels.addAll(got); total = got.size
                    adapter.notifyDataSetChanged()
                    count.text = if (got.isEmpty()) "" else "${got.size} channels"
                    say(if (got.isEmpty()) "Every channel plays again." else null)
                    return@post
                }
                val byId = got.associateBy { it.id }
                channels.forEachIndexed { i, c -> byId[c.id]?.let { if (it != c) { channels[i] = it; adapter.notifyItemChanged(i) } } }
            }
        }
    }

    /** Tiles scrolling up out of the grid fade as they go under the search and title (as Live TV's rows do). */
    private fun fadeAbove() {
        for (i in 0 until grid.childCount) {
            val v = grid.getChildAt(i)
            val above = (grid.paddingTop - v.top).coerceAtLeast(0)
            v.alpha = (1f - above / (v.height * 0.6f)).coerceIn(0f, 1f)
        }
    }

    private fun more() {
        if (loading || hiddenMode || channels.size >= total) return
        val lm = grid.layoutManager as GridLayoutManager
        if (lm.findLastVisibleItemPosition() < channels.size - COLUMNS * 2) return
        loading = true
        val gen = generation
        val from = channels.size
        io.execute {
            val got = runCatching {
                if (rowKey != null) Live.browse(null, null, null, "", from, row = rowKey)
                else Live.browse(kind, null, null, query, from)
            }.getOrNull()
            handler.post {
                if (gen != generation) return@post
                loading = false
                got ?: return@post
                channels.addAll(got.channels)
                adapter.notifyItemRangeInserted(from, got.channels.size)
            }
        }
    }

    /** A line over the grid; [waiting]: something under way (it breathes, see Waiting). */
    private fun say(text: String?, waiting: Boolean = false) {
        status.text = text
        status.visibility = if (text == null) View.GONE else View.VISIBLE
        Waiting.set(status, waiting && text != null)
    }

    // ---------- Filters ----------

    private fun showFilters(b: LiveBrowse) {
        val kindName = kind?.let { k -> b.options["kinds"]?.firstOrNull { it.id == k }?.name }
        if (!hiddenMode && rowKey == null) {
            findViewById<TextView>(R.id.browseTitle).text = kindName ?: if (intent.getBooleanExtra(EXTRA_SEARCH, false)) "Search" else "All channels"
            search.hint = "Search ${(kindName ?: "channels").lowercase()}"
        }
        count.text = if (b.count == 0) "" else channelsCount(b.count)
        say(when {
            b.count > 0 -> null
            hiddenMode -> "Every channel plays again."
            rowKey != null -> "Nothing on in this row right now."
            query.isNotEmpty() -> "No channel called “$query” here."
            else -> "No channels here."
        })
        if (hiddenMode || rowKey != null) return
        // After the search: every kind on one line (not from a kind's own row), the one shown lit;
        // then the channels that didn't play, if any.
        pills.removeAllViews()
        if (!oneKind) {
            pill("All", kind == null) { pick(null) }
            b.options["kinds"].orEmpty().filter { it.count > 0 }.forEach { o -> pill(o.name, kind == o.id) { pick(o.id) } }
        }
        if (b.hidden > 0) pill("Didn't play · ${b.hidden}", false) { startActivity(intent(this, null, hidden = true)) }
        findViewById<View>(R.id.browseKinds).visibility = if (pills.childCount > 0) View.VISIBLE else View.GONE
    }

    /** Another kind on the line: the grid for it, focus staying on its pill. */
    private fun pick(k: String?) {
        if (k == kind) return
        kind = k
        reload()
    }

    private fun channelsCount(n: Int) = if (n == 1) "1 channel" else "${"%,d".format(n)} channels"

    private fun pill(text: String, lit: Boolean, onClick: () -> Unit) {
        val dp = resources.displayMetrics.density
        val v = TextView(this).apply {
            this.text = text
            setBackgroundResource(R.drawable.pill_bg)
            // The kind shown: gold, and dark on the white of focus like the rest.
            setTextColor(if (!lit) getColorStateList(R.color.nav_item_fg) else android.content.res.ColorStateList(
                arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(getColor(R.color.ink), getColor(R.color.lamp))))
            textSize = 11f
            fontVariationSettings = if (lit) "'wght' 750" else "'wght' 600"
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding((14 * dp).toInt(), 0, (14 * dp).toInt(), 0)
            isFocusable = true
            if (lit) tag = LIT
            setOnClickListener { onClick() }
        }
        pills.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, (30 * dp).toInt()).apply { marginEnd = (8 * dp).toInt() })
    }

    private fun keyboard(show: Boolean) {
        val imm = getSystemService(InputMethodManager::class.java) ?: return
        if (show) imm.showSoftInput(search, 0) else imm.hideSoftInputFromWindow(search.windowToken, 0)
    }

    // ---------- The grid ----------

    private fun open(at: Int) {
        // Up and Down in the player go along what's loaded here, at most a row's worth either side.
        val from = (at - 30).coerceAtLeast(0)
        val list = channels.subList(from, (at + 30).coerceAtMost(channels.size)).toList()
        val title = when {
            hiddenMode -> "Didn't play"
            rowKey != null -> rowTitle
            else -> last?.options?.get("kinds")?.firstOrNull { it.id == kind }?.name ?: if (query.isNotEmpty()) "“$query”" else "All channels"
        }
        startActivity(LivePlayerActivity.intent(this, list, at - from, title))
    }

    private fun toggleFavourite(at: Int) {
        val ch = channels.getOrNull(at) ?: return
        val on = !ch.favourite
        io.execute {
            val ok = Live.favourite(ch.id, on)
            handler.post {
                if (ok && channels.getOrNull(at)?.id == ch.id) {
                    channels[at] = ch.copy(favourite = on)
                    adapter.notifyItemChanged(at)
                }
                Notice.show(this, if (!ok) "Couldn't save that. Try again." else if (on) "Added to My channels" else "Taken out of My channels")
            }
        }
    }

    inner class GridAdapter : RecyclerView.Adapter<Holder>() {
        override fun getItemCount() = channels.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val v = Live.inflate(parent)
            val dp = parent.resources.displayMetrics.density
            v.layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { marginEnd = (13 * dp).toInt(); bottomMargin = (18 * dp).toInt() }
            v.findViewById<View>(R.id.channelSub).visibility = View.VISIBLE
            return Holder(v)
        }

        override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(channels[position])
    }

    inner class Holder(view: View) : RecyclerView.ViewHolder(view) {
        init {
            view.setOnFocusChangeListener { v, focused ->
                Motion.focus(v, focused, 1.08f)
                v.findViewById<TextView>(R.id.channelName).setTextColor(getColor(if (focused) R.color.text else R.color.muted))
            }
            view.setOnClickListener { bindingAdapterPosition.takeIf { it >= 0 }?.let(::open) }
            view.setOnLongClickListener { v ->
                val at = bindingAdapterPosition.takeIf { it >= 0 } ?: return@setOnLongClickListener true
                channels.getOrNull(at)?.let { ch -> Live.myChannelsSheet(this@LiveBrowseActivity, v, ch) { toggleFavourite(at) } }
                true
            }
            // The top row goes up to the filters.
            view.setOnKeyListener { _, code, e ->
                if (code == KeyEvent.KEYCODE_DPAD_UP && e.action == KeyEvent.ACTION_DOWN && bindingAdapterPosition in 0 until COLUMNS && search.visibility == View.VISIBLE) {
                    // Up to the kind shown on the line of kinds, else to the search.
                    val lit = (0 until pills.childCount).map { pills.getChildAt(it) }.firstOrNull { it.tag == LIT }
                    (lit ?: pills.getChildAt(0)?.takeIf { pills.isShown } ?: search).requestFocus(); true
                } else false
            }
        }

        fun bind(ch: Channel) {
            itemView.alpha = 1f              // (a reused tile may have faded out at the top)
            Live.bind(itemView, ch)
            // Own items (state set) keep the "about"/start line Live.bind gives them; ordinary channels
            // show language · country here.
            if (ch.state == null) {
                val sub = itemView.findViewById<TextView>(R.id.channelSub)
                sub.text = (ch.languages.take(1) + ch.countries.take(1)).joinToString(" · ")
                sub.visibility = View.VISIBLE
            }
        }
    }

    companion object {
        private const val TAG = "Nightcap"
        private const val EXTRA_KIND = "kind"
        private const val EXTRA_HIDDEN = "hidden"
        private const val EXTRA_ROW = "row"
        private const val EXTRA_ROW_TITLE = "rowTitle"
        private const val EXTRA_SEARCH = "search"
        private const val LIT = "lit"
        private const val COLUMNS = 5
        private const val TYPING_PAUSE_MS = 400L

        fun intent(context: Context, kind: String?, hidden: Boolean = false, row: String? = null, rowTitle: String = "",
                   search: Boolean = false): Intent =
            Intent(context, LiveBrowseActivity::class.java).putExtra(EXTRA_KIND, kind).putExtra(EXTRA_HIDDEN, hidden)
                .putExtra(EXTRA_ROW, row).putExtra(EXTRA_ROW_TITLE, rowTitle).putExtra(EXTRA_SEARCH, search)
    }
}
