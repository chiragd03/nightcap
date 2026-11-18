package local.nightcap

import android.app.Activity
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView

/**
 * A short glass note in the top-right corner ("Marked as watched"), in place of Android's toasts.
 * A screen that's closing can leave one for the next screen with [later].
 */
object Notice {
    private var pending: String? = null

    fun show(activity: Activity, text: String) {
        val root = activity.findViewById<FrameLayout>(android.R.id.content)
        val dp = activity.resources.displayMetrics.density
        val note = (root.findViewWithTag<TextView>(TAG) ?: TextView(activity).apply {
            tag = TAG
            setBackgroundResource(R.drawable.dialog_glass)
            setTextColor(activity.getColor(R.color.text))
            textSize = 10f
            fontVariationSettings = "'wght' 500"
            setPadding((14 * dp).toInt(), (8 * dp).toInt(), (14 * dp).toInt(), (8 * dp).toInt())
            elevation = 20 * dp
            alpha = 0f
            root.addView(this, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.END).apply { topMargin = (22 * dp).toInt(); rightMargin = (28 * dp).toInt() })
        })
        note.text = text
        note.visibility = View.VISIBLE
        note.animate().cancel()
        note.translationY = -6 * dp
        note.animate().alpha(1f).translationY(0f).setDuration(200).withEndAction {
            note.animate().alpha(0f).setStartDelay(2_400).setDuration(400).start()
        }.start()
    }

    /** Shown by the next screen that appears (for screens that close straight after). */
    fun later(text: String) {
        pending = text
    }

    fun showPending(activity: Activity) {
        pending?.let { pending = null; show(activity, it) }
    }

    private const val TAG = "nightcap-notice"
}
