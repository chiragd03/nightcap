package local.nightcap

import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView

/**
 * Updating a row of cards without redrawing it: only cards that changed are rebound, a card
 * that moves slides to its new place, one that goes fades out, and focus stays in the same
 * spot in the row (on whichever card is there now), so nothing jumps or scrolls.
 */
object InPlace {
    /** Short, quiet animations for those moves; changed cards swap without a crossfade. */
    fun animator() = DefaultItemAnimator().apply {
        supportsChangeAnimations = false
        moveDuration = 320
        removeDuration = 200
        addDuration = 200
    }

    /** Swaps [old] for [new] in [list] (via [commit]) and tells [adapter] exactly what changed. */
    fun <T> update(
        list: RecyclerView, adapter: RecyclerView.Adapter<*>, old: List<T>, new: List<T>,
        id: (T) -> String, commit: () -> Unit,
    ) {
        val focusedSlot = list.focusedChild?.let { list.getChildAdapterPosition(it) } ?: RecyclerView.NO_POSITION
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize() = old.size
            override fun getNewListSize() = new.size
            override fun areItemsTheSame(o: Int, n: Int) = id(old[o]) == id(new[n])
            override fun areContentsTheSame(o: Int, n: Int) = old[o] == new[n]
        })
        commit()
        diff.dispatchUpdatesTo(adapter)
        if (focusedSlot == RecyclerView.NO_POSITION || new.isEmpty()) return
        // Keep focus where it was in the row, on the card that's there now.
        val slot = focusedSlot.coerceAtMost(new.size - 1)
        list.post { list.findViewHolderForAdapterPosition(slot)?.itemView?.takeIf { !it.hasFocus() }?.requestFocus() }
    }
}
