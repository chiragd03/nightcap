package local.nightcap

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.util.AttributeSet
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import kotlin.math.abs
import kotlin.math.pow

/**
 * The avatars in a gently curved line: the chosen one large in the middle, the rest getting
 * smaller and fainter towards the edges. Left and Right glide the line along; OK keeps the one
 * in the middle. The whole line is one focus stop, so Up and Down leave it as usual.
 */
class AvatarCarousel(context: Context, attrs: AttributeSet?) : FrameLayout(context, attrs) {

    private val dp = resources.displayMetrics.density
    private var avatars: List<Avatars.Avatar> = emptyList()
    private val discs = mutableListOf<View>()
    private val ring = View(context).apply { setBackgroundResource(R.drawable.profile_ring); alpha = 0f }
    /** Where the line is, in avatars: a whole number at rest, in between while gliding. */
    private var position = 0f
    private var target = 0
    private var glide: ValueAnimator? = null

    /** Told as soon as a new avatar arrives in the middle. */
    var onChanged: (Avatars.Avatar) -> Unit = {}
    var onPick: (Avatars.Avatar) -> Unit = {}

    val current get() = avatars[target]

    init {
        isFocusable = true
        clipChildren = false
        setOnFocusChangeListener { _, has -> ring.animate().alpha(if (has) 1f else 0f).setDuration(200).start() }
    }

    fun show(list: List<Avatars.Avatar>, start: Int) {
        avatars = list
        removeAllViews()
        discs.clear()
        list.forEach { a ->
            val disc = FrameLayout(context).apply {
                addView(View(context).apply {
                    setBackgroundResource(R.drawable.profile_disc)
                    ((background.mutate() as LayerDrawable).getDrawable(0) as GradientDrawable).setColor(a.tint)
                }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
                addView(ImageView(context).apply { setImageResource(a.image); importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO },
                    LayoutParams((SIZE_DP * 0.68f * dp).toInt(), (SIZE_DP * 0.68f * dp).toInt(), Gravity.CENTER))
            }
            discs += disc
            addView(disc, LayoutParams((SIZE_DP * dp).toInt(), (SIZE_DP * dp).toInt(), Gravity.CENTER))
        }
        addView(ring, LayoutParams(((SIZE_DP + 10) * dp).toInt(), ((SIZE_DP + 10) * dp).toInt(), Gravity.CENTER))
        target = start.coerceIn(0, list.lastIndex)
        position = target.toFloat()
        place()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> move(-1, event.repeatCount > 0)
            KeyEvent.KEYCODE_DPAD_RIGHT -> move(1, event.repeatCount > 0)
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> onPick(current)
            else -> return super.onKeyDown(keyCode, event)
        }
        return true
    }

    private fun move(by: Int, held: Boolean) {
        val next = (target + by).coerceIn(0, avatars.lastIndex)
        if (next == target) return
        target = next
        onChanged(current)
        glide?.cancel()
        glide = ValueAnimator.ofFloat(position, target.toFloat()).apply {
            duration = if (held) 140 else 320
            interpolator = EASE
            addUpdateListener { position = it.animatedValue as Float; place() }
            start()
        }
    }

    /** Sets each disc's place, size and fade from its distance to the middle. */
    private fun place() {
        discs.forEachIndexed { i, v ->
            val d = i - position
            val far = abs(d)
            if (far > 5.5f) {
                v.visibility = View.INVISIBLE
                return@forEachIndexed
            }
            v.visibility = View.VISIBLE
            val scale = (1f - 0.19f * far).coerceAtLeast(0.38f)
            v.scaleX = scale
            v.scaleY = scale
            // Closer together towards the edges, and dipping slightly: a gentle curve.
            v.translationX = d * SPACING_DP * dp * (1f - 0.07f * far.coerceAtMost(5f))
            v.translationY = far.pow(1.5f) * 5f * dp
            v.alpha = (1f - 0.2f * far).coerceAtLeast(0f)
            v.translationZ = -far
        }
        ring.translationZ = 1f
    }

    companion object {
        private const val SIZE_DP = 132f
        private const val SPACING_DP = 150f
        private val EASE = PathInterpolator(0.2f, 0f, 0f, 1f)
    }
}
