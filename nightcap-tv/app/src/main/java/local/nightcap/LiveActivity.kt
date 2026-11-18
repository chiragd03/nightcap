package local.nightcap

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
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView
import coil.dispose
import coil.load
import java.util.concurrent.Executors

/**
 * Live TV: like Home, the focused channel on top and rows below. My channels (this profile's), then
 * a row per kind of channel (News, Music…) from the places the household picked, each ending in
 * Browse all. Resting on a channel plays it, muted, top right; OK watches it; a long press adds it
 * to My channels (or takes it out).
 */
class LiveActivity : TvActivity() {
    private lateinit var rowsView: RecyclerView
    private lateinit var navRail: NavRail
    private lateinit var status: TextView
    private lateinit var eyebrow: TextView
    private lateinit var title: TextView
    private lateinit var meta: TextView
    private lateinit var reason: TextView
    private lateinit var glow: View
    private lateinit var art: ImageView
    private lateinit var previewView: TextureView
    private lateinit var aura: AuraView
    private lateinit var empty: View
    private lateinit var emptyTiles: android.widget.LinearLayout
    /** "Check again" was pressed: if there's still nothing, say so. */
    private var checking = false
    private val io = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val adapter = RowsAdapter()
    private var page: LivePage? = null
    /** Every kind there is (the household's places applied), with how many each has: More to explore. */
    private var kinds: List<LiveBrowse.Option> = emptyList()
    private var shown: Channel? = null
    private var preview: ExoPlayer? = null
    private var previewing: String? = null
    /** Where focus was, to come back to after the page is loaded again. */
    private var focusKey: Pair<String, String>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_live)
        rowsView = findViewById(R.id.rows)
        status = findViewById(R.id.status)
        eyebrow = findViewById(R.id.eyebrow)
        title = findViewById(R.id.title)
        meta = findViewById(R.id.meta)
        reason = findViewById(R.id.reason)
        glow = findViewById(R.id.liveGlow)
        art = findViewById(R.id.liveArt)
        previewView = findViewById(R.id.livePreview)
        aura = findViewById(R.id.liveAura)
        empty = findViewById(R.id.liveEmpty)
        emptyTiles = findViewById(R.id.liveEmptyTiles)
        rowsView.layoutManager = TopAlignLayoutManager(this)
        rowsView.itemAnimator = null
        rowsView.adapter = adapter
        rowsView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) = rowsView.fadeRowsAbove()
        })
        navRail = findViewById(R.id.navRail)
        Nav.install(
            this, navRail, selected = "live",
            dim = listOf<View>(rowsView, findViewById(R.id.hero)),
            fallbackFocus = ::focusFirst,
            onPick = { id -> if (id == "live") focusFirst() else Nav.open(this, id) },
        )
        findViewById<View>(R.id.hero).visibility = View.INVISIBLE
    }

    override fun onResume() {
        super.onResume()
        load()
    }

    override fun onPause() {
        super.onPause()
        stopPreview()
        handler.removeCallbacksAndMessages(null)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val focus = currentFocus
        // No channel list yet: Left from the first tile (or from nowhere) opens the side panel, and
        // any other key with nothing focused lands on the first tile.
        if (empty.visibility == View.VISIBLE && event.action == KeyEvent.ACTION_DOWN && (focus == null || !Nav.contains(navRail, focus))) {
            val first = emptyTiles.getChildAt(0)
            when {
                event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT && (focus == null || focus === first) -> { navRail.enter(); return true }
                focus == null && event.keyCode in DPAD_KEYS -> { first?.requestFocus(); return true }
            }
        }
        if (focus != null && !Nav.contains(navRail, focus) && rowEdgeKey(focus, event, onStartLeft = navRail::enter)) return true
        return super.dispatchKeyEvent(event)
    }

    private fun load() {
        // (Nothing on screen yet: say so, rather than a blank page.)
        if (page == null) say("Loading Live TV…", waiting = true)
        io.execute { loadNow() }
    }

    private fun loadNow() {
        val got = runCatching { Live.page() }
        val allKinds = runCatching { Live.browse(null, null, null, "", 0, 1).options["kinds"] }.getOrNull()
        handler.post {
            if (allKinds != null) kinds = allKinds
            if (isFinishing || isDestroyed) return@post
            got.onSuccess(::show).onFailure { e ->
                Log.w(TAG, "Live TV didn't load", e)
                if (page == null) {
                    say(if (e is Live.NotOnServer) "This Nightcap server doesn't have Live TV yet." else "Couldn't reach the server. Try again in a moment.")
                    // (Asked again by itself while this screen is up; onPause drops it.)
                    if (e !is Live.NotOnServer && NightcapApp.resumed === this)
                        handler.postDelayed({ load() }, RELOAD_MS)
                }
            }
        }
    }

    /** No channel list yet: a soft glow, what Live TV needs and where it's added, and two tiles. */
    private fun showEmpty() {
        val wasShown = empty.visibility == View.VISIBLE
        findViewById<TextView>(R.id.liveEmptyHint).text =
            "Live TV shows channels from your household's channel lists.\nAsk your household's admin to add one."
        if (emptyTiles.childCount == 0) {
            emptyTiles.addView(emptyTile("ALREADY ADDED ONE?", "Check again", "Look for channels now", R.drawable.ic_nav_live, EMPTY_TINT) {
                checking = true
                load()
            })
            emptyTiles.addView(emptyTile("MEANWHILE", "Home", "Back to your titles", R.drawable.ic_nav_home, HOME_TINT) {
                Nav.open(this, "home")
            })
        }
        aura.visibility = View.VISIBLE
        aura.glowTo(EMPTY_TINT)
        findViewById<View>(R.id.liveArtFrame).visibility = View.GONE
        empty.visibility = View.VISIBLE
        if (!wasShown) emptyTiles.post { emptyTiles.getChildAt(0)?.requestFocus() }
        if (checking) Notice.show(this, "No channel list yet. Add one on the web, then check again.")
        checking = false
    }

    private fun hideEmpty() {
        checking = false
        if (empty.visibility != View.VISIBLE) return
        empty.visibility = View.GONE
        aura.visibility = View.GONE
        findViewById<View>(R.id.liveArtFrame).visibility = View.VISIBLE
        rowsView.post { focusFirst() }
    }

    /** A glass tile, as on the Connect screen: a quiet label and icon on top, a big name below. */
    private fun emptyTile(label: String, name: String, sub: String, icon: Int, tint: Int, onClick: () -> Unit): View =
        LayoutInflater.from(this).inflate(R.layout.connect_choice, emptyTiles, false).apply {
            findViewById<TextView>(R.id.tileLabel).text = label
            findViewById<TextView>(R.id.tileName).text = name
            findViewById<TextView>(R.id.tileSub).text = sub
            findViewById<ImageView>(R.id.tileIcon).setImageResource(icon)
            isFocusable = true
            setOnClickListener { onClick() }
            val dp = resources.displayMetrics.density
            setOnFocusChangeListener { v, has ->
                val s = if (has) 1.05f else 1f
                v.animate().scaleX(s).scaleY(s).translationZ(if (has) 14 * dp else 0f).setDuration(240).setInterpolator(Motion.ease).start()
                // The glow behind takes the focused tile's colour, as on the Connect screen.
                if (has) aura.glowTo(tint)
            }
        }

    /** A line in the middle of the page; [waiting]: something under way (it breathes, see Waiting). */
    private fun say(text: String?, waiting: Boolean = false) {
        status.text = text
        status.visibility = if (text == null) View.GONE else View.VISIBLE
        Waiting.set(status, waiting && text != null)
    }

    private fun show(p: LivePage) {
        val first = page == null
        page = p
        if (p.lists == 0) {
            adapter.submit(emptyList())
            findViewById<View>(R.id.hero).visibility = View.INVISIBLE
            say(null)
            showEmpty()
            return
        }
        hideEmpty()
        say(null)
        val rows = pageRows(p)
        if (first || adapter.rows.isEmpty()) {
            val keep = focusKey
            adapter.submit(rows)
            rowsView.post { keep?.let { (row, ch) -> focusOn(row, ch) } ?: if (first) focusFirst() else Unit }
        } else if (adapter.rows != rows) {
            // As Home does: only what changed moves (a row comes or goes, tiles slide), focus kept.
            val hadFocus = rowsView.hasFocus()
            adapter.apply(rows)
            // A row that came above the focused one (My channels) mustn't land over the top of the
            // page: once laid out, the focused row goes back to the top and those above fade (as Home).
            afterNextLayout {
                if (hadFocus && !rowsView.hasFocus()) focusKey?.let { (row, ch) -> focusOn(row, ch) } ?: focusFirst()
                rowsView.focusedChild?.let { f ->
                    val dy = f.top - rowsView.paddingTop
                    if (dy != 0) rowsView.smoothScrollBy(0, dy, Motion.ease, 260)
                }
                rowsView.fadeRowsAbove()
            }
        }
        if (first) {
            findViewById<View>(R.id.hero).visibility = View.VISIBLE
            (p.hero ?: p.rows.firstNotNullOfOrNull { it.channels.firstOrNull() })?.let { hero(it, last = p.hero != null) }
        } else shown?.let { now ->
            // The one on top, as the page has it now (taken out of My channels while watching, say).
            val fresh = (listOfNotNull(p.hero) + p.rows.flatMap { it.channels }).firstOrNull { it.id == now.id }
            if (fresh != null && fresh != now) {
                shown = null
                hero(fresh, shownLast)
            }
        }
    }

    /**
     * The page's rows, as the web app has them: My channels first (only with some), the household's
     * own rows, then the first [KIND_ROWS] kinds, each ending in its Browse all; then More to explore,
     * a tile for every other kind (with channels, the household's places applied); last, Search every
     * channel, one wide panel.
     */
    private fun pageRows(p: LivePage): List<PageRow> {
        val counts = kinds.associate { it.id to it.count }
        fun count(r: LiveRow) = r.count.takeIf { it > 0 } ?: r.kind?.let { counts[it] } ?: r.channels.size
        val rest = p.rows.filter { it.key != MINE && it.channels.isNotEmpty() }
        var kindRows = 0
        val shownRows = rest.filter { it.isOwnRow || it.kind == null || ++kindRows <= KIND_ROWS }
        val later = rest.filter { it !in shownRows }
        val rows = p.rows.filter { it.key == MINE && it.channels.isNotEmpty() }.map { r -> PageRow(r.key, r.title, r, r.channels.map(Tile::Ch)) } +
            shownRows.map { r -> PageRow(r.key, r.title, r, r.channels.map(Tile::Ch) + Tile.All(r, count(r))) }
        val explore = later.map { r -> Tile.Kind(r.kind ?: r.key, r.title, count(r), r.channels.mapNotNull { it.logo }) } +
            kinds.filter { k -> k.count > 0 && rest.none { it.kind == k.id } }.map { Tile.Kind(it.id, it.name, it.count, emptyList()) }
        val logos = p.rows.flatMap { r -> r.channels.mapNotNull { it.logo } }.distinct()
        return rows + listOfNotNull(explore.takeIf { it.isNotEmpty() }?.let { PageRow(EXPLORE, "More to explore", null, it) }) +
            PageRow(EVERY, "", null, listOf(Tile.Every(p.shown, logos)))
    }

    private fun afterNextLayout(action: () -> Unit) {
        rowsView.viewTreeObserver.addOnGlobalLayoutListener(object : android.view.ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                rowsView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                rowsView.post(action)
            }
        })
    }

    private fun focusFirst() {
        if (empty.visibility == View.VISIBLE) {
            emptyTiles.getChildAt(0)?.requestFocus()
            return
        }
        val rows = adapter.rows
        val at = rows.indexOfFirst { it.tiles.isNotEmpty() }.takeIf { it >= 0 } ?: 0
        if (rows.isEmpty()) return
        rowsView.scrollToPosition(at)
        rowsView.post { (rowsView.findViewHolderForAdapterPosition(at) as? RowHolder)?.focus(0) }
    }

    private fun focusOn(rowKey: String, channelId: String) {
        val at = adapter.rows.indexOfFirst { it.key == rowKey }
        if (at < 0) return focusFirst()
        rowsView.scrollToPosition(at)
        rowsView.post {
            val holder = rowsView.findViewHolderForAdapterPosition(at) as? RowHolder ?: return@post
            val index = adapter.rows[at].tiles.indexOfFirst { it.id == channelId }.coerceAtLeast(0)
            holder.focus(index)
        }
    }

    /** The channel on top: its name, what it is, and (after a rest) its live picture. An upcoming
     *  item shows when it starts, and isn't previewed (nor an ended one). */
    private var shownLast = false

    private fun hero(channel: Channel, last: Boolean = false) {
        if (shown?.id == channel.id) return
        shown = channel
        shownLast = last
        eyebrow.text = when {
            channel.upcoming -> "Upcoming"
            last -> "Live · Last watched"
            else -> "Live"
        }
        title.text = channel.name
        meta.text = channel.about ?: channel.meta
        reason.text = when {
            channel.upcoming && channel.startsAt != null -> "Starts " + Live.timeText(this, channel.startsAt)
            channel.channels.size > 1 -> "${channel.channels.size} channels · " + channel.channels.joinToString(", ") { it.name }
            last -> "Press OK to carry on watching"
            channel.favourite -> "In My channels"
            else -> ""
        }
        listOf(eyebrow, title, meta, reason).forEach(Motion::refresh)
        Live.glow(glow, channel.hue, 0x66, 420f)
        findViewById<View>(R.id.liveArtFrame).visibility = View.VISIBLE
        art.setImageDrawable(null)
        channel.logo?.let { art.load(it) }
        stopPreview()
        handler.removeCallbacks(startPreview)
        // Preview an ordinary channel, a live one, or a 24/7 one; not one that hasn't started.
        if (channel.state == null || channel.state == "live" || channel.state == "24/7")
            handler.postDelayed(startPreview, PREVIEW_AFTER_MS)
    }

    private val startPreview = Runnable { shown?.let(::preview) }

    /** On top for a tile that isn't a channel (a Browse all, a kind, Search every channel): what it
     *  opens, over a glow of its colour; no picture, nothing previewed. */
    private fun heroAbout(t: Tile) {
        shown = null
        previewing = null
        handler.removeCallbacks(startPreview)
        stopPreview()
        fun channels(n: Int) = "${"%,d".format(n)} ${if (n == 1) "channel" else "channels"}"
        val hue = when (t) {
            is Tile.All -> {
                eyebrow.text = "Browse all"
                title.text = t.row.title
                meta.text = channels(t.count)
                reason.text = "Press OK for the whole row"
                220
            }
            is Tile.Kind -> {
                eyebrow.text = "More to explore"
                title.text = t.name
                meta.text = channels(t.count)
                reason.text = "Press OK to see them all"
                hueOf(t.kind)
            }
            is Tile.Every -> {
                eyebrow.text = "Every channel"
                title.text = "Search"
                meta.text = channels(t.count)
                reason.text = "By name, or look through every kind"
                40
            }
            is Tile.Ch -> return hero(t.ch)
        }
        listOf(eyebrow, title, meta, reason).forEach(Motion::refresh)
        Live.glow(glow, hue, 0x66, 420f)
        art.setImageDrawable(null)
        findViewById<View>(R.id.liveArtFrame).visibility = View.INVISIBLE
    }

    private var previewGen = 0

    /** The channel's live picture, muted, over its logo; nothing if it doesn't play (it isn't counted as failing). */
    @OptIn(UnstableApi::class)
    private fun preview(channel: Channel) {
        previewing = channel.id
        // (Only the newest ask's answer is used: an older one for the same channel would make a second player.)
        val gen = ++previewGen
        io.execute {
            val got = runCatching { Live.play(channel.id) }.getOrNull() ?: return@execute
            handler.post {
                if (gen != previewGen || previewing != channel.id || isFinishing || !hasWindowFocus()) return@post
                preview?.release()
                preview = null
                // A plain stream for the preview, or one the household's own handler can open; else none.
                val stream = got.streams.firstOrNull { it.recipe == null } ?: got.streams.firstOrNull { LiveStreams.handler != null } ?: return@post
                val p = player(this).also { preview = it }
                p.volume = 0f
                p.setVideoTextureView(previewView)
                p.addListener(object : Player.Listener {
                    override fun onRenderedFirstFrame() {
                        previewView.animate().alpha(1f).setDuration(600).start()
                    }
                })
                if (!setStream(p, this, stream)) return@post stopPreview()
                p.prepare()
                p.playWhenReady = true
            }
        }
    }

    private fun stopPreview() {
        previewing = null
        previewView.animate().cancel()
        previewView.alpha = 0f
        preview?.release()
        preview = null
    }

    private fun open(row: LiveRow, channel: Channel) {
        if (channel.upcoming) {
            val when_ = channel.startsAt?.let { "Starts " + Live.timeText(this, it) } ?: "Hasn't started yet"
            Notice.show(this, "${channel.name} · $when_")
            return
        }
        val list = row.channels
        startActivity(LivePlayerActivity.intent(this, list, list.indexOfFirst { it.id == channel.id }.coerceAtLeast(0), row.title))
    }

    private fun browse(kind: String?) = startActivity(LiveBrowseActivity.intent(this, kind))

    private fun searchAll() = startActivity(LiveBrowseActivity.intent(this, null, search = true))

    private fun browseRow(row: LiveRow) = startActivity(LiveBrowseActivity.intent(this, null, row = row.key, rowTitle = row.title))

    private fun toggleFavourite(channel: Channel) {
        val on = !channel.favourite
        io.execute {
            val ok = Live.favourite(channel.id, on)
            handler.post {
                Notice.show(this, if (!ok) "Couldn't save that. Try again." else if (on) "Added to My channels" else "Taken out of My channels")
                if (ok) load()
            }
        }
    }

    // ---------- Rows ----------

    /** A tile in a row: a channel, a row's Browse all, a kind (More to explore), or Search every channel. */
    sealed class Tile(val id: String) {
        data class Ch(val ch: Channel) : Tile(ch.id)
        data class All(val row: LiveRow, val count: Int) : Tile("#browse")
        data class Kind(val kind: String, val name: String, val count: Int, val logos: List<String>) : Tile("kind:$kind")
        data class Every(val count: Int, val logos: List<String>) : Tile("#every")
    }

    /** A row on the page: [row] is the server's (null for More to explore), [tiles] what it shows. */
    data class PageRow(val key: String, val title: String, val row: LiveRow?, val tiles: List<Tile>)

    inner class RowsAdapter : RecyclerView.Adapter<RowHolder>() {
        var rows: List<PageRow> = emptyList()
            private set

        fun submit(new: List<PageRow>) {
            rows = new
            notifyDataSetChanged()
        }

        /** The page's rows changed: a row that came or went comes or goes, and a row whose tiles
         *  changed updates just those (see [RowHolder.update]), without a redraw. */
        fun apply(new: List<PageRow>) {
            val old = rows
            val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
                override fun getOldListSize() = old.size
                override fun getNewListSize() = new.size
                override fun areItemsTheSame(o: Int, n: Int) = old[o].key == new[n].key
                override fun areContentsTheSame(o: Int, n: Int) = old[o] == new[n]
                override fun getChangePayload(o: Int, n: Int) = UPDATE
            })
            rows = new
            diff.dispatchUpdatesTo(this)
        }

        override fun getItemCount() = rows.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            RowHolder(LayoutInflater.from(parent.context).inflate(R.layout.row, parent, false) as RowLayout)

        override fun onBindViewHolder(holder: RowHolder, position: Int) = holder.bind(rows[position])

        override fun onBindViewHolder(holder: RowHolder, position: Int, payloads: MutableList<Any>) {
            if (UPDATE in payloads) holder.update(rows[position]) else holder.bind(rows[position])
        }
    }

    inner class RowHolder(view: RowLayout) : RecyclerView.ViewHolder(view) {
        private val label: TextView = view.findViewById(R.id.rowTitle)
        private val cards: RecyclerView = view.findViewById(R.id.cards)
        private var row: PageRow? = null
        private val tiles = TilesAdapter()

        init {
            cards.layoutManager = AnchorStartLayoutManager(view.context)
            cards.itemAnimator = InPlace.animator()
            cards.adapter = tiles
            view.remembered = { cards.findViewHolderForAdapterPosition(tiles.lastFocused)?.itemView }
        }

        fun bind(r: PageRow) {
            row = r
            label.text = r.title
            label.visibility = if (r.title.isEmpty()) View.GONE else View.VISIBLE
            tiles.submit(r)
        }

        /** The same row with some tiles changed: just those update and the rest slide, focus kept. */
        fun update(r: PageRow) {
            row = r
            label.text = r.title
            tiles.update(r, cards)
        }

        fun focus(index: Int) {
            cards.scrollToPosition(index)
            cards.post { cards.findViewHolderForAdapterPosition(index)?.itemView?.requestFocus() }
        }

        inner class TilesAdapter : RecyclerView.Adapter<TileHolder>() {
            private var r: PageRow? = null
            var lastFocused = 0

            fun submit(new: PageRow) {
                r = new
                lastFocused = 0
                notifyDataSetChanged()
            }

            fun update(new: PageRow, list: RecyclerView) {
                val old = r ?: return submit(new)
                val keep = old.tiles.getOrNull(lastFocused)?.id
                InPlace.update(list, this, old.tiles, new.tiles, { it.id }) { r = new }
                lastFocused = new.tiles.indexOfFirst { it.id == keep }.takeIf { it >= 0 }
                    ?: lastFocused.coerceAtMost(itemCount - 1).coerceAtLeast(0)
            }

            override fun getItemCount() = r?.tiles?.size ?: 0

            override fun getItemViewType(position: Int) = when (r?.tiles?.getOrNull(position)) {
                is Tile.Ch -> CHANNEL
                is Tile.Every -> EVERY_PANEL
                else -> MORE
            }

            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = TileHolder(when (viewType) {
                CHANNEL -> Live.inflate(parent)
                EVERY_PANEL -> LayoutInflater.from(parent.context).inflate(R.layout.card_every, parent, false).also {
                    // Across the page, inside its margins.
                    val dp = resources.displayMetrics.density
                    it.layoutParams = RecyclerView.LayoutParams(resources.displayMetrics.widthPixels - (96 * dp).toInt(), (136 * dp).toInt())
                    it.findViewById<View>(R.id.channelTile).clipToOutline = true
                }
                else -> LayoutInflater.from(parent.context).inflate(R.layout.card_more, parent, false).also {
                    it.findViewById<View>(R.id.channelTile).clipToOutline = true
                }
            })

            override fun onBindViewHolder(holder: TileHolder, position: Int) {
                val rr = r ?: return
                holder.bind(rr, rr.tiles[position])
            }
        }

        inner class TileHolder(view: View) : RecyclerView.ViewHolder(view) {
            private var tile: Tile? = null
            private var r: PageRow? = null
            /** Search every channel's two lines of logos drifting (only while it's on the page). */
            private var drift: List<android.animation.ValueAnimator> = emptyList()
            private var driftLogos: List<String>? = null

            init {
                view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                    override fun onViewAttachedToWindow(v: View) = drift.forEach { if (!it.isStarted) it.start() }
                    override fun onViewDetachedFromWindow(v: View) = drift.forEach { it.cancel() }
                })
                view.setOnFocusChangeListener { v, focused ->
                    val every = tile is Tile.Every
                    Motion.focus(v, focused, if (every) 1.03f else 1.1f)
                    if (every) v.findViewById<View>(R.id.everyWall).animate().alpha(if (focused) 0.4f else 0.2f).setDuration(300).start()
                    v.findViewById<TextView>(R.id.channelName).setTextColor(getColor(if (focused) R.color.text else R.color.muted))
                    label.setTextColor(getColor(if (focused) R.color.text else R.color.muted))
                    if (!focused) return@setOnFocusChangeListener
                    tiles.lastFocused = bindingAdapterPosition
                    val t = tile
                    focusKey = r?.key?.let { k -> k to (t?.id ?: "") }
                    if (t is Tile.Ch) hero(t.ch) else if (t != null) heroAbout(t)
                }
                view.setOnClickListener {
                    val rr = r ?: return@setOnClickListener
                    when (val t = tile) {
                        is Tile.Ch -> rr.row?.let { open(it, t.ch) }
                        is Tile.All -> if (t.row.isOwnRow) browseRow(t.row) else browse(t.row.kind)
                        is Tile.Kind -> browse(t.kind)
                        is Tile.Every -> searchAll()
                        null -> {}
                    }
                }
                view.setOnLongClickListener { v ->
                    val t = tile as? Tile.Ch ?: return@setOnLongClickListener false
                    Live.myChannelsSheet(this@LiveActivity, v, t.ch) { toggleFavourite(t.ch) }
                    true
                }
            }

            fun bind(row: PageRow, t: Tile) {
                r = row
                tile = t
                when (t) {
                    is Tile.Ch -> Live.bind(itemView, t.ch)
                    is Tile.Every -> bindEvery(t)
                    else -> bindMore(itemView, t)
                }
            }

            private fun bindEvery(t: Tile.Every) {
                itemView.findViewById<TextView>(R.id.everyBig).text = "Search ${"%,d".format(t.count)} ${if (t.count == 1) "channel" else "channels"}"
                if (driftLogos == t.logos) return
                driftLogos = t.logos
                drift.forEach { it.cancel() }
                val dp = resources.displayMetrics.density
                val wall = itemView.findViewById<View>(R.id.everyWall)
                wall.visibility = if (t.logos.isEmpty()) View.GONE else View.VISIBLE
                val step = (96 * dp)                  // a logo and the gap after it
                drift = listOf(R.id.everyLine1, R.id.everyLine2).mapIndexed { n, id ->
                    val line = itemView.findViewById<LinearLayout>(id)
                    line.removeAllViews()
                    if (t.logos.isEmpty()) return@mapIndexed null
                    // A screen's worth of logos, twice over, so it can drift round without a seam.
                    repeat(2 * PER_LINE) { i ->
                        line.addView(ImageView(this@LiveActivity).apply {
                            setBackgroundResource(R.drawable.channel_card_bg)
                            setPadding((10 * dp).toInt(), (8 * dp).toInt(), (10 * dp).toInt(), (8 * dp).toInt())
                            scaleType = ImageView.ScaleType.FIT_CENTER
                            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                            load(t.logos[(i % PER_LINE + n * 7) % t.logos.size])
                        }, LinearLayout.LayoutParams((84 * dp).toInt(), ViewGroup.LayoutParams.MATCH_PARENT).apply { marginEnd = (12 * dp).toInt() })
                    }
                    val span = step * PER_LINE
                    android.animation.ValueAnimator.ofFloat(0f, 1f).apply {
                        duration = DRIFT_MS
                        repeatCount = android.animation.ValueAnimator.INFINITE
                        interpolator = android.view.animation.LinearInterpolator()
                        // The first line drifts left, the second right.
                        addUpdateListener { a -> line.translationX = if (n == 0) -span * a.animatedFraction else -span * (1 - a.animatedFraction) }
                    }
                }.filterNotNull()
                if (itemView.isAttachedToWindow) drift.forEach { it.start() }
            }
        }
    }

    /** A tile that isn't a channel (card_more.xml): a row's Browse all, or a kind in More to explore. */
    private fun bindMore(v: View, t: Tile) {
        val big = v.findViewById<TextView>(R.id.moreBig)
        val small = v.findViewById<TextView>(R.id.moreSmall)
        val icon = v.findViewById<ImageView>(R.id.moreIcon)
        val name = v.findViewById<TextView>(R.id.channelName)
        val sub = v.findViewById<TextView>(R.id.channelSub)
        val tint = v.findViewById<View>(R.id.moreTint)
        fun channels(n: Int) = "${"%,d".format(n)} ${if (n == 1) "channel" else "channels"}"
        // A kind past the rows: six of its logos (a short row's again, to fill it), dimmed behind.
        // (A row's Browse all has none: the row's own channels are right before it.)
        val logos = (t as? Tile.Kind)?.logos.orEmpty()
        val mosaic = v.findViewById<android.widget.GridLayout>(R.id.moreMosaic)
        mosaic.visibility = if (logos.isEmpty()) View.GONE else View.VISIBLE
        for (i in 0 until mosaic.childCount) {
            val img = mosaic.getChildAt(i) as ImageView
            img.dispose()
            img.setImageDrawable(null)
            if (logos.isNotEmpty()) img.load(logos[i % logos.size])
        }
        v.findViewById<View>(R.id.moreShade).visibility = mosaic.visibility
        icon.visibility = View.GONE
        big.visibility = View.VISIBLE
        when (t) {
            is Tile.All -> {
                big.text = "%,d".format(t.count)
                big.textSize = 28f
                small.text = if (t.count == 1) "channel" else "channels"
                name.text = "Browse all"
                sub.text = t.row.title
                Live.glow(tint, 220, 0x40, 150f)
            }
            is Tile.Kind -> {
                big.text = t.name
                big.textSize = 21f
                small.text = channels(t.count)
                name.text = ""
                sub.text = ""
                Live.glow(tint, hueOf(t.kind), if (logos.isEmpty()) 0x6E else 0x38, 150f)
            }
            is Tile.Ch, is Tile.Every -> {}
        }
        name.visibility = if (name.text.isEmpty()) View.GONE else View.VISIBLE
        sub.visibility = if (sub.text.isEmpty()) View.GONE else View.VISIBLE
    }

    /** A kind's own tint, the same each time (as the web app's). */
    private fun hueOf(id: String): Int = id.fold(0) { h, c -> (h * 31 + c.code) % 360 }

    companion object {
        private const val TAG = "Nightcap"
        const val MINE = "mine"
        private const val PREVIEW_AFTER_MS = 2_500L
        /** A first load that failed: asked again after this. */
        private const val RELOAD_MS = 10_000L
        private const val EMPTY_TINT = 0xFF2E3F7A.toInt()
        private const val HOME_TINT = 0xFF4A3A78.toInt()
        private val DPAD_KEYS = setOf(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER)
        private const val UPDATE = "update"
        private const val EXPLORE = "explore"
        private const val CHANNEL = 0
        private const val MORE = 1
        private const val EVERY_PANEL = 2
        private const val EVERY = "every"
        /** Logos on each of Search every channel's drifting lines (about a screen's width). */
        private const val PER_LINE = 12
        private const val DRIFT_MS = 90_000L
        /** Kinds shown as rows of their own; the rest are tiles in More to explore. */
        private const val KIND_ROWS = 6

        fun intent(context: Context) = Intent(context, LiveActivity::class.java)

        /** A player for live streams: HLS when the server says so, and redirects followed from the
         *  server's playback link (https) to the channel's own address (often http). */
        @OptIn(UnstableApi::class)
        fun player(context: Context): ExoPlayer {
            val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(10_000).setReadTimeoutMs(15_000)
            return ExoPlayer.Builder(context)
                .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http)))
                .build()
        }

        fun item(url: String, hls: Boolean): MediaItem =
            MediaItem.Builder().setUri(url).apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()

        /** Puts [stream] into [player], ready to prepare. An ordinary stream plays directly; one with
         *  a recipe goes through [LiveStreams] (its handler, or none). Returns false when nothing here
         *  can play it (no handler for a recipe stream): the caller moves on to the next stream. */
        @OptIn(UnstableApi::class)
        fun setStream(player: ExoPlayer, context: Context, stream: LiveStream, asProgressive: Boolean = false): Boolean {
            if (stream.recipe != null) {
                val source: MediaSource = LiveStreams.handler?.source(context, stream.url, stream.recipe) ?: return false
                player.setMediaSource(source)
            } else {
                player.setMediaItem(item(stream.url, stream.hls && !asProgressive))
            }
            return true
        }
    }
}
