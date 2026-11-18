package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import coil.load
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.interfaces.IMedia
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.File
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

/**
 * The Nightcap player for films and episodes. The server ranks the household's streams and
 * subtitles; this plays the best one with VLC, picks audio and subtitles from remembered
 * languages, offers every other source, track and subtitle, and saves the watch position
 * so Continue watching picks up where you left off.
 */
class WatchActivity : TvActivity() {

    private data class Stream(
        val url: String, val label: String, val detail: String, val resolution: String, val languages: List<String>,
        val bingeGroup: String?,
        /** What it's called where a name is needed: quality and language, never a file name or size. */
        val brief: String,
        /** Which add-on it came from and its file, for telling the server when it won't play. */
        val addon: String, val filename: String,
        /** The episode its file name says it is ("S2 E12") when that's another one: never tried by
         *  itself, only if you pick it. */
        val otherEpisode: String? = null,
        /** Known to be this film or episode (false: kept as a backup). */
        val verified: Boolean = true,
        /** How long its file runs when that's far from the title's length ("Runs 2 h 09 min, not 3 h
         *  15 min"): another title, a sample or a stub. Never tried by itself, only if you pick it. */
        val otherLength: String? = null,
        /** A YouTube video (its id), with no [url]: its addresses are looked up as it's played. */
        val youtube: String? = null,
        /** Its audio tracks' languages in order ("en", "hi"), read from its own header by the server
         *  when it could: the file opens straight in the wanted one ([audioOptions]). */
        val audio: List<String>? = null,
        /** Whether the service has it: false = not downloaded yet (opening it starts a download). */
        val cached: Boolean? = null,
        /** A plugin's stream (it resolves its own address, and adapts its quality). */
        val plugin: Boolean = false,
        /** A direct link: its address is passed on by the server, never followed (no call to a service). */
        val direct: Boolean = false,
        /** The service it goes through (its id), and the stream finder's type for it ("usenet"/"debrid"). */
        val service: String? = null, val kind: String? = null,
        /** The server's key for the file, and whether this household saw it gone lately: once in a day
         *  (seen: last in its group) or twice, 30 min apart (dead: after everything else). */
        val key: String? = null, val seen: Boolean = false, val dead: Boolean = false,
    ) {
        /** A file that seems not to be this one (another episode, or far from its length). */
        val suspect get() = otherEpisode != null || otherLength != null
    }
    private class NextEpisode(val id: String, val label: String, val still: String?)
    private data class Subtitle(val url: String, val lang: String, val language: String, val release: String)

    private lateinit var vlc: LibVLC
    private lateinit var player: MediaPlayer
    private lateinit var loading: View
    /** The loading screen's one calm line ("Getting it ready…"): never which source, how many, or why. */
    private lateinit var loadingStatus: TextView
    private lateinit var controls: View
    private lateinit var eyebrowView: TextView
    private lateinit var titleView: TextView
    private lateinit var subtitleView: TextView
    private lateinit var timeline: View
    private val playPause by lazy { findViewById<ImageView>(R.id.playPause) }
    private lateinit var track: View
    private lateinit var fill: View
    private lateinit var knob: View
    private lateinit var elapsed: TextView
    private lateinit var remaining: TextView
    private lateinit var endsAt: TextView
    private lateinit var note: TextView
    private lateinit var panel: View
    private lateinit var panelTitle: TextView
    private lateinit var panelItems: LinearLayout

    private val handler = Handler(Looper.getMainLooper())
    /** The player lane: every libVLC call that changes something runs here, in order. libVLC 3 holds its
     *  input lock while it stops a file (and joins its thread), and the time, length and track getters
     *  take that lock: on the main thread they could freeze the remote for seconds. */
    private val vlcThread = Executors.newSingleThreadExecutor()
    /** Stops and file changes posted to the lane and not yet done: meanwhile the screen uses the last
     *  values it read ([time], [len], [seekable]). */
    private var switching = 0
    /** The player is being let go: nothing reads it any more. */
    private var released = false
    /** Files handed to libVLC whose MediaChanged hasn't come yet: until it has, libVLC's events are the
     *  old file's (its last ones come before it) and are ignored. libVLC sends MediaChanged for every
     *  file it's given, even one that then fails to open, so the count always comes back to 0. */
    private var changesPending = 0
    /** A YouTube video's addresses are being looked up after the old file was stopped: its events are
     *  ignored until the video is handed over. */
    private var stoppedForLookup = false
    /** The last playback time read (or sought to). */
    private var shownTime = 0L

    /** Runs [block] on the player lane. [switch]: a stop or a file change (getters wait meanwhile). */
    private fun vlcDo(switch: Boolean = false, block: () -> Unit) {
        if (released) return
        if (switch) switching++
        vlcThread.execute {
            runCatching(block).onFailure { Log.w(TAG, "A player call failed", it) }
            if (switch) handler.post { switching-- }
        }
    }

    /** The playback time, or the last one read while the lane is switching files. */
    private fun time(): Long = if (switching > 0 || released) shownTime else player.time.also { shownTime = it }

    /** The file's length (from libVLC's event), or asked when the lane is free; 0 if unknown. */
    private fun len(): Long = length.takeIf { it > 0 } ?: if (switching > 0 || released) 0L else player.length

    private fun seekable() = switching == 0 && !released && player.isSeekable
    private val io = Executors.newSingleThreadExecutor()
    /** Asking for every source (and waiting for the next episode's early ask): up to a minute and a half,
     *  so on its own thread, never holding up subtitles, saves or the episode list on [io]. */
    private val moreIo = Executors.newSingleThreadExecutor()
    private val prefs by lazy { PlayerPrefs.of(this) }

    private lateinit var type: String
    private lateinit var videoId: String
    private var streams = emptyList<Stream>()
        set(value) {
            field = value
            keys = keysOf(value)
        }
    /** Each source's key, the same for the same file through the play (add-on, file name, label, and its
     *  place among identical ones): what's been tried, played, rescued and merged goes by it. */
    private var keys = emptyList<String>()
    private fun keyAt(i: Int) = keys.getOrNull(i).orEmpty()
    private fun keysOf(list: List<Stream>): List<String> {
        val seen = mutableMapOf<String, Int>()
        return list.map { s ->
            // (The server's key: the same file whatever the list's order, one per service.)
            // (Not a plugin's: its key comes from its link, which may change from one lookup to the next.)
            val base = s.key?.takeIf { !s.plugin } ?: "${s.addon}|${s.filename}|${s.label}"
            val n = (seen[base] ?: 0) + 1
            seen[base] = n
            "$base#$n"
        }
    }
    private var subtitles = emptyList<Subtitle>()
    private var current = -1
    private var failures = 0
    /** When this play stops trying: 180 s from the screen opening until the first picture, then 120 s
     *  from a failure mid-film (none while it plays). Waits for the server to wake or the connection
     *  to come back don't count. */
    private var budgetEnd = System.currentTimeMillis() + BUDGET_START_MS
    /** What the services told this play (a refusal, a busy window): see PlayOrder.Trip. */
    private val trips = mutableListOf<PlayOrder.Trip>()
    /** Files being prepared (the service is getting them): not tried again before this time (ms). */
    private val preparingAt = mutableMapOf<String, Long>()
    /** When the play answer came: a file being prepared is tried again 60 s on at the soonest. */
    private var answeredAt = 0L
    /** Whether this play already waited for the wanted language's busy or preparing file (once a play). */
    private var waitedForWant = false
    /** The source being opened has shown its picture (not merely opened: libVLC says Playing first). */
    private var started = false
    /** It has opened (libVLC's Playing), and its picture is awaited. */
    private var opened = false
    /** The first moment it reported once open, to see time move on. */
    private var firstTime = -1L
    /** Something has played in this play: from then on, waits are shown over the picture. */
    private var everStarted = false
    /** The sources that have shown their picture in this play (a dropped one is opened again first). */
    private val played = mutableSetOf<String>()
    /** The last moment that played, in whichever file: every retry, fallback and save carries on from
     *  it (never from where tonight began). A seek moves it. -1 before anything played. */
    private var lastGood = -1L
    /** Set once "Resumed at" was said, so a reconnect doesn't say it again. */
    private var resumed: Boolean? = null
    private var resumeAt = 0L
    /** How long the title should run (the server's figure; 0 if unknown), to spot a clip that isn't it. */
    private var expectedMs = 0L
    /** The online subtitle that's showing, if it's one of ours rather than one inside the file. */
    private var onlineSub: Subtitle? = null
    /** Where a Left/Right scrub is heading; the seek happens once the keys go quiet. */
    private var scrubTo: Long? = null
    private var length = 0L
    /** The length of the file that last played well: what a save measures against while another opens
     *  (an error clip tried meanwhile has its own, which would make the old place look finished). */
    private var goodLength = 0L
    /** Subtitle timing (µs), kept for the play: set again on every file that starts. */
    private var subDelayUs = 0L
    /** Online subtitles loaded into the file playing: libVLC lists them last among its own tracks. */
    private var slavesAdded = 0

    private val hideControls = Runnable { setControls(false) }
    private val commitScrub = Runnable {
        scrubTo?.let {
            vlcDo { player.setTime(it) }
            lastGood = it
            shownTime = it
        }
        scrubTo = null
        scheduleHide()
    }
    private val rescueToken = PlayerRescue.newToken()
    private val rescues by lazy { intent.getIntExtra(EXTRA_RESCUES, 0) }

    private val saveEvery = object : Runnable {
        override fun run() {
            saveProgress()
            PlayerRescue.stillPlaying(this@WatchActivity)
            handler.postDelayed(this, SAVE_EVERY_MS)
        }
    }
    /** The source you were watching when you picked another, and where: if the new one fails, back to
     *  it. [want]: the audio wanted then; [language]: the one switched to for (its name, "Hindi"), or
     *  null for a source picked by hand; [heard]: the language that was playing ("English"). */
    private class Before(val index: Int, val at: Long, val want: String? = null, val language: String? = null,
                         val heard: String? = null, val quality: String? = null, val wasQuality: String? = null,
                         /** The quality pick before (null: Auto), restored on the way back. */
                         val qualityWant: String? = null)
    private var before: Before? = null
    /** Set while going back to [Before]: what to say once it plays again (plainly, the film playing on). */
    private var wentBack: String? = null
    /** What to tell the viewer when no source would be tried by itself (the server's words). */
    private var notice: String? = null

