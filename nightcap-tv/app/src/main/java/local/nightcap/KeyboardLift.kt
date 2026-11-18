package local.nightcap

import android.app.Activity
import android.view.View
import android.view.WindowInsets
import android.view.animation.PathInterpolator

/**
 * Keeps a text field above the on-screen keyboard by sliding the part of the screen it's on up,
 * while everything behind stays where it is. (Android's own pan slides the whole window and
 * leaves a black band under it.) The activity is set to adjustResize so the keyboard's height
 * arrives as insets; the window itself is never resized.
 */
object KeyboardLift {
    private val EASE = PathInterpolator(0.2f, 0f, 0f, 1f)

    fun attach(activity: Activity, moving: View, field: View) {
        // (Before Android 11 the keyboard's height doesn't arrive this way: Android's own pan, then.)
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
            activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN)
            return
        }
        activity.window.setDecorFitsSystemWindows(false)
        val root = activity.findViewById<View>(android.R.id.content)
        val gap = 20 * activity.resources.displayMetrics.density
        root.setOnApplyWindowInsetsListener { _, insets ->
            val keyboard = insets.getInsets(WindowInsets.Type.ime()).bottom
            val lift = if (keyboard > 0 && field.isShown) {
                val at = IntArray(2).also(field::getLocationOnScreen)
                // Where the field's bottom would be with nothing lifted.
                val bottom = at[1] - moving.translationY + field.height
                (bottom + gap - (root.height - keyboard)).coerceAtLeast(0f)
            } else 0f
            moving.animate().translationY(-lift).setDuration(260).setInterpolator(EASE).start()
            insets
        }
    }
}
