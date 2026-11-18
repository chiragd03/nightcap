package local.nightcap

import android.content.Context
import android.graphics.Rect
import android.view.View
import android.view.animation.PathInterpolator
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/** Shared motion: spring focus on cards, soft easing for scrolling and text changes. */
object Motion {
    /** Quick start, long soft landing. */
    val ease = PathInterpolator(0.2f, 0f, 0f, 1f)

    // A little bounce, settling fast: lively without wobbling.
    private const val STIFFNESS = 700f
    private const val DAMPING = 0.62f

    /**
     * Apple-style focus: the card springs up in size, lifts on its shadow and catches a sheen
     * of light (if it has a view with id `sheen`); losing focus springs it back down.
     */
    fun focus(view: View, focused: Boolean, scale: Float = 1.12f) {
        val target = if (focused) scale else 1f
        spring(view, R.id.spring_scale_x, DynamicAnimation.SCALE_X).animateToFinalPosition(target)
        spring(view, R.id.spring_scale_y, DynamicAnimation.SCALE_Y).animateToFinalPosition(target)
        val dp = view.resources.displayMetrics.density
        view.animate().translationZ(if (focused) 14 * dp else 0f).setDuration(260).setInterpolator(ease).start()
        view.findViewById<View>(R.id.sheen)?.animate()?.alpha(if (focused) 1f else 0f)?.setDuration(260)?.start()
    }

    /** Fades fresh text in with a small rise, so details don't snap when focus moves. */
    fun refresh(view: View) {
        view.animate().cancel()
        view.alpha = 0.3f
        view.translationY = 5 * view.resources.displayMetrics.density
        view.animate().alpha(1f).translationY(0f).setDuration(240).setInterpolator(ease).start()
    }

    private fun spring(view: View, tag: Int, property: DynamicAnimation.ViewProperty): SpringAnimation =
        (view.getTag(tag) as? SpringAnimation) ?: SpringAnimation(view, property).apply {
            spring = SpringForce(1f).setStiffness(STIFFNESS).setDampingRatio(DAMPING)
            view.setTag(tag, this)
        }
}

/** Position of a focused card in its horizontal row and the row's size, or null if not in one. */
private fun View.rowPosition(): Pair<Int, Int>? {
    val row = parent as? RecyclerView ?: return null
    if ((row.layoutManager as? LinearLayoutManager)?.orientation != LinearLayoutManager.HORIZONTAL) return null
    return row.getChildAdapterPosition(this) to (row.adapter?.itemCount ?: 0)
}

/**
 * Keeps Left/Right inside a row: at either end they stop instead of jumping to another row.
 * Returns true when the key was handled (or swallowed).
 */
fun rowEdgeKey(focus: View?, event: android.view.KeyEvent, onStartLeft: () -> Unit = {}): Boolean {
    if (focus == null || event.action != android.view.KeyEvent.ACTION_DOWN) return false
    val (pos, count) = focus.rowPosition() ?: return false
    return when {
        event.keyCode == android.view.KeyEvent.KEYCODE_DPAD_RIGHT && pos == count - 1 -> true
        event.keyCode == android.view.KeyEvent.KEYCODE_DPAD_LEFT && pos == 0 -> { onStartLeft(); true }
        else -> false
    }
}

/**
 * Horizontal row that keeps the focused card anchored at the row's start: the row slides
 * under it, like Netflix and Google TV, instead of focus wandering across the screen.
 */
class AnchorStartLayoutManager(context: Context) : LinearLayoutManager(context, HORIZONTAL, false) {
    override fun requestChildRectangleOnScreen(
        parent: RecyclerView, child: View, rect: Rect, immediate: Boolean, focusedChildVisible: Boolean,
    ): Boolean {
        val dx = child.left - parent.paddingStart
        if (dx == 0) return false
        if (immediate) parent.scrollBy(dx, 0) else parent.smoothScrollBy(dx, 0, Motion.ease, 320)
        return true
    }
}
