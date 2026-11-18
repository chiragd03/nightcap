package local.nightcap

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Outline
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Window
import android.util.AttributeSet
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.ViewTreeObserver
import android.view.animation.OvershootInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The side panel: invisible until Left is pressed from the first card of a row, then a
 * floating frosted-glass card springs in. Right or Back closes it.
 *
 * The glass is a small blurred copy of the screen taken as the panel opens, so it costs
 * almost nothing per frame (blurring live video every frame would be too much for the TV).
 * The copy comes from the screen itself (PixelCopy), which also captures posters held on the
 * GPU and the playing trailer.
 */
class NavRail(context: Context, attrs: AttributeSet?) : FrameLayout(context, attrs) {

    /** One panel entry: a thin line icon and a label. */
    data class Entry(val id: String, val icon: Int, val label: String)

    private val dp = resources.displayMetrics.density
    private val shade = View(context).apply {
        setBackgroundResource(R.drawable.nav_shade)
        alpha = 0f
    }
    private val card = FrameLayout(context).apply {
        alpha = 0f
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) =
                outline.setRoundRect(0, 0, view.width, view.height, 28 * dp)
        }
        clipToOutline = true
        elevation = 24 * dp
    }
    private val glass = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_XY }
    private val column = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.TOP
        setPadding((10 * dp).toInt(), (22 * dp).toInt(), (10 * dp).toInt(), (20 * dp).toInt())
    }
    private val items = mutableMapOf<String, View>()
    private var selected = ""
    private var open = false
    private var onExit: () -> Unit = {}

    /** Told when the panel opens or closes, so the screen behind can step back. */
    var onOpenChanged: (Boolean) -> Unit = {}

    /** The window whose picture the glass blurs. */
    var window: Window? = null

    private val spring = OvershootInterpolator(0.9f)
    private val easeIn = PathInterpolator(0.4f, 0f, 1f, 1f)

    private val focusWatcher = ViewTreeObserver.OnGlobalFocusChangeListener { _, now ->
        val inside = now != null && isDescendant(now)
        if (inside && !open) setOpen(true) else if (!inside && open) setOpen(false)
    }

    init {
        addView(shade, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        card.addView(glass, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        card.addView(View(context).apply { setBackgroundResource(R.drawable.glass_edge) },
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        card.addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(card, LayoutParams((196 * dp).toInt(), LayoutParams.MATCH_PARENT).apply {
            setMargins((20 * dp).toInt(), (24 * dp).toInt(), 0, (24 * dp).toInt())
        })
        card.translationX = -28 * dp
        card.scaleX = 0.94f
        card.scaleY = 0.94f
    }

    private var profileItem: View? = null

    fun setup(
        entries: List<Entry>, selectedId: String, onProfile: () -> Unit, onPick: (String) -> Unit, onExit: () -> Unit,
    ) {
        this.onExit = onExit
        selected = selectedId
        column.removeAllViews()
        items.clear()
        val inflater = LayoutInflater.from(context)
        // Who's watching sits on top, like Apple TV.
        val profile = inflater.inflate(R.layout.nav_profile, column, false)
        profile.setOnClickListener { onProfile() }
        column.addView(profile)
        profileItem = profile
        showProfile()
        entries.forEach { e ->
            val item = inflater.inflate(R.layout.nav_item, column, false)
            item.findViewById<ImageView>(R.id.navIcon).setImageResource(e.icon)
            item.findViewById<TextView>(R.id.navLabel).text = e.label
            item.setOnClickListener { onPick(e.id) }
            column.addView(item)
            items[e.id] = item
        }
    }

    /** Which entry is this screen's now (Home's Shows and Movies pages share its screen). */
    fun select(id: String) {
        selected = id
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        viewTreeObserver.addOnGlobalFocusChangeListener(focusWatcher)
    }

    override fun onDetachedFromWindow() {
        viewTreeObserver.removeOnGlobalFocusChangeListener(focusWatcher)
        super.onDetachedFromWindow()
    }

    /** Closed, the panel offers nothing to focus; the screen opens it with [enter]. */
    override fun addFocusables(views: ArrayList<View>, direction: Int, focusableMode: Int) {
        if (hasFocus()) super.addFocusables(views, direction, focusableMode)
    }

    /** Open, focus stays in the panel: only Right (or Back) leaves it. Otherwise Left (or Up/Down at
     *  its ends) would find a card scrolled off the screen's left edge, in whichever row was left last. */
    override fun focusSearch(focused: View?, direction: Int): View? {
        // Up and Down go between the panel's own entries only: searched over the whole screen, a card
        // behind the panel at the same height (a Live TV row, say) can be "nearer" than the entry above,
        // and focus would stay put.
        if (focused != null && hasFocus() && (direction == View.FOCUS_UP || direction == View.FOCUS_DOWN))
            return android.view.FocusFinder.getInstance().findNextFocus(column, focused, direction) ?: focused
        val found = super.focusSearch(focused, direction)
        return if (focused != null && hasFocus() && (found == null || !isDescendant(found))) focused else found
    }

    /** Opens the panel on the current page's entry. */
    fun enter() {
        items[selected]?.requestFocus()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (hasFocus() && event.action == KeyEvent.ACTION_DOWN &&
            (event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT || event.keyCode == KeyEvent.KEYCODE_BACK)
        ) {
            onExit()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** The profile in use (it may have changed on another screen since this one was made). */
    private fun showProfile() {
        val v = profileItem ?: return
        val p = Profiles.current()
        v.visibility = if (p == null) View.GONE else View.VISIBLE
        p ?: return
        v.findViewById<ImageView>(R.id.avatar).setImageResource(p.picture.image)
        ((v.findViewById<View>(R.id.avatarDisc).background.mutate() as android.graphics.drawable.LayerDrawable)
            .getDrawable(0) as android.graphics.drawable.GradientDrawable).setColor(p.picture.tint)
        v.findViewById<TextView>(R.id.profileName).text = p.name
    }

    private fun setOpen(value: Boolean) {
        open = value
        if (value) showProfile()
        // Copy the screen before the card starts to appear, so it isn't in its own glass.
        if (value) frost()
        shade.animate().alpha(if (value) 1f else 0f).setDuration(if (value) 280 else 180).start()
        card.animate().cancel()
        if (value) {
            card.animate().alpha(1f).translationX(0f).scaleX(1f).scaleY(1f)
                .setDuration(380).setInterpolator(spring).start()
        } else {
            card.animate().alpha(0f).translationX(-28 * dp).scaleX(0.94f).scaleY(0.94f)
                .setDuration(180).setInterpolator(easeIn).start()
        }
        onOpenChanged(value)
    }

    /** Copies the screen area under the card at quarter size and blurs it into the glass. */
    private fun frost() {
        val w = window ?: return
        if (card.width == 0 || card.height == 0) return
        val at = IntArray(2).also { card.getLocationInWindow(it) }
        // The card is shifted while closed; copy where it will sit once open.
        val left = (at[0] - card.translationX).toInt().coerceAtLeast(0)
        val area = Rect(left, at[1], left + card.width, at[1] + card.height)
        val bitmap = Bitmap.createBitmap(card.width / 4, card.height / 4, Bitmap.Config.ARGB_8888)
        runCatching {
            PixelCopy.request(w, area, bitmap, { result ->
                if (result != PixelCopy.SUCCESS || !Blur.supported) return@request
                glass.setImageBitmap(bitmap)
                Blur.set(glass, 18 * dp)
            }, Handler(Looper.getMainLooper()))
        }  // No copy: the card keeps its plain tint, which still reads fine.
    }

    private fun isDescendant(view: View): Boolean {
        var v: View? = view
        while (v != null) {
            if (v === this) return true
            v = v.parent as? ViewGroup
        }
        return false
    }
}
