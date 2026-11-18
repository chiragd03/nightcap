package local.nightcap

import android.content.Context
import android.graphics.Rect
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.View
import android.widget.HorizontalScrollView

/**
 * A row of tiles that scrolls only when they don't fit: it glides just far enough to keep the
 * focused tile inside the page's margin ([margin], also the row's own padding at its ends), and
 * stays put when Left or Right finds no further tile (a plain HorizontalScrollView jumps to its
 * very edge then).
 */
class TileRow @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : HorizontalScrollView(context, attrs) {
    private val margin = 72 * resources.displayMetrics.density

    init {
        isHorizontalScrollBarEnabled = false
        overScrollMode = OVER_SCROLL_NEVER
        isSmoothScrollingEnabled = true
    }

    /** Left and Right move the focus (the window does that), never the row by itself. */
    override fun executeKeyEvent(event: KeyEvent) = false

    /** The row's own jump to the focused tile: none; [requestChildFocus] glides instead. */
    override fun computeScrollDeltaToGetChildRectOnScreen(rect: Rect?) = 0

    override fun requestChildFocus(child: View?, focused: View?) {
        super.requestChildFocus(child, focused)
        val tile = focused ?: return
        if (isLaidOut) glideTo(tile) else post { glideTo(tile) }
    }

    private fun glideTo(tile: View) {
        val r = Rect()
        tile.getDrawingRect(r)
        offsetDescendantRectToMyCoords(tile, r)
        val left = scrollX + margin
        val right = scrollX + width - margin
        val delta = when {
            r.left < left -> r.left - left
            r.right > right -> r.right - right
            else -> 0f
        }
        val most = ((getChildAt(0)?.width ?: 0) - width).coerceAtLeast(0)
        val target = (scrollX + delta).toInt().coerceIn(0, most)
        if (target != scrollX) smoothScrollTo(target, 0)
    }
}
