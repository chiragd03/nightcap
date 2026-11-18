package local.nightcap

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.LinearLayout

/**
 * A row that remembers its last focused card: moving Up or Down into the row lands
 * there instead of on whichever card happens to sit closest on screen.
 */
class RowLayout(context: Context, attrs: AttributeSet?) : LinearLayout(context, attrs) {
    var remembered: (() -> View?)? = null

    override fun addFocusables(views: ArrayList<View>, direction: Int, focusableMode: Int) {
        if (!hasFocus() && (direction == FOCUS_UP || direction == FOCUS_DOWN)) {
            val target = remembered?.invoke()
            if (target != null && target.isAttachedToWindow && target.isFocusable) {
                views.add(target)
                return
            }
        }
        super.addFocusables(views, direction, focusableMode)
    }
}
