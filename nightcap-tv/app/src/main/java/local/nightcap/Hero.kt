package local.nightcap

import android.animation.ValueAnimator
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.TextureView
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.datasource.DefaultDataSource
import coil.imageLoader
import coil.load
import coil.request.ImageRequest

/**
 * Backdrop and trailer for the focused title. Moving quickly through a row only
 * swaps text; the backdrop loads after a brief pause and the trailer after a rest.
 */
class Hero(
    private val context: Context,
    private val backdrop: ImageView,
    private val trailerView: TextureView,
    /** Never any sound (a title's page); otherwise the TV's trailer sound choice ([TrailerSound]). */
    private val silent: Boolean = false,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var current: Item? = null
    /** Told whenever a new backdrop image is showing (null when cleared), e.g. for glass boxes. */
    var onBackdrop: ((android.graphics.drawable.Drawable?) -> Unit)? = null
    private var playingKey: String? = null
    private var canRetry = false
    private var volumeFade: ValueAnimator? = null
    private val sources by lazy { ProgressiveMediaSource.Factory(DefaultDataSource.Factory(context)) }
    /** Whether the screen is in front. A refresh landing while another screen covers this one
     *  (Who's watching, a title page) must not start a trailer playing out of sight. */
    private var active = false

    init {
        // (Through the app's callbacks, which every Android version has, for this screen only; let go
        // of when it's destroyed.)
        (context as? android.app.Activity)?.let { screen ->
            screen.application.registerActivityLifecycleCallbacks(object : android.app.Application.ActivityLifecycleCallbacks {
                override fun onActivityResumed(activity: android.app.Activity) { if (activity === screen) active = true }
                override fun onActivityPaused(activity: android.app.Activity) { if (activity === screen) active = false }
                override fun onActivityDestroyed(activity: android.app.Activity) {
                    if (activity === screen) screen.application.unregisterActivityLifecycleCallbacks(this)
                }
                override fun onActivityCreated(activity: android.app.Activity, state: android.os.Bundle?) = Unit
                override fun onActivityStarted(activity: android.app.Activity) = Unit
                override fun onActivityStopped(activity: android.app.Activity) = Unit
                override fun onActivitySaveInstanceState(activity: android.app.Activity, state: android.os.Bundle) = Unit
            })
        }
    }

    fun show(row: Row, item: Item) {
        // Not in front: the screen shows the focused title again when it comes back (onResume).
        if (!active) return
        if (item === current) return
        // (The same title with new details, an in-place update: what's playing carries on.)
        val was = current
        current = item
        if (was != null && was.id == item.id && was.backdrop == item.backdrop && was.trailer == item.trailer) return
        handler.removeCallbacksAndMessages(null)
        stopTrailer()
        handler.postDelayed({ loadBackdrop(row, item) }, BACKDROP_DELAY_MS)
        // What's heavy for the TV (a trailer's YouTube lookup takes it a couple of seconds of work, a
        // backdrop a big picture to decode) waits until the viewer rests here: moving past titles, it
        // was done for each and its neighbours, and that work is what made scrolling stutter.
        // (A build without trailers: the still picture stays.)
        item.trailer?.takeIf { Trailers.available }?.let { key ->
            handler.postDelayed({ Trailers.prefetch(key) }, REST_MS)
            handler.postDelayed({ startTrailer(key) }, TRAILER_DELAY_MS)
        }
        handler.postDelayed({ warmNeighbours(row, item) }, REST_MS)
    }

    /** The trailer's current frame, small, while it's showing; null otherwise. Reuses [into]. */
    fun trailerFrame(into: android.graphics.Bitmap): android.graphics.Bitmap? =
        if (trailerView.alpha > 0.5f && trailerView.isAvailable) trailerView.getBitmap(into) else null

    /** True while a trailer is on screen. */
    fun playingTrailer() = trailerView.alpha > 0.5f

    /** Stops everything and blanks the backdrop (e.g. when the search box is cleared). */
    fun clear() {
        pause()
        backdrop.setImageDrawable(null)
        onBackdrop?.invoke(null)
    }

    /** Releases the player while the launcher is in the background. */
    fun pause() {
        handler.removeCallbacksAndMessages(null)
        stopTrailer()
        player?.release()
        player = null
        current = null
    }

    private fun loadBackdrop(row: Row, item: Item) {
        backdrop.load(item.backdrop) {
            crossfade(200)
            size(BACKDROP_W, BACKDROP_H)
            listener(onSuccess = { _, result -> onBackdrop?.invoke(result.drawable) })
        }
    }

    /** Once the viewer rests on [item]: its neighbours' backdrops and trailers, so the next move
     *  shows them at once. */
    private fun warmNeighbours(row: Row, item: Item) {
        val i = row.items.indexOf(item)
        listOfNotNull(row.items.getOrNull(i + 1), row.items.getOrNull(i - 1)).forEach { n ->
            n.backdrop?.let {
                context.imageLoader.enqueue(ImageRequest.Builder(context).data(it).size(BACKDROP_W, BACKDROP_H).build())
            }
            n.trailer?.let(Trailers::prefetch)
        }
    }

    /** Streams the trailer straight from YouTube; without one, the backdrop stays. */
    private fun startTrailer(key: String, retry: Boolean = true) {
        Trailers.resolve(key) { streams ->
            // (Never behind a question or menu: its sound would play under it.)
            // (A menu open: not now; landing on the title again starts it.)
            if (Sheet.open && current?.trailer == key) current = null
            if (!active || Sheet.open || current?.trailer != key || streams == null) return@resolve
            canRetry = retry
            playStreams(key, streams)
        }
    }

    private fun playStreams(key: String, s: Trailers.Streams) {
        val p = player ?: buildPlayer().also { player = it }
        playingKey = key
        val video = sources.createMediaSource(MediaItem.fromUri(s.video))
        p.setMediaSource(s.audio?.let { MergingMediaSource(video, sources.createMediaSource(MediaItem.fromUri(it))) } ?: video)
        p.volume = 0f
        p.prepare()
        // Skip the rating card most trailers open with.
        p.seekTo(SKIP_INTRO_MS)
        p.playWhenReady = true
    }

    private fun stopTrailer() {
        volumeFade?.cancel()
        playingKey = null
        trailerView.animate().cancel()
        trailerView.alpha = 0f
        player?.run {
            stop()
            clearMediaItems()
        }
    }

    private fun buildPlayer(): ExoPlayer {
        // Small buffers: previews should start fast, not survive a flaky network.
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(2_000, 15_000, 500, 1_000)
            .build()
        return ExoPlayer.Builder(context).setLoadControl(loadControl).build().apply {
            setVideoTextureView(trailerView)
            addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    trailerView.animate().alpha(1f).setDuration(350).start()
                    fadeInVolume()
                }

                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_ENDED) trailerView.animate().alpha(0f).setDuration(350).start()
                }

                override fun onPlayerError(error: PlaybackException) {
                    val key = playingKey
                    stopTrailer()
                    // YouTube's addresses expire: look it up afresh once, otherwise keep the backdrop.
                    if (key != null && canRetry) {
                        Trailers.forget(key)
                        startTrailer(key, retry = false)
                    }
                }
            })
        }
    }

    /** The trailer sound was switched on or off: a playing trailer follows straight away. */
    fun soundChanged() {
        if (player?.isPlaying == true) fadeInVolume(from = player?.volume ?: 0f)
    }

    private fun fadeInVolume(from: Float = 0f) {
        volumeFade?.cancel()
        val to = if (silent || TrailerSound.muted(context)) 0f else TRAILER_VOLUME
        volumeFade = ValueAnimator.ofFloat(from, to).apply {
            duration = if (to < from) 400 else 1_500
            addUpdateListener { player?.volume = it.animatedValue as Float }
            start()
        }
    }

    companion object {
        // Relative to the TV's volume, as signal strength (ears hear it on a log scale):
        // 0.1 is about -20 dB, which sounds roughly a quarter as loud. Quiet enough to talk over.
        private const val TRAILER_VOLUME = 0.1f
        private const val BACKDROP_DELAY_MS = 90L
        /** On a title this long, the viewer is resting there, not passing through. */
        private const val REST_MS = 450L
        private const val TRAILER_DELAY_MS = 1_100L
        private const val SKIP_INTRO_MS = 3_000L
        private const val BACKDROP_W = 1340
        private const val BACKDROP_H = 754
    }
}
