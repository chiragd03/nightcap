package local.nightcap

/**
 * A link to play (not a title in the catalogue), with where playback is up to. The history of
 * links played lives on the server; the web app shows and manages it, and sends one to a TV.
 */
data class SentLink(
    val id: String,
    val url: String,
    val name: String,
    val position: Long,
    val duration: Long,
    val sentAt: Double,
    val hasThumb: Boolean = false,
) {
    val thumb: String? get() = if (hasThumb) "${Server.url}/launcher/sent/$id.jpg" else null
}