    /** A source that hasn't started after a while is treated as failed. */
    private val stalled = Runnable { if (!started) failed("didn't start in ${START_TIMEOUT_MS / 1000} s") }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_watch)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Stream preferences learned by an early build (now left to profile settings): forget them.
        if (prefs.contains("preferStreamLanguage") || prefs.contains("preferResolution")) {
            prefs.edit().remove("preferStreamLanguage").remove("preferResolution").remove(PREF_AUDIO).apply()
        }
        // Only Nightcap opens the player, but an intent without what to play just closes it.
        val type = intent.getStringExtra(EXTRA_TYPE)?.takeIf { it == "movie" || it == "series" }
        val videoId = intent.getStringExtra(EXTRA_ID)?.takeIf { VIDEO_ID.matches(it) }
        if (type == null || videoId == null) {
            Log.w(TAG, "Player opened without a title to play")
            return finish()
        }
        this.type = type
        this.videoId = videoId
        source = PlaySource.from(intent)
        // The viewer's picks from the episode before (or the player before a crash).
        pickState = intent.getStringExtra(EXTRA_AUDIO_PICK)
        subsPick = intent.getStringExtra(EXTRA_SUBS)
        audioWant = pickState?.takeIf { it.isNotEmpty() }
        qualityWant = intent.getStringExtra(EXTRA_QUALITY)
        wantMissing = intent.getStringExtra(EXTRA_WANT_MISSING)
        lineSaid = intent.getStringExtra(EXTRA_LINE_SAID) == "1"
        carriedTrack = intent.getStringExtra(EXTRA_TRACK)

        loading = findViewById(R.id.loading)
        loadingStatus = findViewById(R.id.loadingStatus)
        controls = findViewById(R.id.controls)
        eyebrowView = findViewById(R.id.eyebrow)
        titleView = findViewById(R.id.title)
        subtitleView = findViewById(R.id.subtitle)
        timeline = findViewById(R.id.timeline)
        track = findViewById(R.id.track)
        fill = findViewById(R.id.fill)
        knob = findViewById(R.id.knob)
        elapsed = findViewById(R.id.elapsed)
        remaining = findViewById(R.id.remaining)
        endsAt = findViewById(R.id.endsAt)
        note = findViewById(R.id.note)
        panel = findViewById(R.id.panel)
        panelTitle = findViewById(R.id.panelTitle)
        panelItems = findViewById(R.id.panelItems)

        val name = intent.getStringExtra(EXTRA_NAME).orEmpty()
        val episode = intent.getStringExtra(EXTRA_EPISODE)
        findViewById<ImageView>(R.id.loadingArt).load(intent.getStringExtra(EXTRA_ART))
        findViewById<TextView>(R.id.loadingTitle).text = name
        findViewById<TextView>(R.id.loadingEpisode).apply {
            text = episode
            visibility = if (episode.isNullOrBlank()) View.GONE else View.VISIBLE
        }
        // An episode: the show and its number above the episode's name ("S2 E7  ·  Name").
        val number = episode?.substringBefore("  ·  ", "")?.takeIf { it.isNotBlank() }
        eyebrowView.text = listOfNotNull(name, number).joinToString("  ·  ")
        eyebrowView.visibility = if (episode.isNullOrBlank()) View.GONE else View.VISIBLE
        titleView.text = episode?.substringAfter("  ·  ")?.takeIf { it.isNotBlank() } ?: name
        say(GETTING_READY)

        findViewById<View>(R.id.chipAudio).setOnClickListener { showAudio() }
        findViewById<View>(R.id.chipSubtitles).setOnClickListener { showSubtitles() }
        findViewById<View>(R.id.chipQuality).setOnClickListener { showQuality() }
        findViewById<View>(R.id.chipPicture).setOnClickListener { showPicture() }
        findViewById<View>(R.id.chipEpisodes).apply {
            visibility = if (type == "series" && videoId.count { it == ':' } == 2) View.VISIBLE else View.GONE
            setOnClickListener { showEpisodes() }
        }
        // Skipping ahead mid-episode: this one keeps its place (it isn't marked watched).
        findViewById<View>(R.id.chipNext).setOnClickListener { playNext(finished = inCredits()) }
        // Down from the timeline lands on Subtitles, as it does when the controls are hidden.
        timeline.nextFocusDownId = R.id.chipSubtitles
        // The round play/pause button beside the timeline: OK plays or pauses; Right is the timeline (whose
        // Left scrubs), Down and Up go between it and Audio below it.
        playPause.setOnClickListener { togglePause() }
        playPause.nextFocusRightId = R.id.timeline
        playPause.nextFocusDownId = R.id.chipAudio
        findViewById<View>(R.id.chipAudio).nextFocusUpId = R.id.playPause
        // The playhead shows while you're on the timeline.
        timeline.setOnFocusChangeListener { _, has -> knob.animate().alpha(if (has) 1f else 0f).setDuration(160).start() }

        vlc = LibVLC(this, arrayListOf("--network-caching=4000", "--http-reconnect", "--audio-time-stretch",
            // (Its usual name, stated, so a check of a file's address from the TV can say the same.)
            "--http-user-agent=$PLAYER_AGENT"))
        player = MediaPlayer(vlc)
        // A SurfaceView (not a TextureView) so HDR and Dolby Vision reach the panel untouched.
        player.attachViews(findViewById<VLCVideoLayout>(R.id.video), null, true, false)
        player.setEventListener(::onPlayerEvent)
        handler.postDelayed(almostThere, ALMOST_AFTER_MS)
        load()
    }

    private fun load() = io.execute {
        // The release the previous episode played, so a season keeps the same quality and audio.
        // (A reload after the links expired asks for every source again when this play had them all.)
        val path = playPath(type, videoId, intent.getStringExtra(EXTRA_BINGE), pickState) +
            if (carryOn != null && askedMore) "&more=1" else ""
        // Fetched while the last episode was ending, if it was; otherwise asked for now.
        // (A reload after the links expired is this episode's own: the next one's early ask stays.)
        val taken = if (carryOn == null) NextUp.take(path) else null
        val result = taken?.let { Result.success(it.answer) } ?: runCatching { fetchPlay(path) }
        handler.post {
            if (isFinishing) return@post
            val json = result.getOrNull()
            if (json == null || json.has("error")) {
                Log.w(TAG, "No streams for $videoId", result.exceptionOrNull())
                return@post giveUp("Couldn't find sources right now. Try again in a moment.")
            }
            // A film that isn't out yet: the server looked for nothing (what turns up is another title).
            if (json.has("releases")) {
                val date = niceDate(json.optString("releases"))
                return@post giveUp(if (date != null) "Not out yet. Comes out $date" else "Not out yet")
            }
            streams = parseStreams(json)
            answeredAt = System.currentTimeMillis()
            // (A fresh answer while it's looking for more keeps the row's state; the look's answer replaces it.)
            if (more != MoreSources.LOOKING) more = if (json.optBoolean("moreSources")) MoreSources.OFFERED else MoreSources.NONE
            // Every source was already being asked for, ahead of time, with this episode: merged when it comes.
            taken?.more?.let { coming ->
                if (more == MoreSources.OFFERED) {
                    more = MoreSources.LOOKING
                    askedMore = true
                    moreIo.execute {
                        val m = runCatching { coming.get(NEXT_MORE_WAIT_S, java.util.concurrent.TimeUnit.SECONDS) }.getOrNull()
                        handler.post {
                            if (isFinishing) return@post
                            moreCame(m)
                            // (Every source in, still without the picked language: not asked for again this binge.)
                            audioWant?.let { want -> if (more == MoreSources.NONE && streams.indices.none { speaks(it, want) }) wantMissing = want }
                        }
                    }
                }
            }
            subtitles = (json.optJSONArray("subtitles") ?: JSONArray()).let { a ->
                (0 until a.length()).mapNotNull { a.optJSONObject(it) }.mapNotNull { runCatching {
                    Subtitle(it.getString("url"), it.getString("lang"), it.getString("language"), it.optString("release"))
                }.getOrNull() }
            }
            resumeAt = json.optLong("resume")
            linksExpireAt = json.optLong("linksExpireAt")
            expectedMs = json.optLong("runtimeMs")
            notice = json.text("notice")
            // The profile's audio language (the server's, as it ranked by it), then the title's own: what
            // each file is opened in, until one is picked in the player.
            profileAudio = listOfNotNull(json.text("audioLanguage"), json.text("originalLanguage")).distinct()
            // The language picked for this title before (a play with none carried over): wanted again.
            // (The same for subtitles.)
            if (subsPick == null) subsPick = json.text("titleSubtitles")
            if (pickState == null) json.text("titleAudio")?.let { saved ->
                pickState = saved
                audioWant = saved
            }
            myRating = if (json.isNull("myRating")) null else json.optInt("myRating")
            asked = json.optJSONArray("asked")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }.orEmpty()
            finishedEpisodes = json.optInt("finishedEpisodes")
            nextEpisode = json.optJSONObject("next")?.let {
                runCatching { NextEpisode(it.getString("id"), "${it.optString("episode")}  ·  ${it.optString("name")}", it.text("thumbnail")) }.getOrNull()
            }
            findViewById<View>(R.id.chipNext).visibility = if (nextEpisode != null) View.VISIBLE else View.GONE
            // New links after the old ones expired: the same source again (or the one in its place), from where it was.
            carryOn?.let { (key, index, at) ->
                carryOn = null
                // (The same file by its key; gone from the new list: the next by the usual order, never
                // whatever sits at the same place.)
                val same = keys.indexOf(key).takeIf { it >= 0 } ?: nextToTry()
                if (same >= 0) return@post play(same, at)
            }
            if (streams.isEmpty()) return@post nothingToPlay()
            // Only files for other episodes turned up: say so here rather than play the wrong one
            // (Back leaves; one can still be picked from the Source list once something plays).
            // Back after a crash: the files it had tried aren't tried again; the one that was playing, first.
            intent.getStringExtra(EXTRA_RESCUE_TRIED)?.split('\n')?.filter { it.isNotEmpty() }?.let { tried += it }
            preparing = Preparing.key(videoId)
            val first = nextToTry(intent.getStringExtra(EXTRA_RESCUE_FIRST) ?: preparing)
            if (first < 0) return@post nothingToPlay()
            // The wanted language isn't among these files: more are asked for straight away.
            audioWant?.let { want -> if (wantMissing != want && streams.indices.none { speaks(it, want) }) lookForMoreQuietly {
                if (more == MoreSources.NONE && streams.indices.none { speaks(it, want) }) wantMissing = want
            } }
            // Back after the player crashed: carry on from the source it got to.
            // (A file asked for first, after a crash or one being prepared, is kept.)
            val asked = intent.getStringExtra(EXTRA_RESCUE_FIRST) ?: preparing
            play((if (asked == null) deadWantInstead(first) else null) ?: first, resumeAt)
        }
    }

    /** The play answer's sources. One the player can't use (no address) is left out, not a reason to stop. */
    private fun parseStreams(json: JSONObject): List<Stream> =
        (json.optJSONArray("streams") ?: JSONArray()).let { a ->
        (0 until a.length()).mapNotNull { a.optJSONObject(it) }.mapNotNull { s -> runCatching {
            val langs = s.optJSONArray("languages")?.let { l -> (0 until l.length()).map { l.getString(it) } }.orEmpty()
            val hdr = s.optJSONArray("hdr")?.let { h -> (0 until h.length()).map { h.getString(it) } }.orEmpty()
            val spoken = if (langs.isEmpty() || langs == listOf("en")) null
            else langs.joinToString(" + ") { SPOKEN[it] ?: it.uppercase() }
            // Top line: what you'd choose by (quality, language); below: the finer print.
            val headline = listOfNotNull(s.text("resolution"), *hdr.toTypedArray(), s.text("source"), spoken)
            // Where it comes from and the finer print: only shown on the highlighted row.
            val ready = if (s.isNull("cached")) null else if (s.optBoolean("cached")) "Ready" else "Not ready"
            val service = s.text("serviceName") ?: s.text("service")?.replaceFirstChar { it.uppercase() }
            // (A YouTube video has its id in place of an address; one that isn't an id is left out.)
            val youtube = s.text("youtube")?.takeIf { YOUTUBE_ID.matches(it) }
            Stream(if (youtube != null) "" else s.getString("url"),
                headline.joinToString("  ·  ").ifBlank {
                    // (A plugin's stream adapts to the connection, and says no quality of its own.)
                    if (s.optBoolean("plugin")) "Auto quality" else s.optString("filename")
                },
                listOfNotNull(s.text("addon"), s.text("via"), service, ready, s.text("video"), s.text("audio"))
                    .joinToString("  ·  "),
                s.optString("resolution"), langs, s.text("bingeGroup"),
                // (With no quality, source or language to go by: the add-on's name for a plugin's, else the file's.)
                (listOfNotNull(s.text("resolution"), s.text("source"), spoken).ifEmpty {
                    listOfNotNull(if (s.optBoolean("plugin")) s.text("addon") else s.text("filename")?.take(40))
                }).joinToString("  ·  "),
                s.optString("addon"), s.optString("filename"), s.text("otherEpisode"),
                verified = s.optBoolean("verified", true), otherLength = s.text("otherLength"), youtube = youtube,
                audio = s.optJSONArray("fileAudio")?.let { a -> (0 until a.length()).map { a.getString(it) } },
                cached = if (s.isNull("cached") || !s.has("cached")) null else s.optBoolean("cached"),
                plugin = s.optBoolean("plugin"), direct = s.optBoolean("direct"),
                service = s.text("service"), kind = s.text("kind"),
                key = s.text("key"), seen = s.optBoolean("seen"), dead = s.optBoolean("dead"))
        }.onFailure { Log.w(TAG, "Skipping a source the player can't use", it) }.getOrNull() }
    }

    /** Looking for more sources (by itself, when every one tried failed): there are more to ask
     *  (the plugins, the extra add-ons' unused answers), it's asking, or there are none. */
    private enum class MoreSources { NONE, OFFERED, LOOKING }
    private var more = MoreSources.NONE

    /** The sources tried this play (add-on, file and label), so asking for more tries only new ones. */
    private val tried = mutableSetOf<String>()
    /** Whether this play already asked for every source by itself (once, when all it had failed). */
    private var askedMore = false

    /** Every source tried failed (or there were none): if the server has more to ask (the extra
     *  add-ons and plugins a play leaves out at first), they're asked for, and the new ones tried
     *  from [at], before saying it couldn't play. Once per play. */
    private fun moreOrGiveUp(at: Long) {
        // (Nothing more to ask, or asked and answered: the end. Still being asked: its answer is waited for.)
        if (more == MoreSources.NONE || (more == MoreSources.OFFERED && askedMore)) return outOfFiles()
        askedMore = true
        showLoading()
        // (The same calm line: looking for more is the player's business, not the viewer's.)
        say(if (everStarted) RECONNECTING else GETTING_READY)
        lookForMore {
            val next = nextToTry()
            if (next < 0) return@lookForMore outOfFiles()
            failures = 0
            play(next, at)
        }
    }

    /** More sources asked for in the background (few left, the wanted language missing, Audio opened):
     *  merged when they come, nothing stopped. Once per play. */
    private fun lookForMoreQuietly(then: () -> Unit = {}) {
        if (more != MoreSources.OFFERED || askedMore) return
        askedMore = true
        lookForMore { then() }
    }

    /**
     * Nothing left to try. Not-downloaded files left: one is started (its link asked once, which is
     * what starts the service's download; it's played if it turns out ready) and the viewer
     * is told it's being prepared; the next open of this title tries it first. Otherwise the plain
     * words.
     */
    private fun outOfFiles() {
        // (Every source still being asked for: its answer first.)
        if (more == MoreSources.LOOKING) return lookForMore { if (nextToTry() >= 0) play(nextToTry(), resumeFrom()) else outOfFiles() }
        // Only files named as other episodes: asked whether to play one anyway (a name can be wrong);
        // once said yes, the next of them in turn.
        otherEpisodeLeft()?.let { i ->
            if (otherOk) return play(i, resumeFrom())
            if (!otherAsked && !everStarted) return askOtherEpisode()
        }
        if (streams.isEmpty() || streams.none { !it.suspect }) return giveUp(notice ?: NOTHING_YET)
        // Only busy or being-prepared files left: their time waited for, when it fits in what's left.
        PlayOrder.soonest(orderFiles(), skip())?.let { soon ->
            val now = System.currentTimeMillis()
            if (maxOf(soon, now) + PlayOrder.TRY_MS <= budgetEnd) return waitThen(soon - now)
        }
        // The best file skipped for its silent host, now that nothing else is left: opened without the
        // look, with libVLC's 30 s (some hosts are just slow to start). One a round, while time is left.
        silentToOpen()?.let { key ->
            silentSkipped.clear()
            openAnyway = key
            showLoading()
            return play(keys.indexOf(key), resumeFrom())
        }
        // Ended by a cap (the calls to services, the time) while files that could play are left: nothing is
        // started; plain words.
        if (nextToTry(capped = false) >= 0) return giveUp(COULDNT_PLAY)
        // The file whose download was started last time still isn't ready: still being prepared (no
        // other download is started for it).
        preparing?.takeIf { it in tried }?.let {
            Preparing.remember(videoId, it)
            return giveUp(BEING_PREPARED)
        }
        // Every file left was refused by its streaming account, or its service is busy: said so.
        when (PlayOrder.ending(orderFiles(), tried)) {
            PlayOrder.Ending.ACCOUNT -> return giveUp(ACCOUNT_PROBLEM)
            PlayOrder.Ending.BUSY -> return giveUp(TOO_MANY_REQUESTS)
            else -> {}
        }
        if (preparedOnce || PlayOrder.ending(orderFiles(), tried) != PlayOrder.Ending.PREPARE) return giveUp(COULDNT_PLAY)
        preparedOnce = true
        val waiting = streams.indices.firstOrNull { streams[it].let { s -> s.cached == false && !s.suspect && s.url.isNotEmpty() } && keyAt(it) !in tried }
            ?: return giveUp(COULDNT_PLAY)
        showLoading()
        say(if (everStarted) RECONNECTING else GETTING_READY)
        val attempt = ++opening
        val key = keyAt(waiting)
        val link = streams[waiting].url
        Thread {
            val where = whereItLeads(link, attempt)
            handler.post {
                if (isFinishing || attempt != opening) return@post
                // (The list may have changed meanwhile: the same file, by its key.)
                val now = keys.indexOf(key)
                val at = where.where
                if (now >= 0 && at is Where.At) return@post play(now, resumeFrom(), at.url)
                Preparing.remember(videoId, key)
                giveUp(BEING_PREPARED)
            }
        }.start()
    }

    /** The first file named as another episode that hasn't been tried (downloaded, openable), when
     *  nothing else is left; or null. */
    private fun otherEpisodeLeft(): Int? {
        // (The right episode's file skipped for its silent host goes first.)
        if (silentToOpen()?.let { !streams[keys.indexOf(it)].suspect } == true) return null
        if (streams.any { !it.suspect } && nextToTry(capped = false) >= 0) return null
        if (streams.indices.any { !streams[it].suspect && keyAt(it) !in tried }) return null
        return streams.indices.firstOrNull { i -> streams[i].let { s -> s.otherEpisode != null && s.cached != false &&
            (s.youtube != null || s.url.isNotEmpty()) } && keyAt(i) !in tried }
    }

    /** Whether "Play one anyway?" was asked, and answered Play, this play. */
    private var otherAsked = false
    private var otherOk = false

    /** "Only other episodes were found. Play one anyway?": Play tries them; Back leaves. */
    private fun askOtherEpisode() {
        otherAsked = true
        askingCard = true
        panel.visibility = View.GONE
        findViewById<TextView>(R.id.exitTitle).apply { text = OTHER_EPISODES; maxLines = 2 }
        findViewById<View>(R.id.exitHint).visibility = View.GONE
        val choices = findViewById<LinearLayout>(R.id.exitChoices).apply { removeAllViews() }
        val playIt = choice(choices, R.drawable.ic_pl_play, "Play") {
            closeOtherCard()
            otherOk = true
            showLoading()
            say(GETTING_READY)
            outOfFiles()
        }
        choice(choices, R.drawable.ic_act_close, "Back") { closeOtherCard(); finish() }
        exitCard.alpha = 0f
        exitCard.visibility = View.VISIBLE
        exitCard.animate().alpha(1f).setDuration(200).start()
        focusChoice(playIt)
    }

    private var askingCard = false

    /** "Couldn't play this right now." with Keep trying (2 more minutes, every file that may have
     *  failed by chance tried again) or Back. */
    private fun askKeepTrying() {
        askingCard = true
        panel.visibility = View.GONE
        handler.removeCallbacks(stalled)
        // (Whatever was opening or waiting stops: nothing plays, or is tried, behind the card.)
        ++opening
        stoppedForLookup = true
        vlcDo(switch = true) { player.stop() }
        findViewById<TextView>(R.id.exitTitle).apply { text = COULDNT_PLAY_NOW; maxLines = 2 }
        findViewById<View>(R.id.exitHint).visibility = View.GONE
        val choices = findViewById<LinearLayout>(R.id.exitChoices).apply { removeAllViews() }
        val again = choice(choices, R.drawable.ic_pl_play, "Keep trying") {
            closeOtherCard()
            keepTrying()
        }
        choice(choices, R.drawable.ic_act_close, "Back") { closeOtherCard(); finish() }
        exitCard.alpha = 0f
        exitCard.visibility = View.VISIBLE
        exitCard.animate().alpha(1f).setDuration(200).start()
        focusChoice(again)
    }

    /** Another go: 2 more minutes; the files the server or the TV found gone, refused, or left by the
     *  viewer stay out, every other one may be tried again. */
    private fun keepTrying() {
        budgetEnd = System.currentTimeMillis() + BUDGET_AFTER_MS
        tried.retainAll(ruledOut + rejected)
        silentSkipped.clear()
        openAnyway = null
        failedAt.clear()
        followedOpens = 0
        reconnects = 0
        waitedForWant = false
        showLoading()
        say(if (everStarted) RECONNECTING else GETTING_READY)
        val next = nextToTry()
        if (next >= 0) play(next, resumeFrom()) else moreOrGiveUp(resumeFrom())
    }

    /** Whether another go could try anything: a file not ruled out, or more sources to ask. */
    private fun canKeepTrying() = more == MoreSources.OFFERED && !askedMore ||
        PlayOrder.next(orderFiles(), ruledOut + rejected, audioWant, qualityWant, profileAudio.lastOrNull(),
            now = System.currentTimeMillis() + BUDGET_AFTER_MS - PlayOrder.TRY_MS) >= 0

    /** Files ruled out this play (gone, refused, their address dead): never tried again, even on Keep trying. */
    private val ruledOut = mutableSetOf<String>()

    /** Files skipped this round because their host sent nothing in 8 s; opened anyway once nothing else
     *  is left ([openAnyway]: the one being opened so, without the look). */
    private val silentSkipped = mutableSetOf<String>()
    private var openAnyway: String? = null

    /** The best file skipped for its silent host this round, if it's still here and there's time for it. */
    private fun silentToOpen() = silentSkipped.firstOrNull { it !in ruledOut && keys.indexOf(it) >= 0 }
        ?.takeIf { System.currentTimeMillis() + START_TIMEOUT_MS <= budgetEnd }

    private fun closeOtherCard() {
        askingCard = false
        exitCard.visibility = View.GONE
    }

    /** A not-downloaded file was started this play (once per play). */
    private var preparedOnce = false
    /** The file whose download was started on an earlier open of this title (tried first), if any. */
    private var preparing: String? = null

    /** Asks the server for every source (once per play), and merges the answer into the list
     *  without stopping what's playing: it carries on as the same source in the new list. [then]:
     *  how many were added. */
    private fun lookForMore(then: (added: Int) -> Unit) {
        // (Already being asked: this waits for that answer too.)
        if (more == MoreSources.LOOKING) return run { moreWaiters += then }
        if (more != MoreSources.OFFERED) return then(0)
        more = MoreSources.LOOKING
        moreWaiters += then
        val path = playPath(type, videoId, intent.getStringExtra(EXTRA_BINGE), pickState) + "&more=1"
        moreIo.execute {
            val json = runCatching { fetchPlay(path) }.onFailure { Log.w(TAG, "More sources unavailable", it) }.getOrNull()
            handler.post { if (!isFinishing) moreCame(json) }
        }
    }

    /** Every source arrived ([json], or null when it couldn't be asked): merged into the list without
     *  stopping what's playing, and whoever was waiting for it is told how many were added. */
    private fun moreCame(json: JSONObject?) {
        fun done(added: Int) {
            val waiters = moreWaiters.toList()
            moreWaiters.clear()
            waiters.forEach { it(added) }
            // (The wanted language may have come with them.)
            handler.post(checkAudio)
        }
        if (json == null || json.has("error")) {
            more = MoreSources.OFFERED
            return done(0)
        }
        more = MoreSources.NONE
        val fresh = parseStreams(json)
        val added = fresh.size - streams.size
        if (added <= 0) return done(0)
        // (Whether the wanted language could be had before these came.)
        val wantBefore = audioWant?.let { w -> hasWant(w) }
        // The same source in the new list: by add-on and file name (and which of several alike).
        val old = streams
        // (By the same keys as everything else: one per file, and per service.)
        val oldKeys = keysOf(old)
        val freshKeys = keysOf(fresh)
        fun place(i: Int): Int = oldKeys.getOrNull(i)?.let { freshKeys.indexOf(it) } ?: -1
        val now = place(current)
        val back = before?.let { b -> place(b.index).takeIf { it >= 0 }?.let { Before(it, b.at, b.want, b.language, b.heard, b.quality, b.wasQuality, b.qualityWant) } }
        // (Should the one playing not be there, it's kept, last, so nothing changes under it.)
        streams = if (now >= 0 || current < 0) fresh else fresh + streams[current]
        current = if (now >= 0 || current < 0) now else streams.lastIndex
        before = back
        val expires = json.optLong("linksExpireAt")
        if (expires > 0) linksExpireAt = if (linksExpireAt > 0) minOf(linksExpireAt, expires) else expires
        if (started) noteRescue(crashedOpening = false)
        // New files to try: the failures in a row so far were the old ones'; they don't hold these back.
        failures = 0
        // The wanted language came with them while another plays: it's in Audio now, and said so (once).
        audioWant?.let { w ->
            if (started && wantBefore == false && hasWant(w) && heardCode() != w) sayAvailable(w)
        }
        done(added)
    }

    private val moreWaiters = mutableListOf<(Int) -> Unit>()

    /** The audio languages other files the player could switch to now name (Audio lists them): not
     *  one refused by its account, busy or being prepared. */
    private fun languagesElsewhere(except: Set<String> = emptySet()): List<String> =
        switchable(except).flatMap { streams[it].audio ?: streams[it].languages }.distinct()

    /** The other files the player could switch to now: not another's, downloaded, not failed or left
     *  this play, not refused by their account, busy or being prepared. (Audio's list and a language
     *  pick go by the same set.) */
    private fun switchable(except: Set<String> = emptySet()): List<Int> {
        val order = orderFiles()
        val now = System.currentTimeMillis()
        return streams.indices.filter { i -> streams[i].let { s -> i != current && !s.suspect && s.cached != false &&
            s.youtube == null && s.url.isNotEmpty() } && keyAt(i) !in (tried - played) + ruledOut + rejected + except &&
            order[i].let { f -> !f.skipped && (f.busyUntil ?: 0) <= now && (f.preparingUntil ?: 0) <= now } }
    }

    /** Whether Audio lists [want] from another file. */
    private fun hasWant(want: String) =
        // (Not from one that broke this play, even after it had played.)
        SPOKEN.containsKey(want) && want in languagesElsewhere(except = broke)

    /** Files that failed this play, at any point. */
    private val broke = mutableSetOf<String>()

    /** "Hindi audio is available now" was said this play (then no "isn't available" after it). */
    private var availableSaid = false

    /** Says the wanted language is in Audio now, once a play. */
    private fun sayAvailable(want: String) {
        if (availableSaid) return
        availableSaid = true
        wantMissing = null
        showNote("${SPOKEN[want] ?: want} audio is available now", BACK_NOTE_MS)
    }

    /** When the server's playback links in this answer stop working (it gives new ones when asked again). */
    private var linksExpireAt = 0L
    /** Carrying on after they expired: the source that was playing (its key), its place, and where. */
    private var carryOn: Triple<String, Int, Long>? = null

    /** No source is left to try: plain words on the loading screen, never why. */
    private fun nothingToPlay() {
        // (The server has more to ask: those first, before saying there's nothing.)
        if (more == MoreSources.OFFERED && !askedMore) return moreOrGiveUp(resumeAt)
        outOfFiles()
    }

    /** The next source to try (PlayOrder), or -1: the picked language and quality first, never one
     *  tried this play, another's file or one not downloaded. [first]: a key to try before anything else. */
    private fun nextToTry(first: String? = null, capped: Boolean = true): Int =
        PlayOrder.next(orderFiles(), skip(capped), audioWant, qualityWant, profileAudio.lastOrNull(),
            allowed = setOfNotNull(first), first = first, now = System.currentTimeMillis())

    /** The files not to try now: those tried, and at the cap every followed one (direct files,
     *  plugins and YouTube go on). */
    private fun skip(capped: Boolean = true) = if (capped && followedOpens >= MAX_FOLLOWED_OPENS)
        tried + streams.indices.filter { followed(it) }.map(::keyAt) else tried

    /** A source whose link the server follows (a call to a service), unlike a direct file, a plugin's or YouTube. */
    private fun followed(i: Int) = streams[i].let { !it.direct && !it.plugin && it.youtube == null }

    /** The play answer's sources as the order sees them. */
    private fun orderFiles(): List<PlayOrder.File> {
        val now = System.currentTimeMillis()
        // (A busy window that has ended: its files are tried in their places again.)
        val live = trips.filter { it !is PlayOrder.Trip.Busy || it.until > now }
        return PlayOrder.apply(streams.mapIndexed { i, s ->
            PlayOrder.File(keyAt(i), s.verified, s.suspect, s.cached == false, s.youtube != null || s.url.isNotEmpty(),
                s.audio ?: s.languages, s.audio != null, s.resolution, s.service, s.kind, seen = s.seen,
                // (Its time come: tried in its place again, the wanted language first.)
                preparingUntil = preparingAt[keyAt(i)]?.takeIf { it > now }, dead = s.dead)
        }, live)
    }

    /** The audio language wanted now: picked in the player, else the one playing, else the profile's. */
    private fun languageNow() = audioWant ?: heardCode() ?: profileAudio.firstOrNull()

    /** Whether source [i] has [lang]: by its own header when the server read it, else by its name
     *  (one that names none is taken to be in English or the title's own language): PlayOrder's rule. */
    private fun speaks(i: Int, lang: String?) = PlayOrder.speaks(orderFiles()[i], lang, profileAudio.lastOrNull())

    /** Plays source [index] from [at]. [address]: where its link leads, already asked (a reconnect,
     *  see [reconnect]); otherwise libVLC opens its link itself. */
    private fun play(index: Int, at: Long, address: String? = null, timeout: Long = START_TIMEOUT_MS) {
        startTimeout = timeout
        if (index != current) {
            reconnects = 0
            // (A file's own track order: the wanted language's place in this one is worked out again.)
            if (current >= 0) pickedTrack = null
        }
        current = index
        tried += keyAt(index)
        // (A followed link costs a call to a service: at most so many per play.)
        if (followed(index)) followedOpens++
        // (Where this source is up to comes from its own playing, not the last one's.)
        lastTime = -1
        // Should libVLC crash before this one starts, it isn't tried again.
        noteRescue(crashedOpening = true)
        started = false
        opened = false
        // (Time moving on is counted from this file's own first tick.)
        firstTime = -1
        subsPicked = false
        // (This file's own length, once libVLC says it; its online subtitles, once loaded.)
        length = 0L
        slavesAdded = 0
        onlineSub = null
        val s = streams[index]
        Log.i(TAG, "Opening source ${index + 1} of ${streams.size} from ${at / 1000} s")
        // (Its quality and language under the title: never a file's name.)
        subtitleView.text = s.label.takeUnless { it == s.filename }.orEmpty()
        val attempt = ++opening
        handler.removeCallbacks(stalled)
        handler.postDelayed(stalled, START_TIMEOUT_MS)
        val video = s.youtube
        if (video == null) {
            if (address != null || !asksFirst(s)) return open(index, address ?: s.url, null, at)
            // Where its link leads is asked first (X-Where), so a file that's gone, busy or being
            // prepared is told in a second, not in libVLC's 30. What was playing stops meanwhile.
            stoppedForLookup = true
            handler.removeCallbacks(stalled)
            vlcDo(switch = true) { player.stop() }
            Thread {
                val asked = whereItLeads(s.url, attempt)
                handler.post { if (!isFinishing && attempt == opening) whereCame(asked, at, fromPlay = true) }
            }.start()
            return
        }
        // A YouTube video: its picture's and sound's addresses are looked up here, on the TV's own
        // connection, as trailers' are (within the same wait to start). What was playing stops meanwhile.
        stoppedForLookup = true
        val key = keyAt(index)
        vlcDo(switch = true) { player.stop() }
        Trailers.resolve(video) { found ->
            // (Another source was asked for meanwhile, or the player closed.)
            if (isFinishing || attempt != opening) return@resolve
            // (A build without trailers can't open it: on to the next source, not counted against it.)
            if (found == null) return@resolve if (Trailers.available) failed("couldn't be found on YouTube")
                else failed("can't be opened by this build", retry = false, report = false, network = false)
            // (The same video by its key: more sources may have been merged meanwhile.)
            val now = keys.indexOf(key).takeIf { it >= 0 } ?: return@resolve failed("couldn't be found on YouTube")
            open(now, found.video, found.audio, at)
        }
    }

    /** Followed links opened this play, retries included. */
    private var followedOpens = 0

    /** Which play() call is the latest, so a lookup (YouTube, a link's address) that ends after
     *  another began is ignored. */
    @Volatile private var opening = 0

    private fun open(index: Int, url: String, audio: String?, at: Long) {
        val media = Media(vlc, Uri.parse(url)).apply {
            setHWDecoderEnabled(true, false)
            if (at > START_GRACE_MS) addOption(":start-time=${at / 1000.0}")
            // YouTube sends the picture and the sound separately.
            if (audio != null) addSlave(IMedia.Slave(IMedia.Slave.Type.Audio, 4, audio))
            else audioOptions(index).forEach(::addOption)
        }
        val attempt = opening
        val timeout = startTimeout
        // (Through the player lane, in order; the screen keeps its last values meanwhile. The file's own
        // events are listened to from its MediaChanged on; its time to start counts from play().)
        stoppedForLookup = false
        changesPending++
        vlcDo(switch = true) {
            player.media = media
            media.release()
            player.play()
            handler.post {
                if (attempt != opening || isFinishing) return@post
                handler.removeCallbacks(stalled)
                handler.postDelayed(stalled, timeout)
            }
        }
    }

    /** How long the file being opened has to start (a viewer's pick: shorter, its address was just checked). */
    private var startTimeout = START_TIMEOUT_MS

    /**
     * How a file is opened in the wanted audio language, so nothing is switched once it plays: its
     * track by number when its own header said which is which (the server read it; a Hindi track
     * that only its name calls Hindi, libVLC would take for English), otherwise by language, the
     * wanted one first, then the title's own (libVLC keeps the file's default when none is there).
     */
    private fun audioOptions(index: Int): List<String> {
        val s = streams[index]
        val want = listOfNotNull(audioWant) + profileAudio
        if (want.isEmpty()) return emptyList()
        // The same file again (a reconnect): the very track that was playing.
        val track = pickedTrack?.takeIf { it.first == keyAt(index) }?.second
            ?: carriedTrack?.takeIf { s.bingeGroup != null && it.substringBeforeLast('|') == s.bingeGroup }
                ?.substringAfterLast('|')?.toIntOrNull()
            ?: s.audio?.indexOf(want.first())?.takeIf { it >= 0 }
        val codes = want.flatMap { listOfNotNull(it, THREE[it]) }.distinct().joinToString(",")
        return listOfNotNull(track?.let { ":audio-track=$it" }, ":audio-language=$codes")
    }

    /** A YouTube video that was playing stopped with an error: its addresses may have expired (they
     *  last a few hours). Looked up afresh and played on from where it was, a few times at most. */
    private fun youtubeAgain(): Boolean {
        val s = streams.getOrNull(current) ?: return false
        val video = s.youtube ?: return false
        if (!playedHere() || reconnects >= MAX_RECONNECTS) return false
        reconnects++
        Trailers.forget(video)
        showLoading()
        say(RECONNECTING)
        play(current, resumeFrom())
        return true
    }

    private fun onPlayerEvent(event: MediaPlayer.Event) {
        if (released) return
        // The old file's last events, after a new one was handed over: not this file's.
        if (event.type == MediaPlayer.Event.MediaChanged) {
            if (changesPending > 0) changesPending--
            return
        }
        if (changesPending > 0 || stoppedForLookup) return
        when (event.type) {
            MediaPlayer.Event.Buffering -> if (started) onBuffering(event.buffering)
            MediaPlayer.Event.Playing -> {
                showPlaying(true)
                // Open, not yet showing anything: it has started once its first picture is up (Vout),
                // or, should libVLC reuse the picture's surface and not say so, once time moves on.
                opened = true
                scheduleHide()
            }
            MediaPlayer.Event.Vout -> if (event.voutCount > 0 && opened && !started) onStarted()
            MediaPlayer.Event.Paused -> {
                showPlaying(false)
                saveProgress()
                setControls(true)
            }
            MediaPlayer.Event.LengthChanged -> {
                length = event.lengthChanged
                if (started && !notTheVideo(length)) goodLength = length
                // A service sometimes hands back a short error clip ("Unexpected provider
                // response") in place of the file: move on before it plays or counts as an ending.
                if (notTheVideo(length)) failed("wasn't the video", retry = false, network = false)
            }
            MediaPlayer.Event.TimeChanged -> {
                shownTime = event.timeChanged
                if (!started && opened) {
                    if (firstTime < 0) firstTime = event.timeChanged
                    if (event.timeChanged - firstTime >= STARTED_AFTER_MS || pictureShown()) onStarted()
                }
                if (started && scrubTo == null) lastGood = event.timeChanged
                switchingTo?.let { if (event.timeChanged >= it) switched() }
                if (scrubTo == null) drawTimeline(event.timeChanged)
                countPlayed(event.timeChanged)
                checkUpNext(event.timeChanged)
            }
            MediaPlayer.Event.EndReached -> {
                // A source that "ends" after a few minutes, or before where we resumed, wasn't the
                // episode: try another.
                if (notTheVideo(len(), ended = true)) return failed("wasn't the video", retry = false, network = false)
                // The connection dropped (the file server closed it) well before the end, and VLC says
                // "ended" all the same: the same source again from where it was, rather than the next
                // episode. One that keeps dropping counts as failed, and the next source carries on.
                val len = len()
                if (len > 0 && lastTime in 0 until len - DROPPED_BEFORE_END_MS) return failed("dropped")
                if (nextEpisode != null && !upNextDismissed) return playNext()
                saveProgress(finished = true)
                leaving = true
                // The rating card is up, unanswered: it stays its full time on the last picture, and the
                // player closes once it's answered or put away (hideRateCard).
                if (rateCard.visibility == View.VISIBLE && !rateClosing) {
                    closeAfterRating = true
                    handler.removeCallbacks(hideRating)
                    handler.postDelayed(hideRating, RATE_CARD_MS)
                    return
                }
                finish()
            }
            MediaPlayer.Event.EncounteredError -> failed("couldn't be opened")
            // Its tracks are listed as it opens: the wanted language, should its name be the only thing
            // saying so, is put right before anything is heard.
            MediaPlayer.Event.ESAdded -> if (!started) {
                handler.removeCallbacks(checkAudio)
                handler.postDelayed(checkAudio, 150)
            }
        }
    }

    /** Whether libVLC has drawn a picture of this file yet (or it has none to draw). */
    private fun pictureShown(): Boolean {
        if (switching > 0) return false
        val media = player.media ?: return false
        return try { (media.stats?.displayedPictures ?: 0) > 0 || (switching == 0 && player.videoTracksCount == 0) } finally { media.release() }
    }

    private fun onStarted() {
        started = true
        everStarted = true
        len().takeIf { it > 0 }?.let { goodLength = it }
        if (subDelayUs != 0L) vlcDo { player.setSpuDelay(subDelayUs) }
        // A file this household saw gone lately, playing after all (for a little while: a broken one can
        // show a picture for a moment): the server stops holding it back.
        streams.getOrNull(current)?.takeIf { (it.seen || it.dead) && it.key != null }?.let { s ->
            val attempt = opening
            handler.postDelayed({
                if (isFinishing || attempt != opening || !started || streams.getOrNull(current)?.key != s.key) return@postDelayed
                streams = streams.map { if (it.key == s.key) it.copy(seen = false, dead = false) else it }
                val body = JSONObject().put("id", videoId).put("key", s.key)
                io.execute { Feed.post("/launcher/source-played", body, changes = false) }
            }, KEEP_BEFORE_MS)
        }
        budgetEnd = Long.MAX_VALUE
        renewedFor = null
        lookedAgainFor = null
        firstTime = -1
        played += keyAt(current)
        // Once it's playing, a crash means the player, not the source: come back to this one.
        noteRescue(crashedOpening = false)
        failures = 0
        checkAudio.run()
        // The source you picked works: after a little while (an error clip "plays" for a moment
        // before it's caught), there's nothing to go back to.
        before?.let { b -> handler.postDelayed({ if (before === b) before = null }, KEEP_BEFORE_MS) }
        // Back on the one you were watching: said plainly, a while, the film playing on.
        wentBack?.let { text ->
            wentBack = null
            showNote(text, BACK_NOTE_MS)
        }
        startNote?.let { text ->
            startNote = null
            showNote(text, BACK_NOTE_MS)
        }
        handler.removeCallbacks(stalled)
        handler.removeCallbacks(stillGettingReady)
        Waiting.off(loadingStatus)
        loading.animate().alpha(0f).setDuration(400).withEndAction { loading.visibility = View.GONE }.start()
        if (resumed == null && time() > START_GRACE_MS) showNote("Resumed at ${clock(time())}")
        resumed = true
        handler.removeCallbacks(saveEvery)
        handler.postDelayed(saveEvery, SAVE_EVERY_MS)
        // A good while playing well: its reconnects are behind it.
        handler.removeCallbacks(forgetReconnects)
        handler.postDelayed(forgetReconnects, CLEAN_PLAY_MS)
        // Subtitles once the file's own are listed (big files take a while).
        handler.postDelayed(autoPick, 600)
        handler.postDelayed({ autoPick(force = true) }, 3_000)
    }

    private val forgetReconnects = Runnable { if (started) { reconnects = 0; followedOpens = 0 } }

    /** Where to carry on from: the last moment that played, in whichever file, or where tonight began. */
    private fun resumeFrom() = if (lastGood >= 0) lastGood else resumeAt

    /** Whether the source being played has shown its picture at some point in this play. */
    private fun playedHere() = keyAt(current) in played

    /**
     * A source failed. One that had been playing gets the same file again first, from where it was
     * (its connection dropped, its link expired, the server was waking): [reconnect]. Otherwise the
     * next one; after a few in a row, more are looked for, then it gives up. [retry] false: this file
     * is wrong (an error clip), never again.
     */
    private fun failed(why: String, retry: Boolean = true, report: Boolean = true, network: Boolean = true,
                       ruleOut: Boolean = true) {
        handler.removeCallbacks(stalled)
        openAnyway = null
        // (The note was about that copy.)
        startNote = null
        streams.getOrNull(current)?.let { broke += keyAt(current) }
        // (A failure mid-film: 120 s from now to get going again.)
        if (budgetEnd == Long.MAX_VALUE) budgetEnd = System.currentTimeMillis() + BUDGET_AFTER_MS
        // A language look under way while the film drops: called off.
        lookingFor?.let { name ->
            lookingFor = null
            versionLook++
            letGo()
            showNote(notAvailableNow(name), ERROR_NOTE_MS)
        }
        val at = resumeFrom()
        Log.i(TAG, "Source ${current + 1} failed: $why")
        // The server's links for this answer have expired (a long pause, say): not this source's
        // fault. Renewed, and on with the same source from here. (libVLC can't tell a 410 apart.)
        // (Only for libVLC's own failures: an answer the server or the TV's check just gave stands.)
        if (retry && report && linksExpireAt > 0 && System.currentTimeMillis() > linksExpireAt - LINKS_MARGIN_MS) {
            showLoading()
            say(if (everStarted) RECONNECTING else GETTING_READY)
            val attempt = opening
            return renewLinks { ok -> if (attempt == opening) { if (ok) play(current, at) else lookAgain(at) } }
        }
        if (retry && playedHere() && reconnects < MAX_RECONNECTS) return reconnect(at)
        // A source you picked yourself didn't play: back to the one you were watching, where you were.
        before?.let { b ->
            before = null
            wentBack = backLine(b)
            goneBack(b)
            showLoading()
            say(SWITCHING_BACK)
            return play(b.index, b.at)
        }
        failures++
        // (One the server or the TV's own check judged isn't the connection's: never put back.)
        // (Ruled out for good only when it stays tried: a busy or first-time "being prepared" file doesn't;
        // [ruleOut] false: never, as for a file still being prepared, which may be ready on Keep trying.)
        if (network) failedAt[keyAt(current)] = System.currentTimeMillis()
        else if (ruleOut && keyAt(current) in tried) ruledOut += keyAt(current)
        if (report) streams.getOrNull(current)?.let { reportFailed(it, why) }
        // (Files for other episodes are left out: they're only played if you pick one.)
        val next = nextToTry()
        if (next < 0) return moreOrGiveUp(at)
        // Out of time, with files left: plain words.
        if (System.currentTimeMillis() > budgetEnd) return giveUp(COULDNT_PLAY)
        // About to leave the wanted language: its busy or preparing file may be worth a wait first.
        wantWait(next)?.let { ms -> return waitThen(ms) }
        // Or, the wanted language only in files seen dead: the best of them, once.
        deadWantInstead(next)?.let { showLoading(); return play(it, at) }
        // Few left of the ones that could play: more are asked for meanwhile (the plugins, the extras).
        if (PlayOrder.mainLeft(orderFiles(), tried) <= FEW_LEFT) lookForMoreQuietly()
        showLoading()
        play(next, at)
    }

    /** Tells the server a file's address is gone (a direct file's 404/410), by its key. */
    private fun reportGone(s: Stream) {
        val key = s.key ?: return
        val body = JSONObject().put("id", videoId).put("addon", s.addon.ifBlank { "?" }).put("key", key).put("dead", true)
        io.execute { Feed.post("/launcher/source-failed", body, changes = false) }
    }

    /** Tells the server a source wouldn't play, so add-ons with many dead ones can be found. */
    private fun reportFailed(s: Stream, why: String) {
        if (s.addon.isBlank()) return
        val body = JSONObject().put("id", videoId).put("addon", s.addon).put("error", why)
            .apply { if (s.filename.isNotBlank()) put("filename", s.filename.take(300)) }
        io.execute { Feed.post("/launcher/source-failed", body, changes = false) }
    }

    /** The links ran out and couldn't be renewed: a fresh play answer, on with the same source. */
    private fun lookAgain(at: Long) {
        val s = streams.getOrNull(current) ?: return giveUp(COULDNT_PLAY)
        carryOn = Triple(keyAt(current), current, at)
        load()
    }

    /**
     * The same file again from [at], once the server says where its link leads now: it is asked first
     * (X-Where), so a server that's waking up, a link that has expired or no connection at all are told
     * apart from a file that's gone, and libVLC's own 30 s only starts once there's an address. Every
     * second try asks the add-on afresh (fresh=1): the followed link itself may have died.
     */
    private fun reconnect(at: Long) {
        val s = streams.getOrNull(current) ?: return
        if (s.youtube != null) return if (!youtubeAgain()) failed("couldn't be opened", retry = false) else Unit
        reconnects++
        showLoading()
        say(RECONNECTING)
        val attempt = ++opening
        // (The dropped one is stopped: its late "ended" or error doesn't use up the next tries, nor does
        // libVLC carry on with it behind "Reconnecting…".)
        handler.removeCallbacks(stalled)
        stoppedForLookup = true
        vlcDo(switch = true) { player.stop() }
        // (Asked afresh from the second try: the followed link itself may have died. Never for usenet,
        // where asking again starts a new download.)
        val afresh = reconnects > 1 && s.kind != "usenet"
        val link = if (afresh) s.url + (if ('?' in s.url) "&" else "?") + "fresh=1" else s.url
        Thread {
            val asked = whereItLeads(link, attempt)
            handler.post { if (!isFinishing && attempt == opening) whereCame(asked, at, fromPlay = false, afresh = afresh) }
        }.start()
    }

    /** Whether a source's link is asked about first: the server's playback links, not a plugin's (it
     *  resolves its own address). */
    private fun asksFirst(s: Stream) = !s.plugin && TOKEN.containsMatchIn(s.url)

    /**
     * What the server said about the link of the file being opened ([fromPlay]: from [play], whose
     * bookkeeping is done; otherwise a [reconnect]'s, played through [play]). [afresh]: this was the
     * add-on asked again (fresh=1) after the TV's own check found the first address dead.
     */
    private fun whereCame(asked: Asked, at: Long, fromPlay: Boolean, afresh: Boolean = false) {
        // (The server waking or the connection down: that time isn't the play's.)
        if (budgetEnd != Long.MAX_VALUE) budgetEnd += asked.pausedMs
        // The connection was down: files that failed just before it went were the connection's, not
        // theirs, and are tried again.
        if (asked.wentOffline > 0) {
            val blamed = failedAt.filter { (k, t) -> k != keyAt(current) && asked.wentOffline - t in 0..OFFLINE_LOOKBACK_MS }.keys
            tried -= blamed
            failedAt -= blamed
        }
        val key = keyAt(current)
        when (val w = asked.where) {
            is Where.At -> checkThenOpen(w, at, fromPlay, afresh)
            Where.Expired -> {
                // (No call to a service was made for it.)
                if (fromPlay && followed(current)) followedOpens--
                // Renewed once for this file: expired again, a fresh play answer instead.
                if (renewedFor == key) return lookAgainOnce(key, at)
                renewedFor = key
                val attempt = this.opening
                renewLinks { ok ->
                    if (isFinishing || attempt != this.opening) return@renewLinks
                    if (!ok) return@renewLinks lookAgainOnce(key, at)
                    if (fromPlay) play(current, at) else { reconnects--; reconnect(at) }
                }
            }
            Where.Gone -> failed("gone", retry = false, network = false)
            Where.NotNow -> failed("couldn't be had just now", retry = false)
            Where.Preparing -> {
                // Being prepared: tried once more, a minute on (the second time, it stays tried).
                if (key !in preparingAt) {
                    preparingAt[key] = maxOf(answeredAt + PREPARING_AFTER_ANSWER_MS, System.currentTimeMillis() + PREPARING_AGAIN_MS)
                    tried -= key
                } else preparingAt -= key
                // (Not ruled out for good: on Keep trying it may be ready.)
                failed("being prepared", retry = false, report = false, network = false, ruleOut = false)
            }
            is Where.Busy -> {
                // The household's service is busy: its files of this type wait for its time; the others go on.
                trips += PlayOrder.Trip.Busy(w.service, w.kind, w.until)
                tried -= key
                if (fromPlay && followed(current)) followedOpens--
                lookForMoreQuietly()
                failed("busy", retry = false, report = false, network = false)
            }
            is Where.Refused -> {
                trips += when {
                    w.why == "limit" -> PlayOrder.Trip.Sink(w.service)
                    w.why == "plan" && w.kind != null -> PlayOrder.Trip.NotInPlan(w.service, w.kind)
                    else -> PlayOrder.Trip.BadKey(w.service)
                }
                lookForMoreQuietly()
                failed("refused", retry = false, report = false, network = false)
            }
            Where.Offline -> giveUp(NO_CONNECTION)
        }
    }

    /** The file whose links were renewed since it last played (once is enough), and the one a fresh
     *  play answer was asked for (once too: expired again after that, it's the next file). */
    private var renewedFor: String? = null
    private var lookedAgainFor: String? = null

    private fun lookAgainOnce(key: String, at: Long) {
        if (lookedAgainFor == key) return failed("its link keeps expiring", retry = false, network = false)
        lookedAgainFor = key
        lookAgain(at)
    }

    private enum class Check { OPEN, DEAD, AFRESH, NOT_NOW, SILENT }

    /**
     * The TV's own look at the address (one byte asked, 8 s a call, as libVLC would ask), so a dead
     * address fails in a second: dead on 404/410 (a followed link's also on 401/403, a refused or unknown
     * host), after one fresh ask of the add-on for a followed link.
     * A direct link's 401/403 is opened anyway (some hosts refuse anything but a player). Anything else,
     * opened. Skipped for live (HLS) streams.
     */
    private fun checkThenOpen(w: Where.At, at: Long, fromPlay: Boolean, afresh: Boolean) {
        fun go() = if (fromPlay) open(current, w.url, null, at) else play(current, at, w.url)
        if (w.url.contains(".m3u8", ignoreCase = true)) return go()
        if (openAnyway == keyAt(current)) { openAnyway = null; return go() }
        val attempt = opening
        val s = streams[current]
        // (A usenet file asked afresh would start a new download: never.)
        val canAskAfresh = !w.direct && !afresh && s.kind != "usenet" && followedOpens < MAX_FOLLOWED_OPENS
        Thread {
            val check = checkAddress(w.url, w.direct, attempt, slowIsNormal = w.direct || s.kind == "usenet")
            handler.post {
                if (isFinishing || attempt != opening) return@post
                when {
                    check == Check.OPEN -> go()
                    // (A silent host: the next copy, and this one opened anyway once nothing else is left.)
                    check == Check.SILENT && fromPlay -> {
                        silentSkipped += keyAt(current)
                        failed("its host isn't answering", retry = false, report = false)
                    }
                    // (Its host isn't answering now: not dead, the next copy; it may be tried again later.
                    // Mid-film, one of the reconnects: a short hiccup doesn't lose the file being watched.)
                    check == Check.NOT_NOW || check == Check.SILENT ->
                        failed("its host isn't answering", retry = !fromPlay, report = false)
                    check == Check.AFRESH && canAskAfresh -> {
                        followedOpens++
                        val link = s.url + (if ('?' in s.url) "&" else "?") + "fresh=1"
                        Thread {
                            val asked = whereItLeads(link, attempt)
                            handler.post { if (!isFinishing && attempt == opening) whereCame(asked, at, fromPlay, afresh = true) }
                        }.start()
                    }
                    else -> {
                        // (A direct file's address gone: written down as seen gone, for the household.)
                        if (check == Check.DEAD) reportGone(s)
                        failed("its address is dead", retry = false, report = false, network = check != Check.DEAD)
                    }
                }
            }
        }.start()
    }

    /** [slowIsNormal]: a host that may well take over 8 s for its first byte and still play (a direct
     *  file's free host, a usenet file being fetched): no answer then is no reason to skip it. */
    private fun checkAddress(url: String, direct: Boolean, attempt: Int, slowIsNormal: Boolean): Check {
        val request = runCatching {
            Request.Builder().url(url).header("Range", "bytes=0-0").header("User-Agent", PLAYER_AGENT).build()
        }.getOrNull() ?: return Check.OPEN
        var waited = false
        while (attempt == opening && !isFinishing) {
            val asked = runCatching {
                checkClient.newCall(request).execute().use { r -> r.code to r.header("Retry-After")?.toLongOrNull() }
            }
            val e = asked.exceptionOrNull()
            if (e != null) {
                // (The server has just answered: a followed link's host that can't be found or refuses is dead.)
                val gone = e is java.net.UnknownHostException || e is java.net.ConnectException || e is javax.net.ssl.SSLException
                if (gone && !direct) return Check.AFRESH
                // No answer at all in 8 s from a service's host: libVLC would wait its 30 s for nothing.
                // Another copy, now.
                return if (e is java.io.InterruptedIOException && !slowIsNormal) Check.SILENT else Check.OPEN
            }
            val (code, retryAfter) = asked.getOrThrow()
            when {
                code == 404 || code == 410 -> return if (direct) Check.DEAD else Check.AFRESH
                code == 401 || code == 403 -> return if (direct) Check.OPEN else Check.AFRESH
                // (A busy host: once more in a moment, then opened anyway.)
                code == 429 && !waited -> waited = true
                // The host itself failing (503 and the like): once more in a moment, then another copy.
                code >= 500 && !waited -> waited = true
                code >= 500 -> return Check.NOT_NOW
                else -> return Check.OPEN
            }
            Thread.sleep(((retryAfter ?: 2L) * 1000).coerceIn(1_000, 8_000))
        }
        return Check.OPEN
    }

    /** About to try [next], outside the wanted language: how long to wait first for a busy or preparing
     *  file in it (once a play, when what's left of the time allows), or null. */
    private fun wantWait(next: Int): Long? {
        val want = audioWant ?: profileAudio.firstOrNull() ?: return null
        if (speaks(next, want)) return null
        val ms = PlayOrder.waitBeforeLeaving(orderFiles(), skip(), want, profileAudio.lastOrNull(),
            System.currentTimeMillis(), budgetEnd, waitedForWant) ?: return null
        waitedForWant = true
        return ms
    }

    /** About to try [next], outside the wanted language, when the language is left only in files seen
     *  dead: the best of those, tried once a play (it may be back), or null. */
    private fun deadWantInstead(next: Int): Int? {
        if (triedDeadWant) return null
        val want = audioWant ?: profileAudio.firstOrNull() ?: return null
        if (speaks(next, want)) return null
        val i = PlayOrder.deadWant(orderFiles(), skip(), want, profileAudio.lastOrNull()).takeIf { it >= 0 } ?: return null
        triedDeadWant = true
        return i
    }

    /** When each file failed this play (for the connection's failures to be undone). */
    private val failedAt = mutableMapOf<String, Long>()

    /** Whether this play already tried a dead file for the wanted language (once a play). */
    private var triedDeadWant = false

    /** Waits [ms] on the loading screen ("Still getting it ready…"), then tries the next file. */
    private fun waitThen(ms: Long) {
        // (The file that failed is stopped: should it open late, it isn't played and then cut off.)
        stoppedForLookup = true
        handler.removeCallbacks(stalled)
        vlcDo(switch = true) { player.stop() }
        showLoading()
        say(stillLine())
        val attempt = ++opening
        handler.postDelayed({
            if (isFinishing || attempt != opening) return@postDelayed
            val next = nextToTry()
            if (next >= 0) play(next, resumeFrom()) else outOfFiles()
        }, ms.coerceAtLeast(0) + WAIT_MARGIN_MS)
    }

    private sealed class Where {
        class At(val url: String, val direct: Boolean) : Where()
        object Expired : Where()
        /** Gone (the server says so): not tried again this play. */
        object Gone : Where()
        /** Couldn't be had just now (a plain 502, a slow answer, a file busy twice): the next file. */
        object NotNow : Where()
        object Preparing : Where()
        /** The household's service is busy for files of [kind] (null: all) until [until] (ms). */
        class Busy(val service: String, val kind: String?, val until: Long) : Where()
        /** The household's service refused: [why] is "key", "plan" (files of [kind]) or "limit". */
        class Refused(val service: String, val kind: String?, val why: String) : Where()
        object Offline : Where()
    }

    /** What the server said, and how long went on waiting for it to wake or the connection to come back. */
    private class Asked(val where: Where, val pausedMs: Long, val wentOffline: Long = 0)

    private class Answer(val code: Int, val retryAfter: Long?, val body: String?, val header: (String) -> String?)

    /**
     * Where a playback link leads now (X-Where: 2), waiting while the server wakes up (90 s at most), the
     * connection is down (2 min) or the file's service is briefly busy (once, 15 s at most). Runs on its
     * own thread; stops once another source is being opened.
     */
    private fun whereItLeads(link: String, attempt: Int): Asked {
        val request = Request.Builder().url(link).header("X-Where", "2").build()
        var paused = 0L
        var offlineSince = 0L
        var wentOffline = 0L
        var startingSince = 0L
        var waitedBusy = false
        var waitedOnce = false
        while (attempt == opening && !isFinishing) {
            val asked = runCatching {
                whereClient.newCall(request).execute().use { r ->
                    Answer(r.code, r.header("Retry-After")?.toLongOrNull(), if (r.isSuccessful) r.body?.string() else null) { r.header(it) }
                }
            }
            val now = System.currentTimeMillis()
            val a = asked.getOrNull()
            // A slow answer isn't no connection: not this file now, the next. Only a failure to connect
            // at all (a connect timeout included) is.
            asked.exceptionOrNull()?.let { e ->
                if (e is java.net.SocketTimeoutException && e.message?.contains("connect", ignoreCase = true) != true)
                    return Asked(Where.NotNow, paused, wentOffline)
            }
            if (a != null) offlineSince = 0
            val service = a?.header("X-Service")?.takeIf { it.isNotBlank() }
            val kind = a?.header("X-Kind")?.takeIf { it.isNotBlank() }
            val sleep = ((a?.retryAfter ?: 5L) * 1000).coerceIn(1_000, 15_000)
            when {
                // No answer at all: no connection (or the server can't be reached). Waited out a while.
                a == null -> {
                    if (offlineSince == 0L) offlineSince = now
                    if (wentOffline == 0L) wentOffline = now
                    if (now - offlineSince > OFFLINE_WAIT_MS) return Asked(Where.Offline, paused, wentOffline)
                    paused += sleep
                }
                a.code == 200 -> return Asked(runCatching {
                    JSONObject(a.body!!).let { Where.At(it.getString("url"), it.optBoolean("direct")) }
                }.getOrDefault(Where.NotNow), paused, wentOffline)
                a.code == 410 -> return Asked(Where.Expired, paused, wentOffline)
                a.code == 502 -> return Asked(when {
                    a.header("X-Dead") == "file" -> Where.Gone
                    a.header("X-Dead") == "account" && service != null -> Where.Refused(service, kind, a.header("X-Why") ?: "key")
                    a.header("X-Preparing") != null -> Where.Preparing
                    else -> Where.NotNow
                }, paused, wentOffline)
                // Waking up: the same file once it's up.
                a.code == 503 && a.header("X-Starting") != null -> {
                    if (startingSince == 0L) startingSince = now
                    if (now - startingSince > STARTING_WAIT_MS) return Asked(Where.NotNow, paused, wentOffline)
                    paused += sleep
                }
                // The household's service is busy: a short wait on the same file, once; a longer one,
                // its files wait while the others are tried.
                a.code == 503 && a.header("X-Busy") != null && service != null -> {
                    val wait = (a.retryAfter ?: 5L) * 1000
                    if (waitedBusy || wait > BUSY_WAIT_HERE_MS) return Asked(Where.Busy(service, kind, now + wait), paused, wentOffline)
                    waitedBusy = true
                }
                // Busy about this one file: once more in a moment.
                a.code == 503 -> {
                    if (waitedOnce) return Asked(Where.NotNow, paused, wentOffline)
                    waitedOnce = true
                }
                else -> return Asked(Where.NotNow, paused, wentOffline)
            }
            Thread.sleep(sleep)
        }
        return Asked(Where.NotNow, paused, wentOffline)
    }

    /** New links for the same files (the server's token renewed, no new lookup): [then] true once in. */
    private fun renewLinks(then: (Boolean) -> Unit) {
        val token = streams.firstNotNullOfOrNull { TOKEN.find(it.url)?.groupValues?.get(1) } ?: return then(false)
        val body = JSONObject().put("token", token).put("runtimeMs", expectedMs)
        Thread {
            val request = Request.Builder().url(Server.url + "/launcher/play/renew")
                .post(body.toString().toRequestBody("application/json".toMediaType())).build()
            // (No connection yet, after a long pause say: waited for, a while, before giving up on renewing.)
            val begun = System.currentTimeMillis()
            var fresh: JSONObject? = null
            while (!isFinishing) {
                val asked = runCatching {
                    Feed.slow.newCall(request).execute().use { r ->
                        check(r.isSuccessful) { "HTTP ${r.code}" }
                        JSONObject(r.body!!.string())
                    }
                }
                fresh = asked.getOrNull()
                val offline = asked.exceptionOrNull() is java.io.IOException
                if (fresh != null || !offline || System.currentTimeMillis() - begun > OFFLINE_WAIT_MS) {
                    asked.exceptionOrNull()?.let { Log.w(TAG, "Couldn't renew the links", it) }
                    break
                }
                Thread.sleep(5_000)
            }
            handler.post {
                if (isFinishing) return@post
                val new = fresh?.optString("token")?.takeIf { it.isNotBlank() } ?: return@post then(false)
                streams = streams.map { it.copy(url = it.url.replace("/s/$token/", "/s/$new/")) }
                subtitles = subtitles.map { it.copy(url = it.url.replace("/s/$token/", "/s/$new/")) }
                linksExpireAt = fresh.optLong("linksExpireAt")
                then(true)
            }
        }.start()
    }

    // ---------- Waiting mid-film: a spinner over the picture ----------

    private val spinner by lazy { findViewById<View>(R.id.buffering) }
    private var rebuffering = false
    private var readBytes = -1
    private var readAt = 0L

    /** libVLC is filling its buffer mid-film: a spinner after a moment; a connection that has stopped
     *  bringing anything in for a while is opened again (a slow one is waited for). */
    private fun onBuffering(percent: Float) {
        if (percent >= 100f) {
            rebuffering = false
            handler.removeCallbacks(watchdog)
            handler.removeCallbacks(showSpinner)
            if (switchingTo == null) spinner.visibility = View.GONE
            return
        }
        if (rebuffering) return
        rebuffering = true
        readBytes = bytesRead()
        readAt = System.currentTimeMillis()
        handler.postDelayed(showSpinner, SPINNER_AFTER_MS)
        handler.postDelayed(watchdog, WATCH_EVERY_MS)
    }

    private val showSpinner = Runnable { if (rebuffering) spinner.visibility = View.VISIBLE }

    private val watchdog = object : Runnable {
        override fun run() {
            if (!rebuffering || !started) return
            val now = bytesRead()
            if (now != readBytes) {
                readBytes = now
                readAt = System.currentTimeMillis()
            } else if (System.currentTimeMillis() - readAt > NOTHING_ARRIVING_MS && player.isPlaying) {
                rebuffering = false
                spinner.visibility = View.GONE
                return failed("stopped arriving")
            }
            handler.postDelayed(this, WATCH_EVERY_MS)
        }
    }

    private fun bytesRead(): Int {
        val media = player.media ?: return -1
        return try { media.stats?.readBytes ?: -1 } finally { media.release() }
    }


    private fun giveUp(message: String) {
        openAnyway = null
        // Nothing played this time: asked whether to keep trying.
        if (message == COULDNT_PLAY && !isFinishing && canKeepTrying()) return askKeepTrying()
        Notice.later(message)
        finish()
    }

    // ---------- Audio and subtitles, picked from remembered languages ----------

    private var subsPicked = false
    /** A language picked in the player's Audio panel (a code, "hi"): for this play only, over the
     *  profile's, so a version switched to for it starts in it. Never saved to the profile. */
    private var audioWant: String? = null
    /** The pick as it's carried to the next episode and the rescue (tri-state): a code, "" (cleared: the
     *  profile's own language was picked), or null (none: the title's saved one, else the profile's). */
    private var pickState: String? = null
    /** A pick to keep for the title (sent with progress once heard, until a save goes through). */
    private var pickToSave: String? = null
    private var pickHeard = false
    /** A wanted language a more answer came back without, in this binge: not asked for again. */
    private var wantMissing: String? = null
    /** "Hindi isn't available for this episode" has been said in this binge. */
    private var lineSaid = false
    /** A picked track that doesn't say its language: its release (bingeGroup) and number, "group|n". */
    private var carriedTrack: String? = null

    /** The viewer picked [code] in Audio: wanted from now on, through the binge, and kept for the title. */
    private fun picked(code: String) {
        audioWant = code
        pickState = if (code == profileAudio.firstOrNull()) "" else code
        pickToSave = pickState
        pickHeard = false
        lineSaid = false
    }

    /** [next] with the viewer's picks, so the next episode (or a rescued player) starts with them. */
    private fun carry(next: Intent): Intent = next.apply {
        if (pickState != null) putExtra(EXTRA_AUDIO_PICK, pickState) else removeExtra(EXTRA_AUDIO_PICK)
        qualityWant?.let { putExtra(EXTRA_QUALITY, it) } ?: removeExtra(EXTRA_QUALITY)
        wantMissing?.let { putExtra(EXTRA_WANT_MISSING, it) } ?: removeExtra(EXTRA_WANT_MISSING)
        if (lineSaid) putExtra(EXTRA_LINE_SAID, "1") else removeExtra(EXTRA_LINE_SAID)
        carriedTrack?.let { putExtra(EXTRA_TRACK, it) } ?: removeExtra(EXTRA_TRACK)
        subsPick?.let { putExtra(EXTRA_SUBS, it) } ?: removeExtra(EXTRA_SUBS)
    }

    /** What to reopen should libVLC take the app down: before the picture, without this file; after,
     *  this file first, from where it got to. Tried files go by key (a list's order can change). */
    private fun noteRescue(crashedOpening: Boolean) {
        val key = keyAt(current)
        // (A crash while a picked version opens: back to the one that was being watched.)
        val back = if (crashedOpening) before?.let { keyAt(it.index) } else null
        val again = carry(Intent(intent))
            .putExtra(EXTRA_RESCUE_TRIED, (if (crashedOpening) tried - setOfNotNull(back) else tried - key).joinToString("\n"))
            .putExtra(EXTRA_RESCUES, rescues + 1)
        val first = if (crashedOpening) back else key
        if (first == null) again.removeExtra(EXTRA_RESCUE_FIRST) else again.putExtra(EXTRA_RESCUE_FIRST, first)
        // (Back to the one before a pick: with the picks of then.)
        if (back != null) before?.let { b ->
            b.qualityWant?.let { again.putExtra(EXTRA_QUALITY, it) } ?: again.removeExtra(EXTRA_QUALITY)
            b.want?.let { again.putExtra(EXTRA_AUDIO_PICK, it) } ?: again.removeExtra(EXTRA_AUDIO_PICK)
        }
        PlayerRescue.note(this, rescueToken, again)
    }
    /** The profile's audio language, then the title's own (codes, from the play answer). */
    private var profileAudio = emptyList<String>()
    /** The audio track that's playing (the source's key, its place among the file's audio tracks), so
     *  the same file opened again (a reconnect) carries on in it. */
    private var pickedTrack: Pair<String, Int>? = null
    private val autoPick = Runnable { autoPick(force = false) }

    /** Subtitles once per source; [force] picks them even if no tracks showed up. */
    private fun autoPick(force: Boolean) {
        if (!started) return
        val audio = audioTracks()
        if (!subsPicked && (audio.isNotEmpty() || force)) {
            subsPicked = true
            pickSubtitles()
        }
    }

    /** The file's audio tracks, or the last ones read while the player lane is switching files. */
    private fun audioTracks(): List<MediaPlayer.TrackDescription> {
        if (switching > 0 || released) return shownTracks
        return player.audioTracks?.filter { it.id >= 0 }.orEmpty().also { shownTracks = it }
    }
    private var shownTracks = emptyList<MediaPlayer.TrackDescription>()

    /** The audio track playing, or the last one read while the lane is switching files. */
    private fun audioTrackNow(): Int = if (switching > 0 || released) shownTrack else player.audioTrack.also { shownTrack = it }
    private var shownTrack = -1

    /**
     * libVLC chose the audio as the file opened (audioOptions); this only puts it right where it
     * couldn't know: a track whose name says the wanted language while its tag says another, or
     * nothing (libVLC reads that as English). Not for a file opened by track number from its own
     * header (that's already right), and never by a guess. A version switched to for a language that
     * turns out not to have it: back to the one before, where it was.
     */
    private val checkAudio = Runnable {
        val s = streams.getOrNull(current) ?: return@Runnable
        val tracks = audioTracks()
        if (tracks.isEmpty()) return@Runnable
        val want = audioWant ?: profileAudio.firstOrNull()
        var at = tracks.indexOfFirst { it.id == audioTrackNow() }
        val byNumber = pickedTrack?.first == keyAt(current) || (want != null && s.audio?.contains(want) == true)
        if (want != null && !byNumber && at >= 0 && trackLanguage(tracks[at].name) != want) {
            val better = tracks.indexOfFirst { trackLanguage(it.name) == want && !it.name.contains("comment", true) }
            if (better >= 0) {
                tracks[better].id.let { id -> vlcDo { player.setAudioTrack(id) } }
                // (Already heard: what's in libVLC's buffer in the old language goes.)
                if (started && seekable()) time().let { t -> vlcDo { player.setTime(t) } }
                at = better
            }
        }
        // (Only once it plays: before then more tracks may still be listed, a better one among them.)
        if (at >= 0 && started) pickedTrack = keyAt(current) to at
        val picked = audioWant ?: return@Runnable
        if (started && heardCode() == picked) {
            // A version switched to for a language, now heard in it: the pick holds (kept for the title).
            if (pendingPick == picked) {
                pendingPick = null
                picked(picked)
            }
            if (pickToSave != null) pickHeard = true
        }
        // (A track that says nothing of its language may be it: only when each says, is it known not there.)
        if (!started || s.audio?.contains(picked) == true || tracks.any { trackLanguage(it.name).let { l -> l == null || l == picked } })
            return@Runnable
        val name = SPOKEN[picked] ?: picked
        val b = before
        if (b != null) {
            before = null
            goneBack(b)
            showLoading()
            say(SWITCHING_BACK)
            wentBack = backLine(b)
            play(b.index, resumeFrom())
        } else if (more == MoreSources.OFFERED && !askedMore && wantMissing != picked) {
            // (More sources may have it: asked first; this is looked at again when they're in.)
            lookForMoreQuietly { if (more == MoreSources.NONE && streams.indices.none { speaks(it, picked) }) wantMissing = picked }
        } else if (availableSaid) {
            // (Already said it's in Audio now.)
        } else if (more != MoreSources.LOOKING && hasWant(picked)) {
            // Another file has it, in Audio (it came while this one was opening): said so.
            sayAvailable(picked)
        } else if (more != MoreSources.LOOKING && !lineSaid) {
            // Said once in a binge (an episode after another without it says nothing more). A file in it
            // that was there but couldn't play now (busy, being prepared, broken): "right now".
            lineSaid = true
            val there = streams.indices.any { speaks(it, picked) && !streams[it].suspect }
            showNote(if (there) "$name isn't available right now." + (heardNow()?.takeIf { it != name }?.let { " Still in $it." } ?: "")
                else "$name isn't available for this episode", BACK_NOTE_MS)
        }
    }

    /** A language picked in Audio that only another version has, until that version is heard in it. */
    private var pendingPick: String? = null

    /** Back on the one before a pick: the picks are as they were then. */
    private fun goneBack(b: Before) {
        audioWant = b.want
        qualityWant = b.qualityWant
        pendingPick = null
    }

    /** What's said once back on the one you were watching: "Hindi isn't available right now. Still in
     *  English." (or, for a source picked by hand, that it isn't). */
    private fun backLine(b: Before) = when {
        b.language != null -> "${b.language} isn't available right now." + (b.heard?.takeIf { it != b.language }?.let { " Still in $it." } ?: "")
        b.quality != null -> "${b.quality} isn't available right now." + (b.wasQuality?.let { " Still in $it." } ?: "")
        else -> "That one isn't available right now. You're back where you were."
    }

    /** The language of the audio playing now, by name ("English"), or null. */
    private fun heardNow() = heardCode()?.let { SPOKEN[it] }

    private fun heardCode() = audioTracks().firstOrNull { it.id == audioTrackNow() }?.let { trackLanguage(it.name) }

    private fun trackLanguage(name: String) = TrackLanguage.of(name)

    /** Where the audio being switched to is heard from: "Switching to Hindi…" until playback is past it. */
    private var switchingTo: Long? = null
    private val switchedAnyway = Runnable { switched() }

    private fun switching(name: String, from: Long) {
        switchingTo = from + SWITCH_HEARD_MS
        hold("Switching to $name…")
        spinner.visibility = View.VISIBLE
        handler.removeCallbacks(switchedAnyway)
        handler.postDelayed(switchedAnyway, SWITCH_MOST_MS)
    }

    private fun switched() {
        switchingTo = null
        handler.removeCallbacks(switchedAnyway)
        if (!rebuffering) spinner.visibility = View.GONE
        letGo()
    }

    /** The subtitles wanted: picked for this title (here or before), else the profile's. */
    private fun subsWant() = subsPick ?: prefs.getString(PREF_SUBS, "eng")!!

    /** Subtitles picked in the player: for this title (and its next episodes), sent with the next save. */
    private fun pickedSubs(code: String) {
        subsPick = code
        subsToSave = code
    }

    /** The subtitles picked for this title ("eng", "off"), and a pick not yet saved on the server. */
    private var subsPick: String? = null
    private var subsToSave: String? = null

    private fun pickSubtitles() {
        val want = subsWant()
        if (want == OFF) return run { onlineSub = null; vlcDo { player.setSpuTrack(-1) } }
        val name = subtitles.firstOrNull { it.lang == want }?.language ?: LANG_NAMES[want] ?: want
        val inside = player.spuTracks?.firstOrNull {
            it.id >= 0 && it.name.contains(name, true) && !it.name.contains("forced", true)
        }
        when {
            inside != null -> { onlineSub = null; vlcDo { player.setSpuTrack(inside.id) } }
            else -> subtitles.firstOrNull { it.lang == want }?.let { addOnline(it) } ?: vlcDo { player.setSpuTrack(-1) }
        }
    }

    /** Downloads an online subtitle (VLC reads local files most reliably) and shows it. */
    private fun addOnline(sub: Subtitle) {
        onlineSub = sub
        io.execute {
            val file = File(cacheDir, "subs/${sub.url.hashCode().toUInt()}.srt")
            val ok = file.exists() || runCatching {
                file.parentFile!!.mkdirs()
                Feed.http.newCall(Request.Builder().url(sub.url).build()).execute().use { r ->
                    check(r.isSuccessful) { "HTTP ${r.code}" }
                    file.writeBytes(r.body!!.bytes())
                }
            }.onFailure { Log.w(TAG, "Subtitle download failed", it) }.isSuccess
            handler.post {
                if (isFinishing || onlineSub !== sub) return@post
                if (ok) {
                    slavesAdded++
                    vlcDo { player.addSlave(IMedia.Slave.Type.Subtitle, Uri.fromFile(file), true) }
                } else {
                    // (Not ticked as showing.)
                    onlineSub = null
                    showNote("Couldn't load those subtitles", ERROR_NOTE_MS)
                }
            }
        }
    }

    // ---------- Controls ----------

    private fun setControls(show: Boolean) {
        handler.removeCallbacks(hideControls)
        // The loading screen (a source opening) has the screen to itself.
        if (show && loading.visibility == View.VISIBLE) return
        if (show == (controls.visibility == View.VISIBLE && controls.alpha > 0f)) return
        if (show) {
            controls.visibility = View.VISIBLE
            controls.animate().alpha(1f).setDuration(180).start()
            drawTimeline(scrubTo ?: time())
            if (panel.visibility != View.VISIBLE) focusTimeline()
        } else {
            controls.animate().alpha(0f).setDuration(260).withEndAction { controls.visibility = View.INVISIBLE }.start()
            focusTimeline()
        }
    }

    /** Focus back on the timeline, unless a card (rating, leaving) is open: its highlighted
     *  choice keeps the focus, or the next press would count from its first choice. */
    private fun focusTimeline() {
        if (listOf(rateCard, exitCard).any { it.visibility == View.VISIBLE }) return
        timeline.requestFocus()
    }

    /** Back to the loading screen mid-film (a new source opening): the controls go at once. */
    private fun showLoading() {
        controls.animate().cancel()
        controls.alpha = 0f
        controls.visibility = View.INVISIBLE
        handler.removeCallbacks(hideControls)
        spinner.visibility = View.GONE
        loading.animate().cancel()
        // The title's picture behind the one line ("Switching…", "Reconnecting…"): the video itself is
        // black while a file changes, so it isn't shown through.
        loading.apply { alpha = 1f; visibility = View.VISIBLE }
        // (A panel left open would sit over it, and take Back.)
        panel.visibility = View.GONE
        timeline.requestFocus()
    }

    /** The loading screen's one line, breathing while it waits. Before anything plays, after a while
     *  it says it's still at it, so a long wait doesn't look stuck. */
    private fun say(line: String) {
        // (A minute in with nothing played yet: it stays "Almost there…".)
        loadingStatus.text = if (line == GETTING_READY && stillLine() == ALMOST_THERE) ALMOST_THERE else line
        Waiting.on(loadingStatus)
        handler.removeCallbacks(stillGettingReady)
        if (line == GETTING_READY) handler.postDelayed(stillGettingReady, STILL_AFTER_MS)
    }

    private val stillGettingReady = Runnable { if (!started) loadingStatus.text = stillLine() }

    /** The line for a wait that goes on: "Almost there…" once the screen has been open a minute
     *  before anything played. */
    private fun stillLine() =
        if (!everStarted && System.currentTimeMillis() - openedAt > ALMOST_AFTER_MS) ALMOST_THERE else STILL_GETTING_READY

    private val openedAt = System.currentTimeMillis()
    private val almostThere = Runnable { if (!started && !everStarted && loadingStatus.text == STILL_GETTING_READY) loadingStatus.text = ALMOST_THERE }

    private fun scheduleHide() {
        handler.removeCallbacks(hideControls)
        if (player.isPlaying && panel.visibility != View.VISIBLE) handler.postDelayed(hideControls, HIDE_AFTER_MS)
    }

    private val controlsShown get() = controls.visibility == View.VISIBLE && controls.alpha > 0.5f

    private fun drawTimeline(time: Long) {
        val len = len()
        if (len <= 0 || track.width == 0) return
        val f = (time.toFloat() / len).coerceIn(0f, 1f)
        fill.scaleX = f
        knob.translationX = track.width * f - knob.width / 2f
        elapsed.text = clock(time)
        remaining.text = "−${clock(len - time)}"
        endsAt.text = "Ends at ${LocalTime.now().plusSeconds((len - time) / 1000).format(HH_MM)}"
    }

    private fun scrub(direction: Int, repeat: Int) {
        val len = len()
        if (len <= 0) return
        // Holding the key speeds up: 10 s steps, then 30 s, then a minute.
        val step = when {
            repeat > 24 -> 60_000L
            repeat > 8 -> 30_000L
            else -> SEEK_MS
        }
        val target = (scrubTo ?: time()) + direction * step
        // Skipping forward past the end of an episode goes straight to the next one.
        if (direction > 0 && target >= len - 2_000 && nextEpisode != null) {
            handler.removeCallbacks(commitScrub)
            scrubTo = null
            return playNext()
        }
        val to = target.coerceIn(0, len - 2_000)
        scrubTo = to
        setControls(true)
        drawTimeline(to)
        handler.removeCallbacks(commitScrub)
        handler.postDelayed(commitScrub, SCRUB_SETTLE_MS)
    }

    /** The round button shows what OK would do: pause while playing, play while paused. */
    private fun showPlaying(playing: Boolean) {
        playPause.setImageResource(if (playing) R.drawable.ic_pl_pause else R.drawable.ic_pl_play)
        playPause.contentDescription = if (playing) "Pause" else "Play"
    }

    /** ⏯ toggles; ▶ only plays and ❚❚ only pauses (a remote with both). */
    private fun mediaKey(code: Int) {
        when (code) {
            KeyEvent.KEYCODE_MEDIA_PLAY -> if (!player.isPlaying) togglePause()
            KeyEvent.KEYCODE_MEDIA_PAUSE -> if (player.isPlaying) togglePause()
            else -> togglePause()
        }
    }

    private fun togglePause() {
        if (player.isPlaying) {
            vlcDo { player.pause() }
            showPlaying(false)
            showNote("Paused")
        } else {
            vlcDo { player.play() }
            showPlaying(true)
            scheduleHide()
        }
        setControls(true)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // Play on TV is asking something over the video: its keys are its own.
        if (Sheet.open) return super.dispatchKeyEvent(event)
        if (event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        // (A held OK or play key acts once: no flicker of pause and play, no choice made twice.)
        if (event.repeatCount > 0 && event.keyCode in ONCE_KEYS) return true
        // "Play one anyway?" (asked before anything plays): its keys are its own.
        if (exitCard.visibility == View.VISIBLE && askingCard) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) return true.also { closeOtherCard(); finish() }
            return true.also { choose(R.id.exitChoices, event.keyCode) }
        }
        if (!started) {
            if (event.keyCode != KeyEvent.KEYCODE_BACK) return true
            // Back while switching to a version you picked: stay on the one you were watching.
            val b = before ?: return super.dispatchKeyEvent(event)
            before = null
            wentBack = null
            goneBack(b)
            say(SWITCHING_BACK)
            play(b.index, b.at)
            return true
        }
        if (exitCard.visibility == View.VISIBLE) {
            handler.removeCallbacks(leaveAnyway)
            handler.postDelayed(leaveAnyway, EXIT_CARD_MS)
            if (event.keyCode == KeyEvent.KEYCODE_BACK) return true.also { leave(null, asked = true) }
            return true.also { choose(R.id.exitChoices, event.keyCode) }
        }
        if (rateCard.visibility == View.VISIBLE) when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                handler.removeCallbacks(hideRating)
                handler.postDelayed(hideRating, RATE_CARD_MS)
                return true.also { choose(R.id.rateChoices, event.keyCode) }
            }
            // Back puts it away (the film carries on, or, at its end, the player closes).
            KeyEvent.KEYCODE_BACK -> return true.also { hideRateCard() }
            // Play and pause still do, the card staying up.
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> return true.also {
                if (event.keyCode == KeyEvent.KEYCODE_MEDIA_PLAY || (event.keyCode != KeyEvent.KEYCODE_MEDIA_PAUSE && !player.isPlaying)) {
                    // Asked as you left, and you play on: you're staying after all (not once it's ended).
                    if (!leaving) closeAfterRating = false
                    vlcDo { player.play() }
                } else vlcDo { player.pause() }
            }
            // Anything else (Up, Down) does nothing: a stray press mustn't throw the question away.
            else -> return true
        }
        if (upNext.visibility == View.VISIBLE) when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> return true.also { playNext() }
            // Back (or going back) means "let me watch the end": no autoplay this time.
            KeyEvent.KEYCODE_BACK -> return true.also { upNextDismissed = true; hideUpNext() }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> { upNextDismissed = true; hideUpNext() }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE ->
                return true.also { mediaKey(event.keyCode); if (upNext.visibility == View.VISIBLE) upNextPlay.requestFocus() }
            // Skipping forward is heading for the next episode: Up next and its countdown stay.
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> return true.also {
                scrub(1, event.repeatCount)
                if (upNext.visibility == View.VISIBLE) upNextPlay.requestFocus()
            }
            else -> return true
        }
        val code = event.keyCode
        when (code) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE ->
                return true.also { mediaKey(code) }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> return true.also { scrub(1, event.repeatCount) }
            KeyEvent.KEYCODE_MEDIA_REWIND -> return true.also { scrub(-1, event.repeatCount) }
        }
        if (panel.visibility == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_BACK) return true.also { closePanel() }
            handler.removeCallbacks(hideControls)
            return super.dispatchKeyEvent(event)
        }
        if (!controlsShown) {
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT -> scrub(-1, event.repeatCount)
                KeyEvent.KEYCODE_DPAD_RIGHT -> scrub(1, event.repeatCount)
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> togglePause()
                KeyEvent.KEYCODE_DPAD_UP -> setControls(true)
                KeyEvent.KEYCODE_DPAD_DOWN -> {
                    setControls(true)
                    findViewById<View>(R.id.chipSubtitles).requestFocus()
                }
                KeyEvent.KEYCODE_BACK -> when {
                    shouldAskOnLeaving() -> askOnLeaving()
                    shouldRateOnLeaving() -> rateOnLeaving()
                    else -> leave(null, asked = false)
                }
                else -> return super.dispatchKeyEvent(event)
            }
            return true
        }
        scheduleHide()
        if (code == KeyEvent.KEYCODE_BACK) return true.also { setControls(false) }
        if (timeline.hasFocus()) {
            when (code) {
                KeyEvent.KEYCODE_DPAD_LEFT -> return true.also { scrub(-1, event.repeatCount) }
                KeyEvent.KEYCODE_DPAD_RIGHT -> return true.also { scrub(1, event.repeatCount) }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> return true.also { togglePause() }
                KeyEvent.KEYCODE_DPAD_UP -> return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** "Hindi isn't available right now. Still in English." (the second part when another is heard). */
    private fun notAvailableNow(name: String) =
        "$name isn't available right now." + (heardNow()?.takeIf { it != name }?.let { " Still in $it." } ?: "")

    private fun showNote(text: String, stays: Long = 1_800L) {
        held = false
        note.text = text
        note.animate().cancel()
        note.animate().alpha(1f).setDuration(150).withEndAction {
            note.animate().alpha(0f).setStartDelay(stays).setDuration(400).start()
        }.start()
    }

    /** The note stays up ("Switching to Hindi…") until [letGo]. */
    private var held = false

    private fun hold(text: String) {
        held = true
        note.text = text
        note.animate().cancel()
        note.animate().alpha(1f).setDuration(150).start()
    }

    private fun letGo() {
        if (!held) return
        held = false
        note.animate().cancel()
        note.animate().alpha(0f).setDuration(400).start()
    }

    // ---------- The side panel: audio, subtitles, sources, picture ----------

    private fun openPanel(title: String, widthDp: Int = PANEL_DP, build: () -> Unit) {
        panel.layoutParams.width = dp(widthDp)
        panelTitle.text = title
        panelItems.removeAllViews()
        build()
        anchorPanel()
        panel.visibility = View.VISIBLE
        handler.removeCallbacks(hideControls)
        // Focus the chosen entry, or the first one.
        val chosen = (0 until panelItems.childCount).map { panelItems.getChildAt(it) }
            .firstOrNull { it.getTag(R.id.tag_chosen) == true } ?: panelItems.getChildAt(0)
        // Start at the top so Off and Timing stay in view; focusing scrolls only as far as needed.
        findViewById<ScrollView>(R.id.panelScroll).scrollTo(0, 0)
        chosen?.requestFocus()
    }

    /** Pops the panel up from the chip that opened it: just above it, left edges lined up. */
    private fun anchorPanel() {
        val chip = lastChip ?: return
        val root = panel.parent as View
        val at = IntArray(2).also { chip.getLocationInWindow(it) }
        val from = IntArray(2).also { root.getLocationInWindow(it) }
        val width = panel.layoutParams.width
        (panel.layoutParams as android.widget.FrameLayout.LayoutParams).apply {
            gravity = android.view.Gravity.BOTTOM or android.view.Gravity.START
            leftMargin = (at[0] - from[0]).coerceAtMost(root.width - width - dp(24)).coerceAtLeast(dp(24))
            bottomMargin = root.height - (at[1] - from[1]) + dp(10)
            topMargin = dp(28)
            rightMargin = 0
        }
        panel.requestLayout()
        panel.pivotX = 0f
        panel.alpha = 0f
        panel.scaleX = 0.94f
        panel.scaleY = 0.94f
        panel.post {
            panel.pivotY = panel.height.toFloat()
            panel.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(180)
                .setInterpolator(android.view.animation.DecelerateInterpolator()).start()
        }
    }

    /** Back to the chip the panel came from (or the timeline once the controls are hidden). */
    private fun closePanel() {
        panel.visibility = View.GONE
        if (controlsShown) (lastChip ?: timeline).requestFocus()
        scheduleHide()
    }

    private val lastChip: View? get() = CHIPS.map { findViewById<View>(it) }.firstOrNull { it.getTag(R.id.tag_chosen) == true }

    private fun markChip(id: Int) = CHIPS.forEach { findViewById<View>(it).setTag(R.id.tag_chosen, it == id) }

    private fun item(label: String, detail: String? = null, chosen: Boolean = false, detailOnFocus: Boolean = false, onPick: () -> Unit): View {
        val v = LayoutInflater.from(this).inflate(R.layout.panel_item, panelItems, false)
        v.findViewById<TextView>(R.id.tick).text = if (chosen) "✓" else ""
        v.findViewById<TextView>(R.id.label).text = label
        v.findViewById<TextView>(R.id.detail).apply {
            text = detail
            visibility = if (detail.isNullOrBlank() || detailOnFocus) View.GONE else View.VISIBLE
            if (detailOnFocus && !detail.isNullOrBlank()) v.setOnFocusChangeListener { _, has ->
                visibility = if (has) View.VISIBLE else View.GONE
            }
        }
        v.setTag(R.id.tag_chosen, chosen)
        v.setOnClickListener { onPick() }
        panelItems.addView(v)
        return v
    }

    private fun header(text: String) {
        val v = TextView(this).apply {
            this.text = text
            textSize = 7.5f
            letterSpacing = 0.14f
            isAllCaps = true
            setTextColor(getColor(R.color.muted))
            setPadding(dp(10), dp(10), 0, dp(3))
        }
        panelItems.addView(v)
    }

    /** VLC's "Track 1 - [English]" or "SDH - [English]" as ("English", "SDH"). */
    private fun trackName(raw: String): Pair<String, String?> {
        val m = Regex("""^(.*?)\s*-\s*\[(.+)]$""").find(raw.trim()) ?: return raw to null
        val extra = m.groupValues[1].trim().takeUnless { it.isEmpty() || Regex("""(?i)^track \d+$""").matches(it) }
        return m.groupValues[2] to extra
    }

    /** "The.Office.US.S05E13.720p.WEB-DL.en.srt" as "The Office US S05E13 720p WEB-DL". */
    private fun releaseName(raw: String) = raw
        .replace(Regex("""(?i)(\.[a-z]{2,3})?\.(srt|vtt|ass|sub)$"""), "")
        .replace(Regex("""[._]+"""), " ").trim()

    /** A JSON string field, or null when it's missing, empty or null. */
    private fun JSONObject.text(key: String) = optString(key).takeIf { it.isNotBlank() && it != "null" }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    /**
     * Audio: one list of languages, as Netflix's. Those this file has switch in it at once; one only
     * another version has switches to that version (findVersion), from the same moment. Which file
     * it is never shows. A track that doesn't say its language is "Audio 2".
     */
    private fun showAudio() {
        markChip(R.id.chipAudio)
        // More sources may bring more languages: asked for now, and the panel fills in when they come.
        lookForMoreQuietly { if (panel.visibility == View.VISIBLE && panelTitle.text == "Audio") showAudio() }
        val tracks = audioTracks()
        val playing = tracks.indexOfFirst { it.id == audioTrackNow() }
        // This file's: one row per language (the first track of it; a commentary only if there's no
        // other), and each track that doesn't say, by its number.
        val here = tracks.withIndex()
            .sortedBy { it.value.name.contains("comment", true) }
            .distinctBy { (i, t) -> trackLanguage(t.name) ?: "#$i" }
            .sortedBy { it.index }
        val hereCodes = here.mapNotNull { trackLanguage(it.value.name) }
        // Languages only other versions have.
        val elsewhere = languagesElsewhere()
            .filter { it !in hereCodes && SPOKEN.containsKey(it) }
        val now = playing.takeIf { it >= 0 }?.let { trackLanguage(tracks[it].name) }
        openPanel("Audio") {
            if (here.isEmpty() && elsewhere.isEmpty()) item("Only one audio track") {}
            here.forEach { (i, t) ->
                val code = trackLanguage(t.name)
                val label = code?.let { SPOKEN[it] } ?: "Audio ${i + 1}"
                val chosen = if (code != null) code == now else i == playing
                item(label, chosen = chosen) {
                    closePanel()
                    cancelPick()
                    if (chosen) {
                        // The one playing, picked while another is wanted (a saved Hindi this episode lacks):
                        // this one is wanted now, and kept for the title.
                        if (code != null && audioWant != null && code != audioWant) {
                            picked(code)
                            handler.post(checkAudio)
                        }
                        return@item
                    }
                    vlcDo { player.setAudioTrack(t.id) }
                    // For this play and the episodes after it, and kept for the title (Settings is where the
                    // profile's is changed); the profile's own language picked clears it.
                    if (code != null) picked(code)
                    pickedTrack = keyAt(current) to i
                    // (A track that doesn't say its language goes on, by its number, in the same release.)
                    carriedTrack = if (code == null) streams.getOrNull(current)?.bingeGroup?.let { "$it|$i" } else null
                    // libVLC has a few seconds of the old one buffered: dropped, so it's heard at once.
                    if (seekable()) {
                        val at = time()
                        vlcDo { player.setTime(at) }
                        switching(label, at)
                    } else showNote("Audio: $label")
                    noteRescue(crashedOpening = false)
                }
            }
            elsewhere.forEach { code ->
                val name = SPOKEN[code] ?: code
                item(name) {
                    closePanel()
                    findVersion(code, name)
                }
            }
        }
    }

    /** The quality picked in the Quality panel ("1080p"), or null for Auto: for this play only. */
    private var qualityWant: String? = null

    /**
     * Quality: Auto, then each quality there's a file of in the language playing (4K, 1080p, 720p,
     * SD). A quality switches to the best file of it in that language, from the same moment; Auto
     * leaves the choosing to the player (and says what it's playing).
     */
    private fun showQuality() {
        markChip(R.id.chipQuality)
        val lang = languageNow()
        // The files a quality pick can switch to: not another's, downloaded, not failed this play.
        val failedHere = (tried - played) + rejected + keyAt(current)
        val usable = streams.indices.filter { i -> streams[i].let { s -> !s.suspect && s.cached != false && (s.youtube != null || s.url.isNotEmpty()) } &&
            keyAt(i) !in failedHere }
        // (In the language playing when any of these files have it; otherwise any of them. The pick below
        // goes by the same set.)
        val speakers = usable.filter { speaks(it, lang) }
        val langKnown = speakers.isNotEmpty()
        val inLang = speakers.ifEmpty { usable }
        val qualities = QUALITIES.filter { q -> inLang.any { streams[it].resolution == q } || streams.getOrNull(current)?.resolution == q }
        val playing = streams.getOrNull(current)?.resolution?.let { QUALITY_NAMES[it] }
        openPanel("Quality") {
            item("Auto", if (qualityWant == null) playing else null, chosen = qualityWant == null) {
                closePanel()
                cancelPick()
                qualityWant = null
            }
            qualities.forEach { q ->
                val name = QUALITY_NAMES[q] ?: q
                item(name, chosen = qualityWant == q) {
                    closePanel()
                    if (qualityWant == q) return@item
                    cancelPick()
                    val previous = qualityWant
                    qualityWant = q
                    if (streams.getOrNull(current)?.resolution == q) return@item
                    // The best one of it in this language, by the same order as everything else (one
                    // that failed this play is never tried again; one that played well may be).
                    // (Only files of that quality, in the language playing when there are any in it: the others
                    // count as tried for this choice, so a quality pick never quietly changes the language.)
                    val other = streams.indices.filter { streams[it].resolution != q || (langKnown && !speaks(it, lang)) }.map(::keyAt)
                    val pick = PlayOrder.next(orderFiles(), failedHere + other, lang, q, profileAudio.lastOrNull())
                        .takeIf { it >= 0 } ?: return@item run { qualityWant = previous; showNote("$name isn't available for this one", ERROR_NOTE_MS) }
                    switchTo(pick, "Switching to $name…", language = null, quality = name, previousQuality = previous)
                }
            }
            // The way out of a file that plays but is wrong (another episode, sound out of step): the next
            // copy, in the same language and quality when there is one, from the same moment. This one is
            // never tried again in this play, and there's no going back to it.
            // After the good copies: one that runs far from the title's length (may be cut, or another
            // episode), said plainly once it plays.
            // (Not one that can't be had now: refused, busy or being prepared.)
            val order = orderFiles()
            val now = System.currentTimeMillis()
            val nearMiss = streams.indices.filter { i -> streams[i].let { s -> s.otherLength != null && s.otherEpisode == null &&
                s.cached != false && (s.youtube != null || s.url.isNotEmpty()) } && keyAt(i) !in failedHere &&
                order[i].let { f -> !f.skipped && (f.busyUntil ?: 0) <= now && (f.preparingUntil ?: 0) <= now } }
            if (usable.isNotEmpty() || nearMiss.isNotEmpty()) item(TRY_ANOTHER) {
                closePanel()
                cancelPick()
                val here = streams.getOrNull(current)?.resolution?.takeIf { it.isNotEmpty() }
                val good = PlayOrder.next(orderFiles(), failedHere, lang, here, profileAudio.lastOrNull()).takeIf { it >= 0 }
                val pick = good ?: nearMiss.minWithOrNull(compareBy({ if (speaks(it, lang)) 0 else 1 },
                    { if (streams[it].resolution == here) 0 else 1 }, { it }))
                    ?: return@item showNote("There isn't another version of this one", ERROR_NOTE_MS)
                rejected += keyAt(current)
                startNote = if (good == null) MAY_NOT_BE_RIGHT else null
                switchTo(pick, SWITCHING, language = null, canGoBack = false)
            }
        }
    }

    /** Said once the file being switched to plays (a copy that may not be right). */
    private var startNote: String? = null

    /** Files the viewer left with "Try another version" this play: never offered or tried again. */
    private val rejected = mutableSetOf<String>()

    private fun showSubtitles(language: String? = null) {
        markChip(R.id.chipSubtitles)
        val want = language ?: subsWant().takeIf { it != OFF } ?: "eng"
        val inside = player.spuTracks?.filter { it.id >= 0 }.orEmpty()
        // VLC lists a loaded online subtitle as a track too; it's shown under Online instead.
        val ownTracks = inside.dropLast(slavesAdded)
        val selected = player.spuTrack
        openPanel("Subtitles") {
            item("Off", chosen = selected < 0) {
                vlcDo { player.setSpuTrack(-1) }
                onlineSub = null
                pickedSubs(OFF)
                closePanel()
            }
            timingItem()
            if (ownTracks.isNotEmpty()) header("In this file")
            ownTracks.forEach { t ->
                val (label, detail) = trackName(t.name)
                item(label, detail, chosen = onlineSub == null && t.id == selected) {
                    vlcDo { player.setSpuTrack(t.id) }
                    onlineSub = null
                    rememberSubs(t.name)
                    closePanel()
                }
            }
            val byLang = subtitles.groupBy { it.lang }
            byLang[want]?.let { subs ->
                header("Online · ${subs.first().language}")
                subs.take(12).forEach { s ->
                    item(releaseName(s.release).ifBlank { s.language }, s.language, chosen = onlineSub?.url == s.url) {
                        addOnline(s)
                        pickedSubs(s.lang)
                        closePanel()
                        showNote("Subtitles: ${s.language}")
                    }
                }
            }
            val others = byLang.filterKeys { it != want }
            if (others.isNotEmpty()) header("Other languages")
            others.forEach { (lang, subs) ->
                item(subs.first().language, "${subs.size} subtitle${if (subs.size == 1) "" else "s"}") { showSubtitles(lang) }
            }
        }
    }

    private fun rememberSubs(trackName: String) {
        // (A track that doesn't say its language: subtitles are on for this show, in its usual language.)
        val code = LANG_NAMES.entries.firstOrNull { trackName.contains(it.value, true) }?.key
            ?: subsWant().takeIf { it != OFF } ?: prefs.getString(PREF_SUBS, "eng")!!.takeIf { it != OFF } ?: "eng"
        pickedSubs(code)
    }

    /** "Timing": Left/Right on it moves subtitles 0.1 s earlier or later. */
    private fun timingItem() {
        val v = item("Timing", timingText()) {}
        v.setOnKeyListener { _, keyCode, e ->
            if (e.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
            val step = when (keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> -SUB_STEP_US
                KeyEvent.KEYCODE_DPAD_RIGHT -> SUB_STEP_US
                else -> return@setOnKeyListener false
            }
            subDelayUs += step
            vlcDo { player.setSpuDelay(subDelayUs) }
            v.findViewById<TextView>(R.id.detail).text = timingText()
            true
        }
    }

    private fun timingText(): String {
        val s = subDelayUs / 1_000_000.0
        val shown = String.format("%+.1f s", s)
        return when {
            s > 0.05 -> "$shown  ·  shown later  ·  ◀ ▶ to adjust"
            s < -0.05 -> "$shown  ·  shown earlier  ·  ◀ ▶ to adjust"
            else -> "In sync  ·  ◀ ▶ to adjust"
        }
    }

    /** Plays source [i] from where this one is, saying [status] while it opens (over the picture). */
    private fun switchTo(i: Int, status: String, want: String? = audioWant, language: String? = null, quality: String? = null,
                         previousQuality: String? = qualityWant, canGoBack: Boolean = true) {
        failures = 0
        val at = resumeFrom()
        if (!canGoBack) before = null
        if (started && canGoBack) before = Before(current, at, audioWant, language, heardNow(), quality,
            streams.getOrNull(current)?.resolution?.let { QUALITY_NAMES[it] }, previousQuality)
        audioWant = want
        showLoading()
        say(status)
        // (A picked version gets less time to start: if it doesn't, straight back to the one before.)
        play(i, at, timeout = if (started || before != null) PICK_START_TIMEOUT_MS else START_TIMEOUT_MS)
    }

    /** The pick guard: which pick (a language look, a quality) is the latest, so an older one's late
     *  answer is ignored. */
    private var versionLook = 0
    /** The language a look is under way for (its name), so a failure meanwhile can cancel it. */
    private var lookingFor: String? = null

    /** A new pick (a track here, a quality, Auto, another language): any language look under way is called
     *  off, and its "Switching to…" note goes. */
    private fun cancelPick() {
        versionLook++
        if (lookingFor != null) {
            lookingFor = null
            letGo()
        }
    }

    /**
     * A language only other versions list: the server reads the best few of those files' own track
     * lists (their names can be wrong), and the first that has it is switched to, from the same
     * moment, opened straight in it (by its track's number). One that couldn't be read is only switched
     * to when none could be confirmed and none was shown not to have it. What's playing carries on
     * meanwhile, saying so from the moment it's picked; if the new one won't play, or hasn't the
     * language after all, back to this one, where it was.
     */
    private fun findVersion(code: String, name: String) {
        val files = orderFiles()
        val original = profileAudio.lastOrNull()
        // The files that speak it by the one rule: its header says so, then its name, then names none;
        // verified first within each; never another's file, one not downloaded, or one that failed.
        val all = switchable()
            .filter { PlayOrder.speaks(files[it], code, original) }
            .sortedWith(compareBy({ PlayOrder.level(files[it], code, original) }, { if (streams[it].verified) 0 else 1 }))
        cancelPick()
        if (all.isEmpty()) return showNote("$name isn't available for this one", ERROR_NOTE_MS)
        val look = versionLook
        // Its own header already says so: switched to at once.
        if (PlayOrder.level(files[all.first()], code, original) == 0) {
            pendingPick = code
            return switchTo(all.first(), "Switching to $name…", want = code, language = name)
        }
        // (By key: more sources may be merged while the versions are read, which moves the list.)
        val candidates = all.take(VERSIONS_CHECKED).map { keyAt(it) to streams[it] }
        lookingFor = name
        hold("Switching to $name…")
        Thread {
            val found = runCatching {
                val body = JSONObject().put("links", JSONArray(candidates.map { it.second.url })).toString()
                    .toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url(Server.url + "/launcher/audio-languages").post(body).build()
                Feed.slow.newCall(request).execute().use { r ->
                    check(r.isSuccessful) { "HTTP ${r.code}" }
                    JSONObject(r.body!!.string()).getJSONArray("languages")
                }
            }.onFailure { Log.w(TAG, "Couldn't check the versions' audio", it) }.getOrNull()
            handler.post {
                if (isFinishing || look != versionLook) return@post
                lookingFor = null
                if (found == null) return@post run { letGo(); showNote(notAvailableNow(name), ERROR_NOTE_MS) }
                val read = candidates.indices.map { k -> found.optJSONArray(k)?.let { a -> (0 until a.length()).map { a.getString(it) } } }
                val has = candidates.indices.firstOrNull { read[it]?.contains(code) == true }
                // (A track that doesn't say its language may be it, in a file named for it; one naming no
                // language only when its header was read: an empty read never qualifies it.)
                val maybe = candidates.indices.firstOrNull { k ->
                    val named = code in candidates[k].second.languages
                    if (named) read[k] == null || read[k]!!.contains("und") else read[k] == listOf("und")
                }
                val pick = has ?: maybe ?: return@post run { letGo(); showNote("$name isn't available for this one", ERROR_NOTE_MS) }
                val index = keys.indexOf(candidates[pick].first)
                if (index < 0) return@post run { letGo(); showNote(notAvailableNow(name), ERROR_NOTE_MS) }
                pendingPick = code
                // What its header said, in order: it's opened straight in that track.
                read[pick]?.let { streams = streams.toMutableList().also { l -> l[index] = l[index].copy(audio = it) } }
                letGo()
                switchTo(index, "Switching to $name…", want = code, language = name)
            }
        }.start()
    }

    private fun showPicture() {
        markChip(R.id.chipPicture)
        val now = player.videoScale
        openPanel("Picture") {
            listOf(
                Triple("Fit", "The whole picture, black bars if needed", MediaPlayer.ScaleType.SURFACE_BEST_FIT),
                Triple("Fill screen", "No black bars, edges cropped", MediaPlayer.ScaleType.SURFACE_FIT_SCREEN),
                Triple("Stretch", "Fill the screen, picture stretched", MediaPlayer.ScaleType.SURFACE_FILL),
            ).forEach { (label, detail, scale) ->
                item(label, detail, chosen = now == scale) {
                    vlcDo { player.videoScale = scale }
                    closePanel()
                }
            }
        }
    }

    /** The episodes of this season: watched ones ticked, this one marked; OK plays one. */
    private fun showEpisodes() {
        markChip(R.id.chipEpisodes)
        val (imdbId, season) = videoId.split(':').let { it[0] to it[1] }
        openPanel("Season $season", EPISODES_PANEL_DP) { Waiting.on(item("Loading episodes…") {}) }
        io.execute {
            // Fresh: the ticks change as you watch (the server drops its copy when they do).
            val page = runCatching { Pages.parsePage(Pages.get(Pages.titlePath("series", imdbId), fresh = true)) }
                .onFailure { Log.w(TAG, "Episodes unavailable", it) }.getOrNull()
            handler.post {
                if (isFinishing || panel.visibility != View.VISIBLE || panelTitle.text.toString() != "Season $season") return@post
                val episodes = page?.sections?.firstOrNull { it.id == "s$season" }?.cards
                panelItems.removeAllViews()
                if (episodes.isNullOrEmpty()) return@post run { item("Couldn't load the episodes") {}.requestFocus() }
                var here: View? = null
                episodes.forEach { e -> episodeRow(e).also { if (e.id == videoId) here = it } }
                (here ?: panelItems.getChildAt(0)).requestFocus()
            }
        }
    }

    private fun episodeRow(e: Card): View {
        val v = LayoutInflater.from(this).inflate(R.layout.item_player_episode, panelItems, false)
        v.findViewById<ImageView>(R.id.episodeStill).load(e.thumbnail)
        val number = e.episode?.substringAfter(' ')
        v.findViewById<TextView>(R.id.episodeName).text = listOfNotNull(number, e.name).joinToString("  ·  ")
        v.findViewById<TextView>(R.id.episodeState).text = when {
            e.id == videoId -> "Playing now"
            e.upcoming -> e.aired?.let { "Not out yet · $it" } ?: "Not out yet"
            e.watched -> "✓ Watched"
            e.progress != null -> "${(e.progress * 100).toInt()}% watched"
            else -> e.aired.orEmpty()
        }
        e.progress?.takeIf { e.id != videoId }?.let { f ->
            v.findViewById<View>(R.id.episodeProgress).apply { visibility = View.VISIBLE; scaleX = f.coerceIn(0f, 1f) }
        }
        v.setTag(R.id.tag_chosen, e.id == videoId)
        v.setOnClickListener {
            when {
                e.id == videoId -> closePanel()
                e.upcoming -> showNote("Not out yet")
                else -> openEpisode(e)
            }
        }
        panelItems.addView(v)
        return v
    }

    /** Plays another episode from the list; this one keeps its place. */
    private fun openEpisode(e: Card) {
        if (leaving) return
        handler.removeCallbacks(tickDown)
        saveProgress()
        leaving = true
        startActivity(intent(this, type, e.id, intent.getStringExtra(EXTRA_NAME).orEmpty(),
            listOfNotNull(e.episode, e.name).joinToString("  ·  "), intent.getStringExtra(EXTRA_ART),
            streams.getOrNull(current)?.bingeGroup, source.copy(origin = "direct", row = null, slot = null)).let(::carry))
        finish()
    }

    // ---------- Watch position ----------

    /** Tells the server where we're up to (it keeps Continue watching and the play history). */
    private fun saveProgress(finished: Boolean = false) {
        if (!everStarted) return
        // (Mid-switch or reconnecting: where it had got to, in the file that was playing.)
        val duration = if (started) len() else goodLength
        val position = if (finished) duration else if (started) scrubTo ?: time() else lastGood
        if (position <= 0 || duration <= 0) return
        // (Only the ending says it's finished: a place at or past the length is no place to resume.)
        if (!finished && position >= duration) return
        // Paused (nothing moved since): nothing new to say.
        // (Unmoved since the last save: nothing to send, unless a pick is waiting to be saved.)
        if (!finished && position == savedAt && subsToSave == null && (pickToSave == null || !pickHeard)) return
        savedAt = position
        post("/launcher/progress", progressBody(position, duration))
    }

    private var savedAt = -1L

    /** Position, real playback time since the last save, audio language and where the play came from. */
    private fun progressBody(position: Long, duration: Long): JSONObject {
        val played = playedMs
        playedMs = 0
        return source.into(JSONObject().put("type", type).put("id", videoId).put("position", position)
            .put("duration", duration).put("played", played)).apply {
                audioLanguage()?.let { put("audioLanguage", it) }
                // A language picked in the player, once it's been heard: kept for this title (the server
                // stores it from its next version; "" clears it). Sent until a save goes through.
                pickToSave?.takeIf { pickHeard }?.let { put("audioPick", it) }
                subsToSave?.let { put("subtitlePick", it) }
            }
    }

    private fun post(path: String, body: JSONObject) {
        val request = body.toString().toRequestBody("application/json".toMediaType())
        val pick = body.optString("audioPick", null as String?)
        val subs = body.optString("subtitlePick", null as String?)
        io.execute {
            runCatching {
                Feed.http.newCall(Request.Builder().url(Server.url + path).post(request).build())
                    .execute().use { check(it.isSuccessful) { "HTTP ${it.code}" } }
                Feed.markChanged()
                // (The pick it carried is kept now: not sent again, unless another pick came meanwhile.)
                if (pick != null) handler.post { if (pickToSave == pick) pickToSave = null }
                if (subs != null) handler.post { if (subsToSave == subs) subsToSave = null }
            }.onFailure { Log.w(TAG, "Couldn't save $path", it) }
        }
    }

    // ---------- What was really watched ----------

    private var playedMs = 0L
    private var lastTime = -1L
    /** Times this source's connection dropped mid-way and it was opened again from there. */
    private var reconnects = 0

    /** Adds the time that actually played: small forward steps while playing, never skips or seeks. */
    private fun countPlayed(time: Long) {
        val step = time - lastTime
        if (lastTime >= 0 && player.isPlaying && scrubTo == null && step in 1..2_000) playedMs += step
        lastTime = time
    }

    /** The audio track's language as a three-letter code ("eng", "hin"), when VLC names it. */
    private fun audioLanguage(): String? {
        val name = audioTracks().firstOrNull { it.id == audioTrackNow() }?.name ?: return null
        return LANG_NAMES.entries.firstOrNull { name.contains(it.value, true) }?.key
    }

    // ---------- One-time questions: leaving early, and the rating at the end ----------

    private var source = PlaySource.DIRECT
    private var myRating: Int? = null
    private var asked = emptySet<String>()
    private var finishedEpisodes = 0
    private val exitCard by lazy { findViewById<View>(R.id.exitCard) }
    private val rateCard by lazy { findViewById<View>(R.id.rateCard) }
    private val leaveAnyway = Runnable { leave(null, asked = true) }
    private val hideRating = Runnable { hideRateCard() }

    /** Back after a while but well before the end, the first time for this title. */
    private fun shouldAskOnLeaving(): Boolean {
        val len = length.takeIf { it > 0 } ?: return false
        val t = time()
        return EARLY_EXIT_ASKS && "early_exit" !in asked && t >= EARLY_EXIT_AFTER_MS && t < len * EARLY_EXIT_BEFORE
    }

    private fun askOnLeaving() {
        vlcDo { player.pause() }
        findViewById<TextView>(R.id.exitTitle).apply {
            text = listOfNotNull(intent.getStringExtra(EXTRA_NAME), intent.getStringExtra(EXTRA_EPISODE)).joinToString("  ·  ")
            maxLines = 1
        }
        findViewById<View>(R.id.exitHint).visibility = View.VISIBLE
        val choices = findViewById<LinearLayout>(R.id.exitChoices).apply { removeAllViews() }
        // Just leaving comes first (and has focus), so OK pressed out of habit doesn't say "not for me".
        val later = choice(choices, R.drawable.ic_act_later, "I'll finish later") { leave("later", asked = true) }
        choice(choices, R.drawable.ic_rate_down, "Not for me") { leave("not_for_me", asked = true) }
        exitCard.alpha = 0f
        exitCard.visibility = View.VISIBLE
        exitCard.animate().alpha(1f).setDuration(200).start()
        focusChoice(later)
        handler.postDelayed(leaveAnyway, EXIT_CARD_MS)
    }

    /**
     * Saves where it got to and closes the player. When the card was shown ([asked]), the answer
     * (or none) goes with it, and this title won't be asked about again.
     */
    private fun leave(answer: String?, asked: Boolean) {
        if (leaving) return
        handler.removeCallbacks(leaveAnyway)
        if (asked) {
            leaving = true
            val duration = len()
            post("/launcher/exit", progressBody(time(), duration).apply { answer?.let { put("reason", it) } })
        }
        // Not asked: onStop saves the position as usual.
        finish()
    }

    /** At the end of a film, or a show's latest episode once you've seen a few: asked once, never blocks. */
    private fun maybeAskRating() {
        // (Not over the side panel: it's asked once that's closed, as the end draws nearer.)
        if (!canAskRating() || panel.visibility == View.VISIBLE) return
        askRating()
    }

    /** Whether this title's rating may still be asked: not rated or asked yet, and for a show, its
     *  latest episode once you've seen a few. */
    private fun canAskRating() = myRating == null && "rating" !in asked && rateCard.visibility != View.VISIBLE &&
        !(type == "series" && (nextEpisode != null || finishedEpisodes + 1 < RATE_AFTER_EPISODES))

    /** Back near the end (in the credits, most likely): most leave there rather than at the very end,
     *  so it's asked then, the picture paused, and the player closes once it's answered or put away. */
    private fun shouldRateOnLeaving(): Boolean {
        val len = length.takeIf { it > 0 } ?: return false
        return time() >= len * RATE_ON_LEAVING_FROM && canAskRating()
    }

    private fun rateOnLeaving() {
        vlcDo { player.pause() }
        closeAfterRating = true
        askRating()
    }

    private fun askRating() {
        asked = asked + "rating"
        post("/launcher/prompt", JSONObject().put("id", videoId.substringBefore(':')).put("kind", "rating"))
        findViewById<TextView>(R.id.rateTitle).text = intent.getStringExtra(EXTRA_NAME)
        val choices = findViewById<LinearLayout>(R.id.rateChoices).apply { removeAllViews() }
        rateChoice(choices, R.drawable.ic_rate_down, "Not for me") { rate(-1, "Not for me") }
        val like = rateChoice(choices, R.drawable.ic_rate_up, "I like it") { rate(1, "I like it") }
        rateChoice(choices, R.drawable.ic_rate_love, "Love it") { rate(2, "Love it") }
        // The card has the screen to itself: the controls go, and come back only after it.
        setControls(false)
        rateCard.alpha = 0f
        rateCard.visibility = View.VISIBLE
        rateCard.animate().alpha(1f).setDuration(320).start()
        rateBox.apply { scaleX = 0.94f; scaleY = 0.94f; translationY = 14 * resources.displayMetrics.density }
            .animate().scaleX(1f).scaleY(1f).translationY(0f).setDuration(420).setInterpolator(Motion.ease).start()
        focusChoice(like)
        handler.postDelayed(hideRating, RATE_CARD_MS)
    }

    private fun rate(value: Int, label: String) {
        myRating = value
        post("/launcher/rating", JSONObject().put("id", videoId.substringBefore(':')).put("value", value))
        showNote(label)
        hideRateCard(answered = true)
    }

    /** Puts the rating card away. When the video has ended under it, the player then closes: at once,
     *  or, [answered], once the answer has been seen ("Love it"). */
    private fun hideRateCard(answered: Boolean = false) {
        handler.removeCallbacks(hideRating)
        if (rateCard.visibility != View.VISIBLE || rateClosing) return
        rateClosing = true
        rateBox.animate().scaleX(0.96f).scaleY(0.96f).setDuration(220).start()
        rateCard.animate().alpha(0f).setDuration(220).withEndAction {
            rateCard.visibility = View.GONE
            rateClosing = false
            if (closeAfterRating) handler.postDelayed({ finish() }, if (answered) ANSWER_SEEN_MS else 0L)
            else focusTimeline()
        }.start()
    }

    private var rateClosing = false
    /** The video ended while the rating card was up, or it was asked as you left: the player closes
     *  once it's put away. */
    private var closeAfterRating = false
    private val rateBox by lazy { findViewById<View>(R.id.rateBox) }

    /** A rating card choice: a glass disc that lifts, with a soft light round it, when focused. */
    private fun rateChoice(parent: LinearLayout, icon: Int, label: String, onPick: () -> Unit): View =
        LayoutInflater.from(this).inflate(R.layout.rate_choice, parent, false).apply {
            findViewById<ImageView>(R.id.choiceIcon).setImageResource(icon)
            findViewById<TextView>(R.id.choiceLabel).text = label
            setOnClickListener { onPick() }
            setOnFocusChangeListener { v, has ->
                val scale = if (has) 1.14f else 1f
                v.findViewWithTag<View>("disc").animate().scaleX(scale).scaleY(scale).setDuration(240).setInterpolator(Motion.ease).start()
                v.findViewWithTag<View>("halo").animate().alpha(if (has) 1f else 0f).setDuration(240).start()
            }
            parent.addView(this)
        }

    /** Left/Right move between a card's choices, OK picks the highlighted one. */
    private fun choose(listId: Int, keyCode: Int) {
        val list = findViewById<LinearLayout>(listId)
        val items = (0 until list.childCount).map { list.getChildAt(it) }
        val at = items.indexOfFirst { it.isFocused }.coerceAtLeast(0)
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> items.getOrNull(at - 1)?.requestFocus()
            KeyEvent.KEYCODE_DPAD_RIGHT -> items.getOrNull(at + 1)?.requestFocus()
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> items.getOrNull(at)?.performClick()
        }
    }

    /** Puts focus on a card's choice once the card is laid out (asking straight away can miss). */
    private fun focusChoice(view: View) {
        view.isFocusableInTouchMode = true
        view.post { view.requestFocus() }
    }

    private fun choice(parent: LinearLayout, icon: Int, label: String, onPick: () -> Unit): View =
        LayoutInflater.from(this).inflate(R.layout.choice_button, parent, false).apply {
            findViewById<ImageView>(R.id.choiceIcon).setImageResource(icon)
            findViewById<TextView>(R.id.choiceLabel).text = label
            setOnClickListener { onPick() }
            parent.addView(this)
        }

    // ---------- Up next ----------

    private var nextEpisode: NextEpisode? = null
    private var upNextDismissed = false
    private var countdown = 0
    /** Set once we've saved the final position ourselves, so leaving doesn't overwrite it. */
    private var leaving = false
    private val upNext by lazy { findViewById<View>(R.id.upNext) }
    private val upNextPlay by lazy { findViewById<TextView>(R.id.upNextPlay) }
    private val tickDown = object : Runnable {
        override fun run() {
            if (player.isPlaying) countdown--
            if (countdown <= 0) return playNext()
            upNextPlay.text = "▶  Play now  ·  $countdown"
            handler.postDelayed(this, 1_000)
        }
    }

    /** Shows Up next in the last stretch of an episode; seeking back out of it hides it again. */
    /** A length this title can't have: far shorter than it runs (an error clip or a sample), or
     *  shorter than where we resume. Without the server's running time, only a clip under a minute
     *  and a half counts (some episodes really are a few minutes long). */
    private fun notTheVideo(len: Long, ended: Boolean = false): Boolean {
        val tooShort = if (expectedMs > 0) (expectedMs * SHORTEST_PART).toLong() else MIN_UNKNOWN_LENGTH_MS
        // (Shorter than where it resumes only counts without the title's length to go by: a faster
        // copy of it, 25 frames a second, ends a few minutes sooner.)
        return (len > 0 || ended) && (len < tooShort || (expectedMs <= 0 && len < resumeAt))
    }

    private fun checkUpNext(time: Long) {
        val len = length.takeIf { it > 0 && !notTheVideo(it) } ?: return
        if (len - time <= UP_NEXT_AT_MS && scrubTo == null && nextEpisode == null) maybeAskRating()
        val next = nextEpisode ?: return
        // In the last few minutes, the next episode's sources are found ahead of time.
        if (started && len - time <= PREFETCH_BEFORE_MS) prefetchNext(next)
        val inEnd = len - time <= UP_NEXT_AT_MS
        val shown = upNext.visibility == View.VISIBLE
        when {
            inEnd && !shown && !upNextDismissed && scrubTo == null && panel.visibility != View.VISIBLE -> {
                findViewById<TextView>(R.id.upNextName).text = next.label
                findViewById<ImageView>(R.id.upNextStill).load(next.still)
                countdown = UP_NEXT_COUNTDOWN
                upNextPlay.text = "▶  Play now  ·  $countdown"
                upNext.alpha = 0f
                upNext.visibility = View.VISIBLE
                upNext.animate().alpha(1f).setDuration(250).start()
                upNextPlay.isFocusable = true
                upNextPlay.requestFocus()
                handler.postDelayed(tickDown, 1_000)
            }
            !inEnd && shown -> hideUpNext()
            !inEnd -> upNextDismissed = false
        }
    }

    /** Whether playback is in the last stretch (where Up next shows): the episode counts as finished. */
    private fun inCredits(): Boolean {
        val len = length.takeIf { it > 0 } ?: return false
        return len - time() <= UP_NEXT_AT_MS
    }

    /** What this episode asked for ahead of time; asked once (again only if the source changed). */
    private var prefetched: String? = null

    private fun prefetchNext(next: NextEpisode) {
        // Handing over (or gone): the next episode is taking, or has taken, what was fetched.
        if (leaving || isFinishing) return
        val path = playPath(type, next.id, streams.getOrNull(current)?.bingeGroup, pickState)
        if (path == prefetched) return
        prefetched = path
        val want = audioWant
        // Every source asked straight after, unseen, when the answer hasn't the picked language and the
        // server has more (and a more answer in this binge hasn't already come back without it).
        NextUp.fetch(path, ::playCall) { json ->
            val missing = want != null && wantMissing != want && json.optBoolean("moreSources") &&
                parseStreams(json).none { s ->
                    PlayOrder.speaks(PlayOrder.File("", s.verified, languages = s.audio ?: s.languages), want, json.text("originalLanguage"))
                }
            if (missing) path + (if ('?' in path) "&" else "?") + "more=1" else null
        }
    }

    private fun hideUpNext() {
        handler.removeCallbacks(tickDown)
        upNext.visibility = View.GONE
        timeline.requestFocus()
    }

    /**
     * Opens the next episode, keeping to the same release. This one is saved as finished, unless
     * [finished] is false (skipped mid-way with the Next episode button): then it keeps its place.
     */
    private fun playNext(finished: Boolean = true) {
        val next = nextEpisode ?: return
        if (leaving) return
        handler.removeCallbacks(tickDown)
        saveProgress(finished = finished)
        leaving = true
        startActivity(intent(this, type, next.id, intent.getStringExtra(EXTRA_NAME).orEmpty(), next.label,
            intent.getStringExtra(EXTRA_ART), streams.getOrNull(current)?.bingeGroup,
            source.copy(origin = "up_next", row = null, slot = null)).let(::carry))
        finish()
    }

    override fun onStop() {
        super.onStop()
        if (!leaving) saveProgress()
        // Leaving the player (Home, another app) ends playback; the position is saved.
        if (!isChangingConfigurations) finish()
    }

    /** For Play on TV (see NowPlaying). */
    private val asPlayer = object : NowPlaying.Player {
        override fun pauseForQuestion() =
            (::player.isInitialized && player.isPlaying).also { if (it) vlcDo { player.pause() } }
        override fun carryOn() {
            if (::player.isInitialized) vlcDo { player.play() }
        }
        override fun close() = finish()
    }

    override fun onResume() {
        super.onResume()
        NowPlaying.current = asPlayer
    }

    override fun onDestroy() {
        super.onDestroy()
        if (NowPlaying.current === asPlayer) NowPlaying.current = null
        PlayerRescue.clear(this, rescueToken)
        handler.removeCallbacksAndMessages(null)
        // (Not made when the player closed at once, without a title to play.)
        if (::player.isInitialized) {
            player.setEventListener(null)
            released = true
            // (Stopped on the lane, after whatever it was doing; its views let go on the main thread once
            // it's stopped; then released.)
            val main = Handler(Looper.getMainLooper())
            vlcThread.execute {
                runCatching { player.stop() }
                main.post {
                    runCatching { player.detachViews() }
                    Thread {
                        runCatching {
                            player.release()
                            vlc.release()
                        }.onFailure { Log.w(TAG, "Couldn't let the player go", it) }
                    }.start()
                }
            }
        }
        vlcThread.shutdown()
        moreIo.shutdown()
        io.shutdown()
    }

    companion object {
        private const val TAG = "Nightcap"
        private const val EXTRA_TYPE = "type"
        private const val EXTRA_ID = "id"
        private const val EXTRA_NAME = "name"
        private const val EXTRA_EPISODE = "episode"
        private const val EXTRA_ART = "art"
        private const val EXTRA_BINGE = "binge"
        const val EXTRA_RESCUE_TRIED = "rescueTried"
        const val EXTRA_RESCUE_FIRST = "rescueFirst"
        private const val EXTRA_AUDIO_PICK = "audioPick"
        private const val EXTRA_QUALITY = "quality"
        private const val EXTRA_WANT_MISSING = "wantMissing"
        private const val EXTRA_LINE_SAID = "lineSaid"
        private const val EXTRA_TRACK = "track"
        private const val EXTRA_SUBS = "subtitles"
        const val EXTRA_RESCUES = "rescues"
        private const val UP_NEXT_AT_MS = 25_000L
        /** An "end" this far or more before the file's end is a dropped connection, not the end. */
        private const val DROPPED_BEFORE_END_MS = 3 * 60_000L
        private const val MAX_RECONNECTS = 3
        private val YOUTUBE_ID = Regex("[A-Za-z0-9_-]{11}")
        /** How long before the end the next episode's sources are looked up. */
        private const val PREFETCH_BEFORE_MS = 3 * 60_000L
        /** How long after a picked source starts it can still fail back to the one before. */
        private const val KEEP_BEFORE_MS = 15_000L
        /** How far the old source plays (silently) behind the card before pausing, so it's on screen. */
        private const val PANEL_DP = 300
        private const val EPISODES_PANEL_DP = 380
        private val CHIPS = listOf(R.id.chipAudio, R.id.chipSubtitles, R.id.chipQuality, R.id.chipPicture, R.id.chipEpisodes, R.id.chipNext)
        /** Leaving early is asked about only between these points (earlier counts as an accident). */
        private const val EARLY_EXIT_ASKS = true
        private const val EARLY_EXIT_AFTER_MS = 5 * 60_000L
        private const val EARLY_EXIT_BEFORE = 0.70
        private const val EXIT_CARD_MS = 6_000L
        private const val RATE_CARD_MS = 10_000L
        /** After a rating at the very end: the note saying it ("Love it") is seen before the player closes. */
        private const val ANSWER_SEEN_MS = 1_200L
        /** Leaving from this far through (the credits, most likely), the rating is asked first. */
        private const val RATE_ON_LEAVING_FROM = 0.90
        /** A show is rated only once a few episodes are behind you. */
        private const val RATE_AFTER_EPISODES = 3
        private const val UP_NEXT_COUNTDOWN = 10
        private const val PREF_AUDIO = PlayerPrefs.AUDIO
        private const val PREF_SUBS = PlayerPrefs.SUBTITLES
        /** Two-letter stream language codes (as the server sends them) and their names, for source labels. */
        private val SPOKEN = TrackLanguage.NAMES
        private const val OFF = PlayerPrefs.OFF
        private const val SEEK_MS = 10_000L
        private const val SCRUB_SETTLE_MS = 550L
        private const val HIDE_AFTER_MS = 4_000L
        private const val SAVE_EVERY_MS = 30_000L
        private const val START_GRACE_MS = 5_000L
        private const val START_TIMEOUT_MS = 30_000L
        /** A version the viewer picked has this long to start before going back to the one before. */
        private const val PICK_START_TIMEOUT_MS = 15_000L
        /** What the player says it is to file servers: libVLC's own name (its bundled VLC 3.0.21), stated so the
         *  TV's own check of an address can say the same. */
        private const val PLAYER_AGENT = "VLC/3.0.21 LibVLC/3.0.21"
        /** Links this close to expiring are asked for again rather than tried. */
        private const val LINKS_MARGIN_MS = 60_000L
        /** The time a play has to get its first picture, from the screen opening; after a mid-film failure, from it. */
        private const val BUDGET_START_MS = 180_000L
        private const val BUDGET_AFTER_MS = 120_000L
        /** A file being prepared is tried again no sooner than this after the play answer, and after its own answer
         *  (the stream finder keeps "not ready" 60 s from its own look). */
        private const val PREPARING_AFTER_ANSWER_MS = 60_000L
        private const val PREPARING_AGAIN_MS = 61_000L
        /** A busy service's wait this short is waited out on the same file (once). */
        private const val BUSY_WAIT_HERE_MS = 15_000L
        /** A little past a waited-for time, so the file is due when it's looked at. */
        private const val WAIT_MARGIN_MS = 250L
        /** Followed links opened in one play at most, retries included: each is a call to a service. */
        private const val MAX_FOLLOWED_OPENS = 15
        /** This few left that could play: more sources are asked for meanwhile. */
        private const val FEW_LEFT = 3
        /** A file under this share of the title's running time isn't the title. */
        private const val SHORTEST_PART = 0.4
        private const val MIN_UNKNOWN_LENGTH_MS = 90_000L
        private val VIDEO_ID = Regex("""^tt\d+(:\d+:\d+)?$""")
        private const val SUB_STEP_US = 100_000L
        /** How long a note that something went wrong stays up: long enough to read. */
        private const val ERROR_NOTE_MS = 5_000L
        private val ONCE_KEYS = setOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE)
        private val HH_MM = DateTimeFormatter.ofPattern("HH:mm")
        private val LANG_NAMES = PlayerPrefs.NAMES
        // The viewer is told plainly, never why (a file's name, length or error).
        private const val NOTHING_YET = "No sources found for this one yet. Try again later."
        /** Only files not downloaded yet: one has been started. */
        private const val BEING_PREPARED = "This one is being prepared. Try again in a few minutes."
        private const val COULDNT_PLAY = "Couldn't play this right now. Try again in a moment."
        // The loading screen's lines, and over the picture mid-film.
        private const val GETTING_READY = "Getting it ready…"
        private const val STILL_GETTING_READY = "Still getting it ready…"
        private const val ALMOST_THERE = "Almost there…"
        private const val ALMOST_AFTER_MS = 60_000L
        private const val TOO_MANY_REQUESTS = "Too many requests right now. Try again in a few minutes."
        private const val ACCOUNT_PROBLEM = "There's a problem with your streaming account."
        private const val RECONNECTING = "Reconnecting…"
        private const val SWITCHING = "Switching…"
        /** Quality's last line: another copy of this one. */
        private const val TRY_ANOTHER = "Try another version"
        private const val MAY_NOT_BE_RIGHT = "May not be right"
        private const val OTHER_EPISODES = "Only other episodes were found. Play one anyway?"
        private const val COULDNT_PLAY_NOW = "Couldn't play this right now."
        private const val SWITCHING_BACK = "Switching back…"
        private const val NO_CONNECTION = "Lost the connection. Try again once it's back."
        private const val STILL_AFTER_MS = 8_000L
        /** "Hindi isn't available right now. Still in English.": up this long. */
        private const val BACK_NOTE_MS = 5_000L
        private const val CLEAN_PLAY_MS = 10 * 60_000L
        /** Open, and time has moved on this far: started, even if libVLC never said a picture is up. */
        private const val STARTED_AFTER_MS = 1_500L
        /** How long the player waits for no connection, or for the server waking up, before giving up. */
        private const val OFFLINE_WAIT_MS = 120_000L
        /** Files that failed this long before the connection was found down are tried again. */
        private const val OFFLINE_LOOKBACK_MS = 30_000L
        private const val STARTING_WAIT_MS = 90_000L
        /** Mid-film: a spinner after this long filling the buffer; a connection bringing nothing in for
         *  this long is opened again. */
        private const val SPINNER_AFTER_MS = 700L
        private const val WATCH_EVERY_MS = 2_000L
        private const val NOTHING_ARRIVING_MS = 10_000L
        /** "Switching to Hindi…": until playback is this far past the switch, or at most this long. */
        private const val SWITCH_HEARD_MS = 400L
        private const val SWITCH_MOST_MS = 5_000L
        /** The Quality panel's qualities, best first (as the server names them), and what they're called. */
        private val QUALITIES = listOf("4K", "1080p", "720p", "480p")
        private val QUALITY_NAMES = mapOf("4K" to "4K", "1080p" to "1080p", "720p" to "720p", "480p" to "SD")
        /** A playback link's token ({server}/s/{token}/{n}). */
        private val TOKEN = Regex("""/s/([A-Za-z0-9_-]{16,64})/\d+""")
        /** Two-letter audio codes and their three-letter ones (libVLC is told both). */
        private val THREE = mapOf(
            "en" to "eng", "hi" to "hin", "ta" to "tam", "te" to "tel", "es" to "spa", "fr" to "fre", "de" to "ger",
            "it" to "ita", "ja" to "jpn", "ko" to "kor", "ru" to "rus", "pt" to "por", "zh" to "chi", "ar" to "ara",
            "pa" to "pan", "ur" to "urd",
        )
        /** How many versions are looked in for a language picked in the Audio panel (the server's most). */
        private const val VERSIONS_CHECKED = 4

        /** The server's play info for one film or episode; [binge] keeps a season on the same release. */
        /** [audio]: the pick (a code, "" cleared, null: the title's saved one, "*"). */
        private fun playPath(type: String, id: String, binge: String?, audio: String?) =
            "/launcher/play/$type/$id.json?audio=" + Uri.encode(audio ?: "*") + (binge?.let { "&binge=" + Uri.encode(it) }.orEmpty())

        /** Runs on a background thread; the wait for sources can take most of a minute. */
        /** The play request's own client: the server may take a cold start plus most of a minute. */
        /** For asking where a link leads: its redirect is read, not followed; 25 s covers the server's own
         *  15 s follow (its 10 s wait for a waking stream finder inside it). */
        private val whereClient by lazy {
            Feed.http.newBuilder().followRedirects(false).followSslRedirects(false)
                .readTimeout(25, java.util.concurrent.TimeUnit.SECONDS).build()
        }
        /** For the TV's own look at an address: no Nightcap headers (it's another site), 8 s a call. */
        private val checkClient by lazy {
            okhttp3.OkHttpClient.Builder().callTimeout(8, java.util.concurrent.TimeUnit.SECONDS).build()
        }
        private val playClient by lazy { Feed.http.newBuilder().readTimeout(90, java.util.concurrent.TimeUnit.SECONDS).build() }
        private const val NEXT_MORE_WAIT_S = 90L

        private fun playCall(path: String) = playClient.newCall(Request.Builder().url(Server.url + path).build())

        private fun fetchPlay(path: String): JSONObject {
            val request = Request.Builder().url(Server.url + path).build()
            return playClient.newCall(request).execute().use { r -> JSONObject(r.body!!.string()) }
        }

        fun clock(ms: Long): String {
            val s = (ms / 1000).coerceAtLeast(0)
            return if (s >= 3600) String.format("%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
            else String.format("%d:%02d", s / 60, s % 60)
        }

        /** [id] is the Stremio video id: "tt…" for a film, "tt…:season:episode" for an episode. */
        fun intent(
            context: Context, type: String, id: String, name: String, episode: String?, art: String?,
            binge: String? = null, source: PlaySource = PlaySource.DIRECT,
        ): Intent = source.into(
            Intent(context, WatchActivity::class.java)
                .putExtra(EXTRA_TYPE, type).putExtra(EXTRA_ID, id).putExtra(EXTRA_NAME, name)
                .putExtra(EXTRA_EPISODE, episode).putExtra(EXTRA_ART, art).putExtra(EXTRA_BINGE, binge),
        )
    }
}
