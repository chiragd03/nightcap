package local.nightcap

/**
 * The player that's open, if one is (the catalogue's or a link's), so Play on TV can pause it while
 * it asks, carry on if the answer is no, and close it to play what was sent.
 */
object NowPlaying {
    interface Player {
        /** Pauses if it was playing; true if it was. */
        fun pauseForQuestion(): Boolean
        fun carryOn()
        /** Closes it, saving where it got to. */
        fun close()
    }

    @Volatile var current: Player? = null
}
