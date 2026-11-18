package local.nightcap

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The long-press menu: a frosted glass card in the middle of the screen, like Apple TV's. Up/Down move between actions, OK picks one, Back closes it.
 * It lives in the screen itself (not a system dialog) so its glass can blur what's behind.
 */
object Sheet {
    class Action(val icon: Int, val label: String, val run: () -> Unit)

    /** Whether one is showing: the players let keys through to it then. */
    @Volatile var open = false
        private set

    /** Shows the menu; Back closes it and runs [onCancel]. Returns a way to close it from outside
     *  (nothing more runs then). */
    fun show(activity: Activity, anchor: View?, title: String, subtitle: String?, actions: List<Action>,
             onCancel: () -> Unit = {}): () -> Unit {
        val card = LayoutInflater.from(activity).inflate(R.layout.sheet, null, false)
        card.findViewById<TextView>(R.id.sheetTitle).text = title
        card.findViewById<TextView>(R.id.sheetSubtitle).apply {
            text = subtitle
            visibility = if (subtitle.isNullOrBlank()) View.GONE else View.VISIBLE
        }
        val list = card.findViewById<LinearLayout>(R.id.sheetItems)
        val items = actions.map { action ->
            LayoutInflater.from(activity).inflate(R.layout.sheet_item, list, false).apply {
                findViewById<ImageView>(R.id.sheetIcon).setImageResource(action.icon)
                findViewById<TextView>(R.id.sheetLabel).text = action.label
                list.addView(this)
            } to action.run
        }
        return present(activity, anchor, card, card.findViewById(R.id.sheetGlass), items, widthDp = 250, across = false, onCancel)
    }

    /**
     * Puts [card] (with its [glass] for the blurred copy of what's behind) in the middle of the
     * screen over a dim, with focus kept on its [choices] (each with what it does). [across]: the
     * choices sit side by side (Left/Right move between them) rather than one under another.
     * Back closes it and runs [onCancel]. Returns a way to close it from outside.
     */
    fun present(activity: Activity, anchor: View?, card: View, glass: ImageView, choices: List<Pair<View, () -> Unit>>,
                widthDp: Int, across: Boolean, onCancel: () -> Unit): () -> Unit {
        val root = activity.findViewById<FrameLayout>(android.R.id.content)
        val dp = activity.resources.displayMetrics.density
        val overlay = FrameLayout(activity).apply {
            isClickable = true
            alpha = 0f
            setBackgroundColor(0x59000000)
            // Keep focus inside the card while it's open.
            descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
            isFocusable = true
        }
        card.outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
        card.clipToOutline = true

        var closed = false
        // The screen it was on went away with it still up (a paused film closed as the TV slept): as
        // if Back was pressed, so a question there is answered and nothing waits on it.
        overlay.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) = Unit
            override fun onViewDetachedFromWindow(v: View) {
                if (closed) return
                closed = true
                open = false
                onCancel()
            }
        })
        fun close(then: (() -> Unit)? = null) {
            if (closed) return
            closed = true
            open = false
            overlay.animate().alpha(0f).setDuration(150).withEndAction {
                // Focus back on the card first: removing the menu while it holds focus makes
                // Android hand focus to the first thing on screen, and the rows scroll to it.
                anchor?.takeIf { it.isAttachedToWindow }?.requestFocus()
                root.removeView(overlay)
                then?.invoke()
            }.start()
            card.animate().scaleX(0.96f).scaleY(0.96f).setDuration(150).start()
        }

        val items = choices.map { (view, run) ->
            view.apply {
                setOnClickListener { close(run) }
                setOnKeyListener { _, code, e ->
                    if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
                    when (code) {
                        KeyEvent.KEYCODE_BACK -> true.also { close(onCancel) }
                        // Focus stays in the card.
                        KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> !across
                        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> across
                        else -> false
                    }
                }
            }
        }
        // The first and last choices don't let focus out at the ends.
        items.forEach { it.id = View.generateViewId() }
        if (across) {
            items.first().nextFocusLeftId = items.first().id
            items.last().nextFocusRightId = items.last().id
        } else {
            items.first().nextFocusUpId = items.first().id
            items.last().nextFocusDownId = items.last().id
        }

        // Size the card and sit it in the middle of the screen.
        val width = (widthDp * dp).toInt()
        card.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(root.height, View.MeasureSpec.AT_MOST))
        val height = card.measuredHeight
        val from = IntArray(2).also { root.getLocationInWindow(it) }
        val left = (root.width - width) / 2
        val top = (root.height - height) / 2
        overlay.addView(card, FrameLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START)
            .apply { leftMargin = left; topMargin = top })
        card.pivotX = width / 2f
        card.pivotY = height / 2f

        // Glass: copy the screen where the card will sit, blur it, then show the card over it.
        val bitmap = Bitmap.createBitmap((width / 4).coerceAtLeast(1), (height / 4).coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        val area = Rect(from[0] + left, from[1] + top, from[0] + left + width, from[1] + top + height)
        open = true
        val reveal = {
            root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            card.scaleX = 0.9f
            card.scaleY = 0.9f
            overlay.animate().alpha(1f).setDuration(160).start()
            card.animate().scaleX(1f).scaleY(1f).setDuration(260).setInterpolator(OvershootInterpolator(1.1f)).start()
            items.first().requestFocus()
        }
        runCatching {
            PixelCopy.request(activity.window, area, bitmap, { result ->
                if (result == PixelCopy.SUCCESS && Blur.supported) {
                    glass.setImageBitmap(bitmap)
                    Blur.set(glass, 16 * dp)
                }
                reveal()
            }, Handler(Looper.getMainLooper()))
        }.onFailure { reveal() }
        return { close() }
    }
}
