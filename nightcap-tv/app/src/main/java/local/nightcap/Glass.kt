package local.nightcap

import android.graphics.Matrix
import android.graphics.RenderEffect
import android.graphics.Shader
import android.content.Context
import android.graphics.drawable.Drawable
import android.util.AttributeSet
import android.view.View
import android.widget.ImageView

/** The blurred image inside a glass box: fills the box but never sizes it. */
class GlassImageView(context: Context, attrs: AttributeSet?) : ImageView(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
        setMeasuredDimension(View.resolveSize(0, widthMeasureSpec), View.resolveSize(0, heightMeasureSpec))
}

/**
 * The blur behind glass, on [view] (null: none). Android 12 and up only: on older TVs the glass
 * is left without its picture (blur() is false), so it shows its plain tint rather than a sharp copy.
 */
object Blur {
    val supported get() = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S

    fun set(view: View, radiusPx: Float?) {
        if (!supported) return
        view.setRenderEffect(radiusPx?.let { RenderEffect.createBlurEffect(it, it, Shader.TileMode.CLAMP) })
    }
}

/**
 * Frosted glass for small boxes sitting over the backdrop: the box holds its own blurred copy
 * of the backdrop image, positioned so it lines up exactly with what's behind it. The blur is
 * applied once per image, so it costs nothing while browsing (no per-frame screen blur).
 */
object Glass {
    fun show(glass: ImageView, backdrop: ImageView, image: Drawable?) {
        if (image == null || !Blur.supported) {
            glass.setImageDrawable(null)
            return
        }
        // Its own copy, so the two views don't fight over the drawable's bounds.
        glass.setImageDrawable(image.constantState?.newDrawable(glass.resources)?.mutate() ?: image)
        val dp = glass.resources.displayMetrics.density
        Blur.set(glass, 22 * dp)
        glass.post { align(glass, backdrop) }
    }

    /** Shows a live video frame (already sized like [source]) under the glass. */
    fun showFrame(glass: ImageView, source: View, frame: android.graphics.Bitmap) {
        if (!Blur.supported) return
        if (glass.drawable !is android.graphics.drawable.BitmapDrawable ||
            (glass.drawable as android.graphics.drawable.BitmapDrawable).bitmap !== frame
        ) {
            glass.setImageDrawable(android.graphics.drawable.BitmapDrawable(glass.resources, frame))
            val dp = glass.resources.displayMetrics.density
            Blur.set(glass, 22 * dp)
        }
        align(glass, source)
        glass.invalidate()
    }

    /** Reproduces the backdrop's centre-crop, shifted by where the glass box sits on screen. */
    private fun align(glass: ImageView, backdrop: View) {
        val d = glass.drawable ?: return
        val dw = d.intrinsicWidth.toFloat()
        val dh = d.intrinsicHeight.toFloat()
        if (dw <= 0 || dh <= 0 || backdrop.width == 0) return
        val scale = maxOf(backdrop.width / dw, backdrop.height / dh)
        val from = IntArray(2).also { backdrop.getLocationInWindow(it) }
        val to = IntArray(2).also { glass.getLocationInWindow(it) }
        glass.imageMatrix = Matrix().apply {
            setScale(scale, scale)
            postTranslate(
                (backdrop.width - dw * scale) / 2 + from[0] - to[0],
                (backdrop.height - dh * scale) / 2 + from[1] - to[1],
            )
        }
    }
}
