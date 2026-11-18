package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.util.DisplayMetrics
import kotlin.math.max
import kotlin.math.min

/**
 * Every Nightcap screen. It's laid out for a 960 x 540 dp screen, the size nearly every TV says it
 * is (1080p at 320 dpi, 4K at 640, 720p at 213), so on a TV that says otherwise (a box that calls
 * its 1080p screen 1280 or 1920 dp wide) the density is set so the screen is 960 dp wide all the
 * same: every TV shows the same layout, scaled to fit. Text set to grow very large in the TV's
 * accessibility settings is held at MAX_FONT_SCALE, so it can't spill out of its cards. A TV that
 * already matches is left exactly as it is.
 *
 * And a screen coming to the front on a TV that's no longer in a household (removed, or its
 * household deleted, while another app was in front) goes to the Connect screen, rather than
 * staying on what it last showed.
 */
abstract class TvActivity : Activity() {
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(newBase)
        overrideFor(newBase)?.let(::applyOverrideConfiguration)
    }

    override fun onResume() {
        super.onResume()
        if (!Server.ready && this !is ConnectActivity) {
            startActivity(ConnectActivity.intent(this)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
            finish()
        }
    }

    companion object {
        const val WIDTH_DP = 960
        const val MAX_FONT_SCALE = 1.15f

        /** The changes that make [base] a 960 dp wide screen with text held at MAX_FONT_SCALE, or null if it is one. */
        fun overrideFor(base: Context): Configuration? {
            val metrics = base.resources.displayMetrics
            val config = base.resources.configuration
            val longSide = max(metrics.widthPixels, metrics.heightPixels)
            val shortSide = min(metrics.widthPixels, metrics.heightPixels)
            if (longSide <= 0) return null
            val dpi = longSide * DisplayMetrics.DENSITY_DEFAULT / WIDTH_DP
            val sameSize = kotlin.math.abs(dpi - config.densityDpi) <= 2
            val fontOk = config.fontScale <= MAX_FONT_SCALE
            if (sameSize && fontOk) return null
            return Configuration().apply {
                if (!sameSize) {
                    densityDpi = dpi
                    screenWidthDp = WIDTH_DP
                    screenHeightDp = shortSide * DisplayMetrics.DENSITY_DEFAULT / dpi
                    smallestScreenWidthDp = screenHeightDp
                }
                if (!fontOk) fontScale = MAX_FONT_SCALE
            }
        }
    }
}
