package local.nightcap

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.TextView
import okhttp3.Request
import org.json.JSONObject
import java.time.YearMonth
import java.time.format.TextStyle
import java.util.Locale
import java.util.concurrent.Executor

/** Weather (top right) and AI spend (bottom-right corner), refreshed every few minutes while visible. */
class Widgets(private val activity: Activity, private val io: Executor) {
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            load()
            handler.postDelayed(this, REFRESH_MS)
        }
    }

    fun start() {
        handler.removeCallbacks(refresh)
        refresh.run()
    }

    fun stop() = handler.removeCallbacks(refresh)

    private fun load() = io.execute {
        val json = runCatching {
            val request = Request.Builder().url("${Server.url}/launcher/widgets.json").build()
            Feed.http.newCall(request).execute().use { JSONObject(it.body!!.string()) }
        }.getOrElse {
            Log.w("Nightcap", "Widgets unavailable", it)
            return@execute
        }
        activity.runOnUiThread { bind(json) }
    }

    /** Each widget shows only when the server sends it (a profile can turn either off). */
    private fun bind(json: JSONObject) {
        if (!json.has("ai")) activity.findViewById<View>(R.id.aiMini).visibility = View.GONE
        // (Clipped to its rounded glass here: the layout's clipToOutline only works on Android 12 and up.)
        activity.findViewById<View>(R.id.weatherWidget).clipToOutline = true
        if (!json.has("weather")) activity.findViewById<View>(R.id.weatherWidget).visibility = View.GONE
        json.optJSONObject("ai")?.let { c ->
            val month = runCatching {
                YearMonth.parse(c.getString("month")).month.getDisplayName(TextStyle.SHORT, Locale.getDefault())
            }.getOrDefault("this month")
            val cost = c.optDouble("month_cost", 0.0)
            val amount = if (cost >= 0.01 || cost == 0.0) "$%.2f".format(cost) else "$%.3f".format(cost)
            // (Calls to a model without a price have no cost: the total is then at least this, or unknown.)
            val unpriced = c.optInt("month_unpriced_calls") > 0
            set(R.id.aiMini, when {
                unpriced && cost == 0.0 -> "✦ AI  cost unknown in $month"
                unpriced -> "✦ AI  $amount+ in $month"
                else -> "✦ AI  $amount in $month"
            })
            activity.findViewById<View>(R.id.aiMini).visibility = View.VISIBLE
        }
        json.optJSONObject("weather")?.let { w ->
            set(R.id.weatherIcon, w.optString("icon"))
            set(R.id.weatherValue, "${w.optInt("temp")}°")
            set(R.id.weatherFeels, "feels ${w.optInt("feels", w.optInt("temp"))}°")
            val condition = w.optString("condition").takeIf { it.isNotEmpty() }
            set(R.id.weatherSub, listOfNotNull(
                w.optString("city").takeIf { it.isNotEmpty() },
                condition,
                "${w.optInt("high")}° / ${w.optInt("low")}°",
            ).joinToString(" · "))
            activity.findViewById<View>(R.id.weatherWidget).visibility = View.VISIBLE
        }
    }

    private fun set(id: Int, text: String) {
        activity.findViewById<TextView>(id).text = text
    }

    companion object {
        private const val REFRESH_MS = 10 * 60 * 1000L
    }
}
