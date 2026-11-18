package local.nightcap

import androidx.annotation.DrawableRes

/**
 * The profile pictures: Microsoft's Fluent 3D emoji (MIT licence, see assets/licenses), each
 * on a disc of its own colour. The server stores only the [key].
 */
object Avatars {
    class Avatar(val key: String, @DrawableRes val image: Int, val tint: Int) {
        /** What it's called under the avatar picker. */
        val label get() = if (key == "invader") "Space invader" else key.replace('_', ' ').replaceFirstChar(Char::uppercase)
    }

    val all = listOf(
        Avatar("fox", R.drawable.avatar_fox, 0xFF6B331B.toInt()),
        Avatar("panda", R.drawable.avatar_panda, 0xFF2E486B.toInt()),
        Avatar("tiger", R.drawable.avatar_tiger, 0xFF6B4A1B.toInt()),
        Avatar("owl", R.drawable.avatar_owl, 0xFF422E6B.toInt()),
        Avatar("unicorn", R.drawable.avatar_unicorn, 0xFF5E236B.toInt()),
        Avatar("robot", R.drawable.avatar_robot, 0xFF1B576B.toInt()),
        Avatar("cat", R.drawable.avatar_cat, 0xFF6B4D1B.toInt()),
        Avatar("dog", R.drawable.avatar_dog, 0xFF6B4425.toInt()),
        Avatar("lion", R.drawable.avatar_lion, 0xFF6B461B.toInt()),
        Avatar("koala", R.drawable.avatar_koala, 0xFF46566B.toInt()),
        Avatar("penguin", R.drawable.avatar_penguin, 0xFF1B406B.toInt()),
        Avatar("frog", R.drawable.avatar_frog, 0xFF2A6B2E.toInt()),
        Avatar("monkey", R.drawable.avatar_monkey, 0xFF6B3B1D.toInt()),
        Avatar("bear", R.drawable.avatar_bear, 0xFF6B3E1B.toInt()),
        Avatar("polar_bear", R.drawable.avatar_polar_bear, 0xFF1F466B.toInt()),
        Avatar("wolf", R.drawable.avatar_wolf, 0xFF38496B.toInt()),
        Avatar("rabbit", R.drawable.avatar_rabbit, 0xFF6B3859.toInt()),
        Avatar("hamster", R.drawable.avatar_hamster, 0xFF6B441B.toInt()),
        Avatar("mouse", R.drawable.avatar_mouse, 0xFF46466B.toInt()),
        Avatar("pig", R.drawable.avatar_pig, 0xFF6B273D.toInt()),
        Avatar("cow", R.drawable.avatar_cow, 0xFF46506B.toInt()),
        Avatar("chick", R.drawable.avatar_chick, 0xFF6B571B.toInt()),
        Avatar("octopus", R.drawable.avatar_octopus, 0xFF6B234D.toInt()),
        Avatar("dolphin", R.drawable.avatar_dolphin, 0xFF1B466B.toInt()),
        Avatar("dragon", R.drawable.avatar_dragon, 0xFF216B33.toInt()),
        Avatar("alien", R.drawable.avatar_alien, 0xFF1D466B.toInt()),
        Avatar("invader", R.drawable.avatar_invader, 0xFF3F1E6B.toInt()),
        Avatar("ghost", R.drawable.avatar_ghost, 0xFF3B436B.toInt()),
    )

    private val byKey = all.associateBy { it.key }

    /** A profile's avatar; one without a choice yet gets a steady pick from its id. */
    fun of(key: String?, profileId: String): Avatar =
        key?.let(byKey::get) ?: all[Math.floorMod(profileId.hashCode(), all.size)]
}
