package local.nightcap

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.MediaSource
import org.json.JSONObject

/** Opens a Live TV item that comes with a recipe (an own item opened the household's own way):
 *  its playable source, or null when it can't. [LiveStreams.handler] is the build's one, if any. */
@OptIn(UnstableApi::class)
interface LiveHandler {
    fun source(context: Context, url: String, recipe: JSONObject): MediaSource?
}
