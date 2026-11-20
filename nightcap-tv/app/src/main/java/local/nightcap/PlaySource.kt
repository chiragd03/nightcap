package local.nightcap

import android.content.Intent
import org.json.JSONObject

/**
 * Where a title was opened or played from, passed along screen to screen so the server can link
 * each play and action to it: a Home row (and the card's place in it), search, Continue
 * watching, Up next, or straight from a page. [requestId] and [modelVersion] identify the
 * AI answer that showed it, when it came from one.
 */
data class PlaySource(
    val origin: String,
    val row: String? = null,
    val slot: Int? = null,
    val requestId: String? = null,
    val modelVersion: String? = null,
) {
    fun into(body: JSONObject): JSONObject = body.apply {
        put("origin", origin)
        row?.let { put("row", it) }
        slot?.let { put("slot", it) }
        requestId?.let { put("requestId", it) }
        modelVersion?.let { put("modelVersion", it) }
    }

    fun into(intent: Intent): Intent = intent.putExtra(ORIGIN, origin).putExtra(ROW, row)
        .putExtra(SLOT, slot ?: -1).putExtra(REQUEST, requestId).putExtra(MODEL, modelVersion)

    companion object {
        private const val ORIGIN = "source.origin"
        private const val ROW = "source.row"
        private const val SLOT = "source.slot"
        private const val REQUEST = "source.request"
        private const val MODEL = "source.model"
        val DIRECT = PlaySource("direct")

        fun from(intent: Intent): PlaySource = intent.getStringExtra(ORIGIN)?.let {
            PlaySource(it, intent.getStringExtra(ROW), intent.getIntExtra(SLOT, -1).takeIf { s -> s >= 0 },
                intent.getStringExtra(REQUEST), intent.getStringExtra(MODEL))
        } ?: DIRECT

        /** Opened from a Home row: Continue watching counts as its own origin. */
        fun ofRow(row: Row, slot: Int) = PlaySource(if (row.id == "continue") "continue" else "row", row.id, slot,
            row.requestId, row.modelVersion)
    }
}
