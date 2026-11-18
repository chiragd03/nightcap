package local.nightcap

import android.content.Context
import android.graphics.Rect
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.dispose
import coil.load

typealias OnItem = (row: Row, item: Item) -> Unit

/**
 * "+N" with the plus raised to the middle of the digits (fonts sit "+" at x-height, which
 * looks low next to numbers).
 */
fun plusBadge(n: Int): CharSequence = android.text.SpannableString("+$n").apply {
    setSpan(object : android.text.style.MetricAffectingSpan() {
        override fun updateDrawState(tp: android.text.TextPaint) = raise(tp)
        override fun updateMeasureState(tp: android.text.TextPaint) = raise(tp)
        private fun raise(tp: android.text.TextPaint) {
            tp.baselineShift -= (tp.textSize * 0.1f).toInt()
        }
    }, 0, 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
}

/** Rows leaving the top fade out as they slide up, fully gone once half of the row has passed. */
fun RecyclerView.fadeRowsAbove() {
    for (i in 0 until childCount) {
        val row = getChildAt(i)
        val above = (paddingTop - row.top).coerceAtLeast(0)
        row.alpha = (1f - above / (row.height * 0.5f)).coerceIn(0f, 1f)
    }
}

/** Vertical list that snaps the focused row to the top of the list instead of the nearest edge. */
class TopAlignLayoutManager(context: Context) : LinearLayoutManager(context, VERTICAL, false) {
    private val ease = DecelerateInterpolator()

    // Keep rows that scrolled off the top attached, so pressing Up has somewhere to go, and a screen of
    // them ready below, so moving down shows rows already made (with only half a screen, rows were still
    // being filled in while they slid in, and scrolling was jerkier).
    override fun calculateExtraLayoutSpace(state: RecyclerView.State, extraLayoutSpace: IntArray) {
        extraLayoutSpace[0] = height
        extraLayoutSpace[1] = height
    }

    override fun requestChildRectangleOnScreen(
        parent: RecyclerView, child: View, rect: Rect, immediate: Boolean, focusedChildVisible: Boolean,
    ): Boolean {
        val dy = child.top - parent.paddingTop
        if (dy == 0) return false
        if (immediate) parent.scrollBy(0, dy) else parent.smoothScrollBy(0, dy, Motion.ease, 340)
        return true
    }
}

// Spare cards kept for reuse (see RowsAdapter.posterPool): about three screens of rows' worth.
private const val SPARE_POSTERS = 120
private const val SPARE_RANKED = 30
// How long Home must have been still (no key, no scrolling) before a spare card is made.
private const val STILL_FOR_MS = 500L

class RowsAdapter(
    private val onFocus: OnItem,
    private val onClick: OnItem,
    private val onLongPress: OnItem? = null,
    /** Left on the first featured title (opens the side menu on Home). */
    private val onFeaturedStart: () -> Unit = {},
    /** True while the hero is busy (a trailer playing): the carousel waits for it. */
    private val heroBusy: () -> Boolean = { false },
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    var rows: List<Row> = emptyList()
        private set
    /** Cards, shared by every row (any row can use any spare one), with room for a screenful of rows'
     *  worth of each kind, so scrolling to new rows reuses cards rather than making them. */
    private val posterPool = RecyclerView.RecycledViewPool().apply {
        setMaxRecycledViews(CardsAdapter.POSTER, SPARE_POSTERS)
        setMaxRecycledViews(CardsAdapter.RANKED, SPARE_RANKED)
        setMaxRecycledViews(CardsAdapter.TILE, 20)
        setMaxRecycledViews(CardsAdapter.APP, 20)
    }

    /** Makes spare cards while the TV has nothing else to do (a few at a time), so the first scroll
     *  through Home doesn't have to make them as rows come into view: making them then is what froze
     *  it. [parent]: where they'll be shown (for their layout). */
    fun warmCards(parent: RecyclerView, lastKeyAt: () -> Long) {
        val maker = CardsAdapter({ _, _ -> }, {})
        val wanted = listOf(CardsAdapter.POSTER to SPARE_POSTERS, CardsAdapter.RANKED to SPARE_RANKED)
        android.os.Looper.myQueue().addIdleHandler {
            val next = wanted.firstOrNull { (type, most) -> posterPool.getRecycledViewCount(type) < most } ?: return@addIdleHandler false
            // One at a time, and only while Home is still: never in the way of someone moving around.
            val still = parent.scrollState == RecyclerView.SCROLL_STATE_IDLE &&
                android.os.SystemClock.uptimeMillis() - lastKeyAt() > STILL_FOR_MS
            if (still) posterPool.putRecycledView(maker.createViewHolder(parent, next.first))
            else parent.postDelayed({}, STILL_FOR_MS)  // (a nudge, so it's asked again once Home is still)
            true
        }
    }

    fun submit(newRows: List<Row>) {
        rows = newRows
        notifyDataSetChanged()
    }

    /** Adds, replaces or removes one row without disturbing the others (or the focus in them). */
    fun setRow(id: String, row: Row?, at: Int) {
        val index = rows.indexOfFirst { it.id == id }
        when {
            index >= 0 && row != null -> updateRow(index, row)
            index >= 0 -> { rows = rows.filterIndexed { i, _ -> i != index }; notifyItemRemoved(index) }
            row != null -> {
                val pos = at.coerceIn(0, rows.size)
                rows = rows.toMutableList().also { it.add(pos, row) }
                notifyItemInserted(pos)
            }
        }
    }

    /** Replaces a row's cards in place: only changed cards update, moves slide (see InPlace). */
    private fun updateRow(index: Int, row: Row) {
        if (rows[index] == row) return
        rows = rows.toMutableList().also { it[index] = row }
        notifyItemChanged(index, UPDATE)
    }

    /**
     * Applies a fresh Home in place when it has the same rows in the same order (the usual case
     * after a change): only rows that differ update, without a redraw. False if the rows differ.
     */
    fun applyInPlace(newRows: List<Row>): Boolean {
        if (newRows.map { it.id } != rows.map { it.id }) return false
        newRows.forEachIndexed { i, row -> updateRow(i, row) }
        return true
    }

    /**
     * Applies a fresh Home whose rows up to [upTo] are the same as now (in the same order): those
     * update in place, and the rows below are replaced, so nothing above [upTo] moves. False if
     * the rows up to [upTo] differ.
     */
    fun applyBelow(newRows: List<Row>, upTo: Int): Boolean {
        if (upTo >= newRows.size || newRows.take(upTo + 1).map { it.id } != rows.take(upTo + 1).map { it.id }) return false
        (0..upTo).forEach { updateRow(it, newRows[it]) }
        val oldTail = rows.size - (upTo + 1)
        val newTail = newRows.size - (upTo + 1)
        rows = newRows
        if (oldTail > 0) notifyItemRangeRemoved(upTo + 1, oldTail)
        if (newTail > 0) notifyItemRangeInserted(upTo + 1, newTail)
        return true
    }

    override fun getItemCount() = rows.size

    override fun getItemViewType(position: Int) = if (rows[position].style == "featured") FEATURED_ROW else CARDS_ROW

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        if (viewType == FEATURED_ROW) return FeaturedHolder(inflater.inflate(R.layout.row_featured, parent, false))
        return RowHolder(inflater.inflate(R.layout.row, parent, false) as RowLayout)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) = when (holder) {
        is FeaturedHolder -> holder.bind(rows[position])
        else -> (holder as RowHolder).bind(rows[position])
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
        if (UPDATE in payloads && holder is RowHolder) holder.update(rows[position])
        else onBindViewHolder(holder, position)
    }

    override fun onViewDetachedFromWindow(holder: RecyclerView.ViewHolder) {
        (holder as? FeaturedHolder)?.stop()
    }

    /**
     * The featured carousel: the title fills the backdrop and details above, this row is just its
     * page dots. It moves on by itself (after any trailer finishes); Left/Right flip through it.
     */
    inner class FeaturedHolder(view: View) : RecyclerView.ViewHolder(view) {
        val dots: android.widget.LinearLayout = view.findViewById(R.id.featuredDots)
        private var row: Row? = null
        private var index = 0
        private var shownAt = 0L
        private val tick = object : Runnable {
            override fun run() {
                val waited = android.os.SystemClock.elapsedRealtime() - shownAt
                // (Only while Home is in front: behind the player it doesn't move on.)
                if (dots.hasWindowFocus() && (waited > MAX_STAY_MS || (waited > STAY_MS && !heroBusy()))) move(1)
                dots.postDelayed(this, 1_000)
            }
        }

        init {
            dots.setOnFocusChangeListener { _, focused ->
                drawDots()
                if (focused) {
                    show()
                    dots.removeCallbacks(tick)
                    dots.postDelayed(tick, 1_000)
                } else stop()
            }
            dots.setOnClickListener { row?.let { r -> onClick(r, r.items[index]) } }
            dots.setOnKeyListener { _, code, e ->
                if (e.action != android.view.KeyEvent.ACTION_DOWN) return@setOnKeyListener false
                when (code) {
                    android.view.KeyEvent.KEYCODE_DPAD_RIGHT -> true.also { move(1) }
                    android.view.KeyEvent.KEYCODE_DPAD_LEFT -> true.also { if (index == 0) onFeaturedStart() else move(-1) }
                    else -> false
                }
            }
        }

        fun bind(r: Row) {
            val before = row?.items?.getOrNull(index)?.id
            row = r
            index = index.coerceAtMost(r.items.size - 1).coerceAtLeast(0)
            drawDots()
            // (New titles under the dot being looked at: the title shown is the one OK opens. The same
            // title keeps its time on screen; its details are brought up to date.)
            if (dots.hasFocus()) r.items.getOrNull(index)?.let { if (it.id != before) show() else onFocus(r, it) }
        }

        fun stop() = dots.removeCallbacks(tick)

        private fun move(by: Int) {
            val n = row?.items?.size ?: return
            index = (index + by + n) % n
            drawDots()
            show()
        }

        private fun show() {
            val r = row ?: return
            shownAt = android.os.SystemClock.elapsedRealtime()
            r.items.getOrNull(index)?.let { onFocus(r, it) }
        }

        private fun drawDots() {
            val n = row?.items?.size ?: 0
            val dp = dots.resources.displayMetrics.density
            val focused = dots.hasFocus()
            while (dots.childCount < n) dots.addView(View(dots.context).apply { setBackgroundResource(R.drawable.dot) })
            while (dots.childCount > n) dots.removeViewAt(dots.childCount - 1)
            for (i in 0 until n) {
                val dot = dots.getChildAt(i)
                val current = i == index
                dot.layoutParams = android.widget.LinearLayout.LayoutParams(((if (current) 16 else 5) * dp).toInt(), (5 * dp).toInt())
                    .apply { marginEnd = if (i < n - 1) (5 * dp).toInt() else 0 }
                dot.alpha = when { current && focused -> 1f; current -> 0.7f; focused -> 0.45f; else -> 0.25f }
            }
        }
    }

    inner class RowHolder(view: RowLayout) : RecyclerView.ViewHolder(view) {
        private val title: TextView = view.findViewById(R.id.rowTitle)
        private val cards: RecyclerView = view.findViewById(R.id.cards)
        private var row: Row? = null
        // The row this holder shows, not a lookup by position (positions shift when rows change).
        private val adapter = CardsAdapter(
            onFocus = { item, focused ->
                title.setTextColor(view.context.getColor(if (focused) R.color.text else R.color.muted))
                if (focused) row?.let { onFocus(it, item) }
            },
            onClick = { item -> row?.let { onClick(it, item) } },
            onLongPress = { item -> row?.let { onLongPress?.invoke(it, item) } },
        )

        init {
            cards.layoutManager = AnchorStartLayoutManager(view.context).apply { initialPrefetchItemCount = 8 }
            cards.setRecycledViewPool(posterPool)
            cards.itemAnimator = InPlace.animator()
            cards.adapter = adapter
            view.remembered = { cards.findViewHolderForAdapterPosition(adapter.lastFocused)?.itemView }
        }

        fun bind(row: Row) {
            this.row = row
            title.text = row.title
            adapter.submit(row)
        }

        /** The same row with some cards changed: update just those, keeping scroll and focus. */
        fun update(row: Row) {
            this.row = row
            title.text = row.title
            adapter.update(row, cards)
        }

        /** Focuses the card for [itemId], scrolling the row to it (the first card if it's gone). */
        fun focusItem(itemId: String) {
            val items = row?.items?.takeIf { it.isNotEmpty() } ?: return
            val index = items.indexOfFirst { it.id == itemId }.coerceAtLeast(0)
            cards.scrollToPosition(index)
            cards.post { cards.findViewHolderForAdapterPosition(index)?.itemView?.requestFocus() }
        }
    }
}

