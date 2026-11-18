package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.PixelCopy
import android.view.SurfaceView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Plays a link sent from the phone (an .m3u8 or a direct video file) and keeps the
 * server told where it's up to, so it resumes from the same spot on any later visit.
 * Films and episodes play in WatchActivity (VLC); sent links stay here because some of
 * them are streams VLC won't open.
 */
class PlayerActivity : TvActivity() {

    private lateinit var view: PlayerView
    private var player: ExoPlayer? = null
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var id: String
    private val grabThumb = Runnable { grabThumbnail() }
    private val saveProgress = object : Runnable {
        override fun run() {
            report()
            handler.postDelayed(this, SAVE_EVERY_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)
        // No screensaver while watching (it would close the player and stop the link).
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        view = findViewById(R.id.player)
        id = intent.getStringExtra(EXTRA_ID)!!
    }

    override fun onStart() {
        super.onStart()
        val url = intent.getStringExtra(EXTRA_URL)!!
        val resumeAt = intent.getLongExtra(EXTRA_POSITION, 0)
        player = ExoPlayer.Builder(this)
            .setSeekBackIncrementMs(SEEK_MS)
            .setSeekForwardIncrementMs(SEEK_MS)
            .build().also { p ->
            view.player = p
            fun item(asStream: Boolean) = MediaItem.Builder().setUri(url).setMediaMetadata(
                androidx.media3.common.MediaMetadata.Builder().setTitle(intent.getStringExtra(EXTRA_NAME)).build(),
            ).apply { if (asStream) setMimeType(androidx.media3.common.MimeTypes.APPLICATION_M3U8) }.build()
            var triedAsStream = false
            p.setMediaItem(item(asStream = false))
            // Pick up where it was left, unless that was the very start or the very end.
            if (resumeAt > START_GRACE_MS) p.seekTo(resumeAt)
            p.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED) {
                        report()
                        finish()
                    }
                }

                override fun onPlayerError(error: PlaybackException) {
                    // Not a video file: an .m3u8 whose link doesn't end in .m3u8 (so the player
                    // couldn't tell). Tried once more as one.
                    if (!triedAsStream && error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED) {
                        triedAsStream = true
                        p.setMediaItem(item(asStream = true))
                        if (resumeAt > START_GRACE_MS) p.seekTo(resumeAt)
                        p.prepare()
                        return
                    }
                    Log.w(TAG, "Playback failed", error)
                    Notice.later("Couldn't play this link.")
                    finish()
                }
            })
            p.prepare()
            p.playWhenReady = true
        }
        handler.postDelayed(saveProgress, SAVE_EVERY_MS)
        // No picture for this link yet: grab one once it has been playing for a bit.
        if (!intent.getBooleanExtra(EXTRA_HAS_THUMB, false)) handler.postDelayed(grabThumb, THUMB_AFTER_MS)
    }

    /** Left and right jump back and forward, without having to reach the on-screen buttons. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Play on TV is asking something over the video: its keys are its own.
        if (Sheet.open) return super.dispatchKeyEvent(event)
        val p = player
        if (p != null && event.action == KeyEvent.ACTION_DOWN &&
            (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT || event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
        ) {
            if (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT) p.seekBack() else p.seekForward()
            view.showController()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /** Copies the current video frame (the TV is decoding it anyway) and uploads it as the thumbnail. */
    private fun grabThumbnail() {
        val surface = view.videoSurfaceView as? SurfaceView ?: return
        if (player?.isPlaying != true) return handler.postDelayed(grabThumb, 5_000).let { }
        val bitmap = Bitmap.createBitmap(THUMB_W, THUMB_H, Bitmap.Config.ARGB_8888)
        PixelCopy.request(surface, bitmap, { result ->
            if (result != PixelCopy.SUCCESS) return@request
            io.execute {
                val jpeg = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
                runCatching {
                    val request = Request.Builder().url("${Server.url}/launcher/sent/$id/thumb")
                        .post(jpeg.toRequestBody("image/jpeg".toMediaType())).build()
                    Feed.http.newCall(request).execute().close()
                }.onFailure { Log.w(TAG, "Couldn't upload thumbnail", it) }
            }
        }, handler)
    }

    override fun onStop() {
        super.onStop()
        handler.removeCallbacks(saveProgress)
        handler.removeCallbacks(grabThumb)
        report()
        player?.release()
        player = null
    }

    /** For Play on TV (see NowPlaying). */
    private val asPlayer = object : NowPlaying.Player {
        override fun pauseForQuestion() = (player?.isPlaying == true).also { if (it) player?.pause() }
        override fun carryOn() {
            player?.play()
        }
        override fun close() = finish()
    }

    override fun onResume() {
        super.onResume()
        NowPlaying.current = asPlayer
    }

    override fun onDestroy() {
        if (NowPlaying.current === asPlayer) NowPlaying.current = null
        // The screen is gone: drop its timers; work already started finishes, then its thread ends.
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        super.onDestroy()
    }

    /** Sends the current position to the server (on a background thread). */
    private fun report() {
        val p = player ?: return
        val position = p.currentPosition
        val duration = p.duration.takeIf { it > 0 } ?: 0
        if (position <= 0) return
        val body = """{"position": $position, "duration": $duration}""".toRequestBody("application/json".toMediaType())
        io.execute {
            runCatching {
                val request = Request.Builder().url("${Server.url}/launcher/sent/$id/progress").post(body).build()
                Feed.http.newCall(request).execute().close()
            }.onFailure { Log.w(TAG, "Couldn't save position", it) }
        }
    }

    companion object {
        private const val TAG = "Nightcap"
        private const val EXTRA_ID = "id"
        private const val EXTRA_URL = "url"
        private const val EXTRA_NAME = "name"
        private const val EXTRA_POSITION = "position"
        private const val EXTRA_HAS_THUMB = "hasThumb"
        private const val SEEK_MS = 10_000L
        private const val THUMB_AFTER_MS = 20_000L
        private const val THUMB_W = 480
        private const val THUMB_H = 270
        private const val SAVE_EVERY_MS = 10_000L
        private const val START_GRACE_MS = 5_000L

        fun intent(context: Context, item: SentLink): Intent = Intent(context, PlayerActivity::class.java)
            .putExtra(EXTRA_ID, item.id).putExtra(EXTRA_URL, item.url).putExtra(EXTRA_NAME, item.name)
            .putExtra(EXTRA_POSITION, if (item.duration > 0 && item.position > item.duration - 30_000) 0 else item.position)
            .putExtra(EXTRA_HAS_THUMB, item.hasThumb)
    }
}
