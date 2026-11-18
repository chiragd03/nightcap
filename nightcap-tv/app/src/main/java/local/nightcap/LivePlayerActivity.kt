package local.nightcap

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.load
import org.json.JSONArray
import java.util.concurrent.Executors

/**
 * Watching a channel. While it plays, any key first only brings up its name, the buttons in the
 * middle (Pause, an event's Sources, My channels; Pause focused) and the row's channels at the
 * bottom, so nothing changes unseen. Down goes from the buttons to the row (Left/Right along it, OK
 * watches one, held: My channels), Up back. While it starts the middle shows a turning light; when
 * there's nothing to watch (not on yet, off air) it says so there, with the row up and no buttons.
 * A remote's own play/pause and channel keys work at once. Each channel's streams are tried best first; one that doesn't start within a while counts
 * as failed, and when none plays the server is told (only while the TV's internet works, so a
 * dropped connection never hides a channel).
 */
@OptIn(UnstableApi::class)
class LivePlayerActivity : TvActivity() {
    private lateinit var view: PlayerView
    private lateinit var info: View
    private lateinit var strip: View
    private lateinit var stripItems: LinearLayout
    private lateinit var stripScroll: HorizontalScrollView
    private var player: ExoPlayer? = null
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var channels: MutableList<Channel> = mutableListOf()
    private var index = 0
    private var picked = 0
    private var rowTitle = ""
    private var streams: List<LiveStream> = emptyList()
    /** The item playing: the card's own, or, for an event's card, the channel picked. */
    private var member: String? = null
    /** Each profile's last channel of each event, so an event opens on it again. */
    private val picks by lazy { getSharedPreferences("live_channel_picks", MODE_PRIVATE) }
    private var stream = 0
    /** Whether any of this channel's streams could actually be tried (a recipe stream with no handler
     *  can't): if none could, it isn't reported as a failure, so it isn't hidden. */
    private var attempted = false
    private var asProgressive = false
    private var expiresAt = Long.MAX_VALUE
    private var renewed = false
    /** Which play this is: an answer for one we've moved on from is dropped. */
    private var generation = 0
    private var seconds = 0
    private var longPressed = false
    private lateinit var panel: View
    private lateinit var panelItems: LinearLayout
    private lateinit var actPause: View
    private lateinit var actChannel: View
    private lateinit var actStar: View
    /** Whether the row (not the buttons) has the keys. */
    private var inRow = false
    /** Whether the name and buttons are up (keys act on them) or hidden (a key only brings them up). */
    private var shown = false
    private var paused = false
    /** A key whose press only brought the buttons up: its release (and its repeats) do nothing. */
    private var swallowed = -1

    /** What the middle of the screen is for: the picture, a stream starting, or nothing to watch. */
    private enum class Stage { LOADING, PLAYING, NOTHING }
    private var stage = Stage.LOADING
    /** The buttons are only there while something plays. */
    private val buttonsOn get() = stage == Stage.PLAYING
    private val spin by lazy {
        android.animation.ObjectAnimator.ofFloat(findViewById(R.id.stageSpinner), View.ROTATION, 0f, 360f).apply {
            duration = 900
            repeatCount = android.animation.ValueAnimator.INFINITE
            interpolator = android.view.animation.LinearInterpolator()
        }
    }