private const val UPDATE = "update"
private const val CARDS_ROW = 0
private const val FEATURED_ROW = 1
private const val STAY_MS = 8_000L
private const val MAX_STAY_MS = 45_000L

class CardsAdapter(
    private val onFocus: (Item, Boolean) -> Unit,
    private val onClick: (Item) -> Unit,
    private val onLongPress: (Item) -> Unit = {},
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private var row: Row? = null
    /** Card to return to when focus comes back into this row from above or below. */
    var lastFocused = 0
        private set

    fun submit(newRow: Row) {
        row = newRow
        lastFocused = 0
        notifyDataSetChanged()
    }

    fun update(newRow: Row, list: RecyclerView) {
        val old = row?.items.orEmpty()
        val keep = old.getOrNull(lastFocused)?.id
        InPlace.update(list, this, old, newRow.items, { it.id }) { row = newRow }
        lastFocused = newRow.items.indexOfFirst { it.id == keep }.takeIf { it >= 0 } ?: lastFocused.coerceAtMost(newRow.items.size - 1).coerceAtLeast(0)
    }

    override fun getItemCount() = row?.items?.size ?: 0

    override fun getItemViewType(position: Int) = when {
        row?.id == Apps.ROW_ID -> APP
        row?.style == "ranked" -> RANKED
        row?.style == "tiles" -> TILE
        else -> POSTER
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val layout = when (viewType) {
            APP -> R.layout.card_app; RANKED -> R.layout.card_ranked
            TILE -> R.layout.card_tile; else -> R.layout.card_poster
        }
        val view = LayoutInflater.from(parent.context).inflate(layout, parent, false)
        // A ranked card's number sits outside the poster, so only the poster is rounded.
        val rounded = if (viewType == RANKED) view.findViewById(R.id.posterFrame) else view
        rounded.outlineProvider = ViewOutlineProvider.BACKGROUND
        rounded.clipToOutline = true
        return when (viewType) {
            APP -> AppHolder(view); RANKED -> RankedHolder(view)
            TILE -> TileHolder(view); else -> PosterHolder(view)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) =
        (holder as CardHolder).bind(row!!.items[position])

    abstract inner class CardHolder(view: View) : RecyclerView.ViewHolder(view) {
        protected var item: Item? = null

        /** The row this card is in now: cards are shared between rows (one pool), so not necessarily
         *  the one that made it; its focus and clicks are that row's. */
        private val now get() = bindingAdapter as? CardsAdapter ?: this@CardsAdapter

        init {
            view.setOnFocusChangeListener { v, focused ->
                Motion.focus(v, focused)
                val rowNow = now
                if (focused) rowNow.lastFocused = bindingAdapterPosition
                item?.let { rowNow.onFocus(it, focused) }
            }
            view.setOnClickListener { item?.let(now.onClick) }
            view.setOnLongClickListener { item?.let(now.onLongPress); item != null }
        }

        open fun bind(item: Item) {
            this.item = item
            // (The card being looked at, with new details: the info above the rows follows.)
            if (itemView.isFocused) now.onFocus(item, true)
        }
    }

    inner class PosterHolder(view: View) : CardHolder(view) {
        private val poster: ImageView = view.findViewById(R.id.poster)
        private val badge: TextView = view.findViewById(R.id.badge)
        private val newBadge: TextView = view.findViewById(R.id.newBadge)
        private val track: View = view.findViewById(R.id.progressTrack)
        private val fill: View = view.findViewById(R.id.progressFill)

        init {
            fill.pivotX = 0f
        }

        override fun bind(item: Item) {
            super.bind(item)
            poster.loadPoster(item.poster, itemView.findViewById(R.id.posterName), item.name)
            badge.visibility = if (item.episode != null) View.VISIBLE else View.GONE
            badge.text = item.episode
            val fresh = item.newEpisodes ?: 0
            newBadge.visibility = if (fresh > 0) View.VISIBLE else View.GONE
            newBadge.text = plusBadge(fresh)
            val progress = item.progress
            track.visibility = if (progress != null && progress > 0.01) View.VISIBLE else View.GONE
            fill.scaleX = (progress ?: 0.0).toFloat().coerceIn(0f, 1f)
        }
    }

    inner class RankedHolder(view: View) : CardHolder(view) {
        private val poster: ImageView = view.findViewById(R.id.poster)
        private val rank: TextView = view.findViewById(R.id.rank)

        private val frame: View = view.findViewById(R.id.posterFrame)

        override fun bind(item: Item) {
            super.bind(item)
            poster.loadPoster(item.poster, itemView.findViewById(R.id.posterName), item.name)
            val text = item.rank?.toString().orEmpty()
            rank.text = text
            // The poster covers only the last sliver of the number's actual shape (a tenth of its
            // width, a few dp at most), so narrow "1" and wide "10" both stay readable.
            val dp = rank.resources.displayMetrics.density
            val ink = android.graphics.Rect().also { rank.paint.getTextBounds(text, 0, text.length, it) }
            val overlap = minOf(ink.width() * 0.1f, MAX_OVERLAP_DP * dp)
            val offset = (ink.right - overlap).toInt().coerceAtLeast(0)
            (frame.layoutParams as ViewGroup.MarginLayoutParams).let {
                if (it.marginStart != offset) { it.marginStart = offset; frame.layoutParams = it }
            }
        }
    }

    inner class TileHolder(view: View) : CardHolder(view) {
        private val art: ImageView = view.findViewById(R.id.tileArt)
        private val kind: TextView = view.findViewById(R.id.tileKind)
        private val name: TextView = view.findViewById(R.id.tileName)

        override fun bind(item: Item) {
            super.bind(item)
            name.text = item.name
            kind.text = tileKind(item.id)
            // Its top title's picture; without one (or till it comes), a soft colour of its own.
            art.dispose()
            art.setImageDrawable(null)
            art.background = tileColour(item.id)
            if (!item.backdrop.isNullOrBlank()) art.load(item.backdrop) { crossfade(true) }
        }
    }

    /** What kind of Browse tile it is, by its id ("genre:28", "lang:hi", "top10:IN", "soon"). */
    private fun tileKind(id: String) = when (id.substringBefore(':')) {
        "genre" -> "Genre"; "lang" -> "Language"; "top10" -> "Chart"; "soon" -> "New"; else -> ""
    }

    /** A tile with no picture: a deep colour of its own, the same each time for the same tile. */
    private fun tileColour(id: String): android.graphics.drawable.Drawable {
        val hue = id.fold(0) { h, c -> (h * 31 + c.code) % 360 }.toFloat()
        val deep = android.graphics.Color.HSVToColor(floatArrayOf(hue, 0.55f, 0.32f))
        val deeper = android.graphics.Color.HSVToColor(floatArrayOf((hue + 30) % 360, 0.6f, 0.16f))
        return android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TR_BL, intArrayOf(deep, deeper))
    }

    inner class AppHolder(view: View) : CardHolder(view) {
        private val banner: ImageView = view.findViewById(R.id.banner)
        private val name: TextView = view.findViewById(R.id.appName)

        override fun bind(item: Item) {
            super.bind(item)
            val pm = banner.context.packageManager
            // TV apps ship a 16:9 banner; without one, show the icon with the app's name.
            val bannerArt = if (item.id == Apps.GOOGLE_HOME) null else runCatching { pm.getApplicationBanner(item.id) }.getOrNull()
            val padding = if (bannerArt == null) (banner.resources.displayMetrics.density * 24).toInt() else 0
            banner.setPadding(padding, padding / 2, padding, padding + padding / 2)
            when {
                bannerArt != null -> banner.setImageDrawable(bannerArt)
                item.id == Apps.GOOGLE_HOME -> banner.setImageResource(R.drawable.ic_home)
                else -> banner.setImageDrawable(runCatching { pm.getApplicationIcon(item.id) }.getOrNull())
            }
            name.visibility = if (bannerArt == null) View.VISIBLE else View.GONE
            name.text = item.name
        }
    }

    companion object {
        const val POSTER = 0
        const val APP = 1
        const val RANKED = 3
        const val TILE = 4
        /** The most a Top 10 poster may overlap its number. */
        private const val MAX_OVERLAP_DP = 7
    }
}

/** A card's poster; with none, or one that doesn't load, the title's name on the card instead (a
 *  search result can come from Cinemeta with no picture, and a picture's address can fail). */
fun ImageView.loadPoster(url: String?, name: TextView?, title: String?) {
    name?.text = title
    name?.visibility = View.GONE
    if (url.isNullOrBlank()) {
        // (A recycled card's last poster, still loading, mustn't land on this one.)
        dispose()
        setImageDrawable(null)
        name?.visibility = View.VISIBLE
        return
    }
    load(url) {
        listener(onError = { _, _ -> name?.visibility = View.VISIBLE }, onSuccess = { _, _ -> name?.visibility = View.GONE })
    }
}
