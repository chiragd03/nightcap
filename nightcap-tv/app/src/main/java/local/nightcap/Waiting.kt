package local.nightcap

import android.animation.Animator
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.view.View

/**
 * Nightcap's one way of saying "working on it": the line that says what's under way ("Loading Live
 * TV…", "Searching…", "Setting up your home screen…") breathes gently until it's done. Every screen
 * that makes someone wait uses it, so waiting looks and feels the same everywhere; a message that
 * isn't about waiting (an error, "No channels here") stays still.
 */
object Waiting {
    fun on(view: View) {
        if (view.getTag(R.id.tag_waiting) != null) return
        val pulse = ObjectAnimator.ofFloat(view, View.ALPHA, 1f, 0.4f).apply {
            duration = 1100
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = Motion.ease
            start()
        }
        view.setTag(R.id.tag_waiting, pulse)
    }

    fun off(view: View) {
        (view.getTag(R.id.tag_waiting) as? Animator)?.cancel()
        view.setTag(R.id.tag_waiting, null)
        view.alpha = 1f
    }

    /** [on] or [off] as [waiting] says. */
    fun set(view: View, waiting: Boolean) = if (waiting) on(view) else off(view)
}