    private val hideInfo = Runnable { if (!paused && stage != Stage.NOTHING && panel.visibility != View.VISIBLE) hideControls() }
    private val tooSlow = Runnable { nextStream() }
    /** The channel's stream played this time (so a failure after is a drop, tried again once). */
    private var played = false
    private var reconnected = false
    private val calm = Runnable { reconnected = false }
    private val tick = object : Runnable {
        override fun run() {
            if (player?.isPlaying == true) {
                seconds++
                if (seconds >= REPORT_EVERY_S) report()
            }
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_live_player)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        view = findViewById(R.id.livePlayer)
        view.useController = false
        info = findViewById(R.id.liveInfo)
        strip = findViewById(R.id.liveStrip)
        stripItems = findViewById(R.id.stripItems)
        stripScroll = findViewById(R.id.stripScroll)
        panel = findViewById(R.id.panel)
        panelItems = findViewById(R.id.panelItems)
        actPause = findViewById(R.id.actPause)
        actChannel = findViewById(R.id.actChannel)
        actStar = findViewById(R.id.actStar)
        actPause.setOnClickListener { togglePause() }
        actChannel.setOnClickListener { openChannels() }
        actStar.setOnClickListener { toggleFavourite(index) }
        // Focused: its disc lifts and a soft light comes up round it.
        listOf(actPause, actChannel, actStar).forEach { b ->
            b.setOnFocusChangeListener { v, has ->
                val scale = if (has) 1.14f else 1f
                v.findViewWithTag<View>("disc").animate().scaleX(scale).scaleY(scale).setDuration(240).setInterpolator(Motion.ease).start()
                v.findViewWithTag<View>("halo").animate().alpha(if (has) 1f else 0f).setDuration(240).start()
            }
        }
        val list = JSONArray(intent.getStringExtra(EXTRA_CHANNELS) ?: "[]")
        channels = (0 until list.length()).map { Channel.from(list.getJSONObject(it)) }.toMutableList()
        index = intent.getIntExtra(EXTRA_INDEX, 0).coerceIn(0, (channels.size - 1).coerceAtLeast(0))
        rowTitle = intent.getStringExtra(EXTRA_ROW).orEmpty()
        if (channels.isEmpty()) return finish()
        buildStrip()
    }

