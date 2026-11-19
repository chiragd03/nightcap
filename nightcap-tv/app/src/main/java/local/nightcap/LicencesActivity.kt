package local.nightcap

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Licences and credits (opened from Settings): where the titles, weather and episodes come from, and
 * each part Nightcap is made with, its licence shown in full beside it (assets/licenses).
 */
class LicencesActivity : TvActivity() {

    /** A part: its name, its licence's short name, and the file in assets/licenses with the text. */
    private data class Part(val name: String, val licence: String, val file: String)

    private lateinit var licence: ScrollView
    private lateinit var licenceText: TextView
    private val texts = HashMap<String, String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_licences)
        licence = findViewById(R.id.licence)
        licenceText = findViewById(R.id.licenceText)
        val list = findViewById<LinearLayout>(R.id.parts)
        val dp = resources.displayMetrics.density
        PARTS.forEach { part ->
            list.addView(TextView(this).apply {
                id = View.generateViewId()
                text = "${part.name}  ·  ${part.licence}"
                textSize = 10f
                setTextColor(getColorStateList(R.color.nav_item_fg))
                fontVariationSettings = "'wght' 500"
                setBackgroundResource(R.drawable.nav_item_bg)
                isFocusable = true
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding((14 * dp).toInt(), 0, (14 * dp).toInt(), 0)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (34 * dp).toInt())
                    .apply { bottomMargin = (4 * dp).toInt() }
                // (Right goes to its licence, and Left from there comes back to it.)
                nextFocusRightId = R.id.licence
                setOnFocusChangeListener { v, has ->
                    if (!has) return@setOnFocusChangeListener
                    licence.nextFocusLeftId = v.id
                    show(part)
                }
                setOnClickListener { licence.requestFocus() }
            })
        }
        list.getChildAt(0).requestFocus()
    }

    private fun show(part: Part) {
        licenceText.text = texts.getOrPut(part.file) {
            runCatching { assets.open("licenses/${part.file}").bufferedReader().use { it.readText() } }
                .getOrDefault("")
        }
        licence.scrollTo(0, 0)
    }

    companion object {
        private val PARTS = listOf(
            Part("libVLC", "LGPL-2.1", "libvlc.txt"),
            Part("AndroidX Media3", "Apache-2.0", "apache-2.0.txt"),
            Part("OkHttp", "Apache-2.0", "apache-2.0.txt"),
            Part("Coil", "Apache-2.0", "apache-2.0.txt"),
            Part("Material Icons", "Apache-2.0", "apache-2.0.txt"),
            Part("AndroidX, Kotlin, Guava", "Apache-2.0", "apache-2.0.txt"),
            Part("Hanken Grotesk", "OFL-1.1", "hanken-grotesk.txt"),
            Part("Big Shoulders", "OFL-1.1", "big-shoulders.txt"),
            Part("Fluent Emoji", "MIT", "fluent-emoji.txt"),
            Part("Phosphor Icons", "MIT", "phosphor-icons.txt"),
        )

        fun intent(context: Context) = Intent(context, LicencesActivity::class.java)
    }
}
