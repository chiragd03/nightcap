package local.nightcap

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import coil.load

/**
 * Play on TV's question, over whatever screen is open: the title's picture, who's asking (their
 * avatar and name), what they want to play, and two answers side by side. Same frosted glass as
 * the long-press menu (Sheet.present). Back is "not now".
 */
object AskCard {
    fun show(
        activity: Activity, who: Inbox.Sender, title: String, detail: String?, art: String?,
        playLabel: String, onPlay: () -> Unit, onNotNow: () -> Unit,
    ): () -> Unit {
        val card = LayoutInflater.from(activity).inflate(R.layout.ask_card, null, false)
        val picture = Avatars.of(who.avatar, who.id)
        card.findViewById<ImageView>(R.id.askAvatar).setImageResource(picture.image)
        ((card.findViewById<View>(R.id.askDisc).background.mutate() as LayerDrawable).getDrawable(0) as GradientDrawable)
            .setColor(picture.tint)
        card.findViewById<TextView>(R.id.askWho).text = "${who.name} wants to play"
        card.findViewById<TextView>(R.id.askTitle).text = title
        card.findViewById<TextView>(R.id.askDetail).apply {
            text = detail
            visibility = if (detail.isNullOrBlank()) View.GONE else View.VISIBLE
        }
        val artFrame = card.findViewById<View>(R.id.askArtFrame)
        if (art != null) card.findViewById<ImageView>(R.id.askArt).load(art) else artFrame.visibility = View.GONE

        val row = card.findViewById<LinearLayout>(R.id.askChoices)
        val dp = activity.resources.displayMetrics.density
        fun choice(icon: Int, label: String, first: Boolean) =
            LayoutInflater.from(activity).inflate(R.layout.sheet_item, row, false).apply {
                findViewById<ImageView>(R.id.sheetIcon).setImageResource(icon)
                findViewById<TextView>(R.id.sheetLabel).text = label
                layoutParams = LinearLayout.LayoutParams(0, (34 * dp).toInt(), 1f)
                    .apply { if (!first) marginStart = (8 * dp).toInt() }
                row.addView(this)
            }
        val play = choice(R.drawable.ic_play, playLabel, first = true)
        val notNow = choice(R.drawable.ic_act_close, "Not now", first = false)
        return Sheet.present(activity, activity.currentFocus, card, card.findViewById(R.id.askGlass),
            listOf(play to onPlay, notNow to onNotNow), widthDp = 420, across = true, onCancel = onNotNow)
    }
}