    override fun onStart() {
        super.onStart()
        if (channels.isEmpty()) return
        player = LiveActivity.player(this).also { p ->
            view.player = p
            p.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    if (state == Player.STATE_READY && stage == Stage.LOADING) {
                        handler.removeCallbacks(tooSlow)
                        played = true
                        // (Its one retry comes back only after a while playing well: a stream that keeps
                        // dropping moves on to the next.)
                        handler.removeCallbacks(calm)
                        handler.postDelayed(calm, CALM_MS)
                        findViewById<TextView>(R.id.infoState).text = if (paused) "PAUSED" else "LIVE"
                        setStage(Stage.PLAYING)
                    }
                }

                override fun onPlayerError(error: PlaybackException) = failedNow(error)

                override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = showPaused()
            })
        }
        play(index)
        handler.post(tick)
    }

    override fun onStop() {
        super.onStop()
        report()
        handler.removeCallbacksAndMessages(null)
        player?.release()
        player = null
    }

    override fun onResume() {
        super.onResume()
        NowPlaying.current = asPlayer
    }

    override fun onDestroy() {
        if (NowPlaying.current === asPlayer) NowPlaying.current = null
        handler.removeCallbacksAndMessages(null)
        io.shutdown()
        super.onDestroy()
    }

    /** For Play on TV (see NowPlaying). */
    private val asPlayer = object : NowPlaying.Player {
        override fun pauseForQuestion() = (player?.isPlaying == true).also { if (it) player?.pause() }
        override fun carryOn() { player?.play() }
        override fun close() = finish()
    }

    // ---------- Playing ----------

    private fun play(i: Int, pick: String? = null) {
        report()
        index = (i + channels.size) % channels.size
        pick(index)                  // the strip stays on the one playing, however it was changed
        val ch = channels[index]
        member = pick ?: memberOf(ch)
        paused = false
        played = false
        reconnected = false
        stage = Stage.LOADING            // (before showInfo, so it doesn't read the last one's state)
        handler.removeCallbacks(tooSlow)
        player?.stop()
        val gen = ++generation
        // (Not on yet, until its start time: then it's tried.)
        if (ch.upcoming && (ch.startsAt ?: Long.MAX_VALUE) > System.currentTimeMillis()) {
            showInfo(ch, "SOON")
            setStage(Stage.NOTHING, "Starts", ch.startsAt?.let { Live.timeText(this, it) } ?: "Later",
                "It isn't on yet. Pick another from the row below.")
            return
        }
        showInfo(ch, "STARTING")
        setStage(Stage.LOADING, "Tuning in")
        val id = member ?: ch.id
        io.execute {
            val got = runCatching { Live.play(id) }
            handler.post {
                if (gen != generation || player == null) return@post
                got.onSuccess { p ->
                    streams = p.streams
                    expiresAt = p.expiresAt
                    renewed = false
                    stream = 0
                    asProgressive = false
                    attempted = false
                    startStream()
                }.onFailure {
                    Log.w(TAG, "Couldn't get the channel's streams", it)
                    handler.removeCallbacks(tooSlow)
                    findViewById<TextView>(R.id.infoState).text = "NOT PLAYING"
                    setStage(Stage.NOTHING, "Can't connect", "Server not reachable",
                        "Try again in a moment, or pick another from the row below.")
                }
            }
        }
    }

    private fun startStream() {
        val p = player ?: return
        val s = streams.getOrNull(stream) ?: return noneWorked()
        // A recipe stream with no handler installed can't play here: move on, don't count it a failure.
        if (!LiveActivity.setStream(p, this, s, asProgressive)) return nextStream()
        attempted = true
        p.prepare()
        p.playWhenReady = true
        handler.removeCallbacks(tooSlow)
        handler.postDelayed(tooSlow, START_WITHIN_MS)
    }

    private fun failedNow(error: PlaybackException) {
        handler.removeCallbacks(calm)
        // Paused too long, it fell out of what the stream keeps: on again from now.
        if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            player?.run { seekToDefaultPosition(); prepare() }
            return
        }
        // The failure code, and the cause's class name only (never its message or any address), so a
        // custom source's error can be told apart (e.g. a timeout vs a 404 vs the source's own type).
        Log.w(TAG, "A live stream failed (${error.errorCodeName}${error.cause?.let { " / ${it.javaClass.simpleName}" } ?: ""})")
        val gone = (error.cause as? HttpDataSource.InvalidResponseCodeException)?.responseCode == 410
        // The playback links expired (they last hours): fresh ones, once, then on as before.
        if ((gone || System.currentTimeMillis() > expiresAt - 60_000) && !renewed) {
            renewed = true
            val id = member ?: channels[index].id
            val gen = generation
            io.execute {
                val got = runCatching { Live.play(id) }.getOrNull()
                handler.post {
                    if (gen != generation) return@post
                    if (got == null) return@post nextStream()
                    streams = got.streams
                    expiresAt = got.expiresAt
                    startStream()
                }
            }
            return
        }
        // It was playing and dropped (a short outage at the source): the same stream again, once, before
        // the next (the 15 s start limit still guards it).
        if (played && !reconnected) {
            reconnected = true
            setStage(Stage.LOADING, "Reconnecting")
            return startStream()
        }
        // Said to be HLS but isn't (or the other way round): once more the other way.
        val parsing = error.errorCode in PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED..PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED
        if (parsing && !asProgressive) {
            asProgressive = true
            return startStream()
        }
        nextStream()
    }

    private fun nextStream() {
        if (stage == Stage.PLAYING) setStage(Stage.LOADING, "Tuning in")     // it stopped: the next stream
        stream++
        asProgressive = false
        startStream()
    }

    /** None of the channel's streams played. */
    private fun noneWorked() {
        handler.removeCallbacks(tooSlow)
        player?.stop()
        val ch = channels[index]
        findViewById<TextView>(R.id.infoState).text = "NOT PLAYING"
        setStage(Stage.NOTHING, "Off air", if (attempted) "Not playing right now" else "Can't play on this TV",
            "Pick another from the row below.")
        // Only a real play failure (a stream was tried and the TV is online) hides the channel.
        val id = member ?: ch.id
        // (Not one that played here and then dropped: that's the source's outage, not a dead channel.)
        if (attempted && !played && online()) io.execute { Live.failed(id) }
    }

    /** Whether the TV's internet works now (a failure then is the channel's, not the connection's). */
    private fun online(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** Tells the server how long this channel played since it was last told. */
    private fun report() {
        val s = seconds
        seconds = 0
        if (s < MIN_REPORT_S || channels.isEmpty()) return
        val id = member ?: channels[index].id
        io.takeIf { !it.isShutdown }?.execute { Live.watched(id, s) }
    }

    // ---------- What's on screen ----------

    /** The middle of the screen for [s]: nothing over the picture, a turning light while it starts,
     *  or (nothing to watch) what's up, with the row up and its keys. */
    private fun setStage(s: Stage, eyebrow: String = "", title: String = "", sub: String = "") {
        stage = s
        val box = findViewById<View>(R.id.liveStage)
        box.animate().cancel()
        if (s == Stage.PLAYING) {
            spin.cancel()
            box.animate().alpha(0f).setDuration(250).withEndAction { if (stage == Stage.PLAYING) box.visibility = View.GONE }.start()
        } else {
            findViewById<View>(R.id.stageSpinner).visibility = if (s == Stage.LOADING) View.VISIBLE else View.GONE
            if (s == Stage.LOADING) spin.start() else spin.cancel()
            findViewById<TextView>(R.id.stageEyebrow).text = eyebrow
            findViewById<TextView>(R.id.stageTitle).apply { text = title; visibility = if (title.isEmpty()) View.GONE else View.VISIBLE }
            findViewById<TextView>(R.id.stageSub).apply { text = sub; visibility = if (sub.isEmpty()) View.GONE else View.VISIBLE }
            channels.getOrNull(index)?.let { Live.glow(findViewById(R.id.stageGlow), it.hue, 0x38, 230f, 0.5f, 0.5f, cornerDp = 0f) }
            box.translationY = if (s == Stage.LOADING) 0f else -40 * resources.displayMetrics.density
            box.visibility = View.VISIBLE
            box.animate().alpha(1f).setDuration(250).start()
        }
        when {
            s == Stage.NOTHING -> showControls()          // nothing to watch: the row, with its keys
            shown -> showControls()                       // the buttons come (or go) with it
            s == Stage.PLAYING -> laterHide()             // just started: the name for a while
        }
    }

    private fun showInfo(ch: Channel, state: String) {
        findViewById<TextView>(R.id.infoName).text = ch.name
        // A household's own item: its own line ("Demo League"), and for an event the source playing;
        // a channel: its kind, languages, countries.
        val playing = ch.channels.takeIf { it.size > 1 }?.firstOrNull { it.id == member }?.name
        findViewById<TextView>(R.id.infoMeta).text =
            if (ch.state != null) listOfNotNull(ch.about?.takeIf { it.isNotBlank() }, playing).joinToString("  ·  ") else ch.meta
        findViewById<TextView>(R.id.infoState).text = state
        val mono = findViewById<TextView>(R.id.infoMono)
        val logo = findViewById<ImageView>(R.id.infoLogo)
        mono.text = ch.mono
        mono.visibility = if (ch.logo == null) View.VISIBLE else View.GONE
        logo.setImageDrawable(null)
        ch.logo?.let { logo.load(it) { listener(onError = { _, _ -> mono.visibility = View.VISIBLE }) } }
        Live.glow(findViewById(R.id.infoTint), ch.hue, 0x5C, 60f)
        actChannel.visibility = if (ch.channels.size > 1) View.VISIBLE else View.GONE
        showFavourite(ch)
        showPaused()
        info.animate().cancel()
        info.animate().alpha(1f).setDuration(200).start()
    }

    private fun showFavourite(ch: Channel) {
        findViewById<ImageView>(R.id.actStarIcon).apply {
            setImageResource(if (ch.favourite) R.drawable.ic_star else R.drawable.ic_star_outline)
            // The filled star keeps its own gold, focused or not.
            imageTintList = if (ch.favourite) null else getColorStateList(R.color.live_action_fg)
        }
        findViewById<TextView>(R.id.actStarLabel).text = if (ch.favourite) "In My channels" else "My channels"
    }

    /** The name and row up, and the buttons while something plays (they have the keys, Pause first;
     *  else the row has them). Hidden again after a while, not while paused or nothing plays. */
    private fun showControls() {
        if (!shown || strip.visibility != View.VISIBLE) {
            pick(index)
            strip.visibility = View.VISIBLE
            strip.animate().cancel()
            strip.animate().alpha(1f).setDuration(220).start()
        }
        shown = true
        handler.removeCallbacks(hideInfo)
        info.animate().cancel()
        info.animate().alpha(1f).setDuration(200).start()
        findViewById<View>(R.id.liveCenter).visibility = if (buttonsOn) View.VISIBLE else View.GONE
        when {
            !buttonsOn -> if (!inRow) { toRow(true); rowForced = true }
            // The row only had the keys because there were no buttons (it was starting): back to them.
            rowForced -> { rowForced = false; toRow(false) }
            !inRow && findViewById<LinearLayout>(R.id.liveActions).focusedChild == null -> firstButton()?.requestFocus()
        }
        showRowKeys()
        if (stage != Stage.NOTHING && !paused) laterHide()
    }

    private fun firstButton() = listOf(actPause, actChannel, actStar).firstOrNull { it.visibility == View.VISIBLE }

    /** Back to the picture: the buttons and row go; the name too, unless a stream is starting. */
    private fun hideControls() {
        if (stage == Stage.NOTHING) return
        shown = false
        if (inRow) {
            inRow = false
            rowForced = false
            findViewById<LinearLayout>(R.id.liveActions).descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        }
        handler.removeCallbacks(hideInfo)
        findViewById<View>(R.id.liveCenter).visibility = View.GONE
        if (stage == Stage.PLAYING) {
            info.animate().cancel()
            info.animate().alpha(0f).setDuration(400).start()
        }
        strip.animate().cancel()
        strip.animate().alpha(0f).setDuration(400).withEndAction { if (!shown) strip.visibility = View.GONE }.start()
    }

    private fun laterHide() {
        handler.removeCallbacks(hideInfo)
        handler.postDelayed(hideInfo, INFO_FOR_MS)
    }

    /** The row has the keys (Down from the buttons), or the buttons again (Up; only while there are any). */
    private fun toRow(on: Boolean) {
        if (!on && !buttonsOn) return
        inRow = on
        val actions = findViewById<LinearLayout>(R.id.liveActions)
        if (on) {
            lastButton = actions.focusedChild
            actions.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
            currentFocus?.clearFocus()
        } else {
            actions.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
            (lastButton?.takeIf { it.visibility == View.VISIBLE } ?: firstButton())?.requestFocus()
        }
        pick(index)
        showRowKeys()
    }

    /** What the keys do in the row, while it has them. */
    private fun showRowKeys() {
        findViewById<TextView>(R.id.stripKeys).apply {
            text = "◀▶  Look along the row      OK  Watch" + if (buttonsOn) "      ▲  Back to the buttons" else ""
            visibility = if (inRow) View.VISIBLE else View.INVISIBLE
        }
    }

    private var lastButton: View? = null
    /** The row has the keys only because there were no buttons then (not because Down was pressed). */
    private var rowForced = false

    // ---------- Pause ----------

    private fun togglePause() {
        val p = player ?: return
        if (!buttonsOn) return
        if (p.playWhenReady) p.pause() else p.play()
        showControls()
    }

    private fun showPaused() {
        paused = player?.playWhenReady == false && buttonsOn
        findViewById<TextView>(R.id.actPauseLabel).text = if (paused) "Play" else "Pause"
        findViewById<ImageView>(R.id.actPauseIcon).setImageResource(if (paused) R.drawable.ic_play else R.drawable.ic_pause)
        if (paused) {
            findViewById<TextView>(R.id.infoState).text = "PAUSED"
            handler.removeCallbacks(hideInfo)
        } else if (buttonsOn) {
            findViewById<TextView>(R.id.infoState).text = "LIVE"
            if (shown) laterHide()
        }
    }

    // ---------- An event's channels ----------

    /** The event's channels in a panel popped up from its Channel button, the one playing ticked. */
    private fun openChannels() {
        val ch = channels.getOrNull(index) ?: return
        if (ch.channels.size < 2) return
        panelItems.removeAllViews()
        var chosen: View? = null
        ch.channels.forEach { m ->
            val v = layoutInflater.inflate(R.layout.panel_item, panelItems, false)
            v.findViewById<TextView>(R.id.tick).text = if (m.id == member) "✓" else ""
            v.findViewById<TextView>(R.id.label).text = m.name
            v.setOnClickListener {
                closeChannels()
                if (m.id == member) return@setOnClickListener
                picks.edit().putString(pickKey(ch), m.id).apply()
                play(index, m.id)
            }
            if (m.id == member) chosen = v
            panelItems.addView(v)
        }
        handler.removeCallbacks(hideInfo)
        // Just above the button, left edges lined up.
        val root = panel.parent as View
        val at = IntArray(2).also { actChannel.getLocationInWindow(it) }
        val from = IntArray(2).also { root.getLocationInWindow(it) }
        val dp = resources.displayMetrics.density
        (panel.layoutParams as android.widget.FrameLayout.LayoutParams).apply {
            leftMargin = (at[0] - from[0]).coerceAtMost(root.width - (300 * dp).toInt() - (24 * dp).toInt())
            bottomMargin = root.height - (at[1] - from[1]) + (10 * dp).toInt()
            topMargin = (28 * dp).toInt()
        }
        panel.requestLayout()
        panel.alpha = 0f
        panel.visibility = View.VISIBLE
        panel.animate().alpha(1f).setDuration(180).start()
        findViewById<android.widget.ScrollView>(R.id.panelScroll).scrollTo(0, 0)
        (chosen ?: panelItems.getChildAt(0))?.requestFocus()
    }

    private fun closeChannels() {
        panel.visibility = View.GONE
        actChannel.requestFocus()
        laterHide()
    }

    /** The channel an event's card opens on: this profile's last pick, else its first. */
    private fun memberOf(ch: Channel): String {
        if (ch.channels.size < 2) return ch.id
        val last = picks.getString(pickKey(ch), null)
        return ch.channels.firstOrNull { it.id == last }?.id ?: ch.channels[0].id
    }

    private fun pickKey(ch: Channel) = "${Profiles.current()?.id}:${ch.id}"

    private fun buildStrip() {
        findViewById<TextView>(R.id.stripTitle).text = rowTitle
        val dp = resources.displayMetrics.density
        stripItems.removeAllViews()
        channels.forEach { ch ->
            val tileView = Live.inflate(stripItems)
            tileView.isFocusable = false
            tileView.layoutParams = LinearLayout.LayoutParams((118 * dp).toInt(), LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { marginEnd = (10 * dp).toInt() }
            tileView.findViewById<View>(R.id.channelTile).layoutParams.height = (66 * dp).toInt()
            Live.bind(tileView, ch)
            tileView.findViewById<ImageView>(R.id.channelLogo).setPadding((24 * dp).toInt(), (15 * dp).toInt(), (24 * dp).toInt(), (15 * dp).toInt())
            tileView.findViewById<TextView>(R.id.channelMono).textSize = 21f
            stripItems.addView(tileView)
        }
    }

    private fun pick(i: Int) {
        picked = (i + channels.size) % channels.size
        val dp = resources.displayMetrics.density
        for (n in 0 until stripItems.childCount) {
            val v = stripItems.getChildAt(n)
            val on = n == picked
            v.isSelected = on
            // The row has the keys: the picked one lifts; else the one playing just stands out.
            Motion.focus(v, on && inRow, 1.1f)
            v.findViewById<TextView>(R.id.channelName).setTextColor(getColor(if (on) R.color.text else R.color.muted))
            v.alpha = if (on) 1f else 0.55f
        }
        findViewById<TextView>(R.id.stripTitle).text = "$rowTitle  ·  ${picked + 1} of ${channels.size}"
        val v = stripItems.getChildAt(picked) ?: return
        val scroll = {
            val x = (v.left - 120 * dp).toInt().coerceAtLeast(0)
            // Hidden: straight there (a glide only runs while it's drawn).
            if (shown) stripScroll.smoothScrollTo(x, 0) else stripScroll.scrollTo(x, 0)
        }
        // Not laid out yet (the strip's first showing): once it is.
        if (v.isLaidOut) stripScroll.post { scroll() }
        else v.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
            override fun onLayoutChange(view: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
                view.removeOnLayoutChangeListener(this)
                stripScroll.post { scroll() }
            }
        })
    }

    private fun toggleFavourite(i: Int) {
        val ch = channels[i]
        val on = !ch.favourite
        io.execute {
            val ok = Live.favourite(ch.id, on)
            handler.post {
                if (ok) {
                    channels[i] = ch.copy(favourite = on)
                    if (i == index) showFavourite(channels[i])
                    Motion.refresh(actStar)
                    stripItems.getChildAt(i)?.let { Live.bind(it, channels[i]) }
                }
                Notice.show(this, if (!ok) "Couldn't save that. Try again." else if (on) "Added to My channels" else "Taken out of My channels")
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Play on TV is asking something over the picture: its keys are its own.
        if (Sheet.open) return super.dispatchKeyEvent(event)
        val down = event.action == KeyEvent.ACTION_DOWN
        val first = down && event.repeatCount == 0
        val code = event.keyCode
        if (code == swallowed) {
            if (!down) swallowed = -1
            return true
        }
        when (code) {
            // The remote's own keys say what they do: at once.
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                if (first) {
                    val p = player
                    if (p != null && (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || p.playWhenReady != (code == KeyEvent.KEYCODE_MEDIA_PLAY))) togglePause()
                    else showControls()
                }
                return true
            }
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN -> {
                // (An open channel panel was the last one's: it goes.)
                if (first && panel.visibility == View.VISIBLE) closeChannels()
                if (first) play(index + if (code == KeyEvent.KEYCODE_CHANNEL_UP) 1 else -1)
                return true
            }
        }
        if (panel.visibility == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_BACK) {
                if (!down) closeChannels()
                return true
            }
            return super.dispatchKeyEvent(event)
        }
        if (!shown) {
            if (code == KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)
            // Hidden: a key only brings up the name, buttons and row, so nothing changes unseen.
            if (first) {
                swallowed = code
                showControls()
            }
            return true
        }
        if (stage != Stage.NOTHING && !paused) laterHide()
        if (inRow) return rowKey(event)
        when (code) {
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (first) { toRow(true); rowForced = false }
                return true
            }
            KeyEvent.KEYCODE_DPAD_UP -> return true
            KeyEvent.KEYCODE_BACK -> {
                if (!down) hideControls()
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** Keys while the row has them: Left/Right along it, OK watches one (held: My channels), Up and
     *  Back to the buttons (no buttons: Back hides the row, or leaves when there's nothing to watch). */
    private fun rowKey(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> if (down && event.repeatCount == 0) toRow(false)
            KeyEvent.KEYCODE_BACK -> {
                if (stage == Stage.NOTHING) return super.dispatchKeyEvent(event)
                if (!down) { if (buttonsOn) toRow(false) else hideControls() }
            }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (down) {
                    rowForced = false        // looking along it now: stay there when it starts
                    pick(picked + if (event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) 1 else -1)
                }
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (down) {
                    if (event.repeatCount == 0) longPressed = false
                    else if (!longPressed && event.isLongPress) {
                        longPressed = true
                        val at = picked
                        handler.removeCallbacks(hideInfo)
                        Live.myChannelsSheet(this, stripItems.getChildAt(at), channels[at]) { toggleFavourite(at) }
                    }
                } else if (longPressed) {
                    if (stage != Stage.NOTHING) laterHide()     // (the menu had the keys)
                } else if (picked != index || stage == Stage.NOTHING) {
                    // (The same one, not playing: OK tries it again.)
                    play(picked)             // (the strip follows it: play() puts it on the one playing)
                }
            }
        }
        return true
    }

    companion object {
        private const val TAG = "Nightcap"
        private const val EXTRA_CHANNELS = "channels"
        private const val EXTRA_INDEX = "index"
        private const val EXTRA_ROW = "row"
        /** A stream that hasn't started by then counts as failed: the next one is tried. */
        private const val START_WITHIN_MS = 15_000L
        private const val CALM_MS = 30_000L
        private const val INFO_FOR_MS = 4_000L
        private const val REPORT_EVERY_S = 60
        private const val MIN_REPORT_S = 5

        fun intent(context: Context, channels: List<Channel>, index: Int, row: String): Intent =
            Intent(context, LivePlayerActivity::class.java)
                .putExtra(EXTRA_CHANNELS, JSONArray(channels.map { it.toJson() }).toString())
                .putExtra(EXTRA_INDEX, index).putExtra(EXTRA_ROW, row)
    }
}
