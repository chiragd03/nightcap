package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.animation.PathInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import coil.imageLoader
import coil.load
import coil.request.ImageRequest
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The current profile's settings. Four glass cards show their values as pictures (the audio
 * language in its own script, a caption box, language chips, the Top 10 number); a card opens a
 * glass panel from the right with a live preview of each choice. The profile card opens the
 * editor: the avatars in a sliding line, and the name. Changes save as they're made.
 */
class SettingsActivity : TvActivity() {

    private val io = Executors.newSingleThreadExecutor()
    /** Preview posters load on their own threads, so they never hold up a save. */
    private val previewIo = Executors.newFixedThreadPool(2)
    private val handler = Handler(Looper.getMainLooper())
    private val prefs by lazy { PlayerPrefs.of(this) }
    private val dp by lazy { resources.displayMetrics.density }

    private lateinit var aura: AuraView
    private lateinit var main: View
    private lateinit var scrim: View
    private lateinit var panel: LinearLayout
    private lateinit var preview: FrameLayout
    private lateinit var panelItems: LinearLayout
    private lateinit var editor: View
    private lateinit var carousel: AvatarCarousel

    private var profile: Profile? = null
    private var settings = JSONObject()
    /** Whether this profile's settings have come from the server (or couldn't). Until they have, its
     *  cards don't open: a change made to the defaults would overwrite what's saved. */
    private var loaded = false
    private var loadFailed = false
    private var rowLanguages: List<String> = PlayerPrefs.ROW_NATIVE.keys.toList()
    private var countries: List<Pair<String, String>> = emptyList()
    private var still: String? = null
    private var weatherCity: String? = null
    /** This month's AI spend (the admin only). */
    private var usage: JSONObject? = null
    /** Whether this household has the AI (a key): optional, and without it nothing about it shows. */
    private var aiOn = true
    private val posters = ConcurrentHashMap<String, List<String>>()

    /** Which card's panel is open (null: none); the card regains focus when it closes. */
    private var openCard: View? = null
    private var editing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        findViewById<TextView>(R.id.appVersion).text = "Nightcap ${BuildConfig.VERSION_NAME}"
        aura = findViewById(R.id.aura)
        main = findViewById(R.id.main)
        scrim = findViewById(R.id.scrim)
        panel = findViewById(R.id.panel)
        preview = findViewById(R.id.preview)
        panelItems = findViewById(R.id.panelItems)
        editor = findViewById(R.id.editor)
        KeyboardLift.attach(this, editor, findViewById(R.id.nameField))
        carousel = findViewById(R.id.carousel)

        profile = Profiles.current()
        listOf(R.id.profileCard, R.id.audioCard, R.id.subsCard, R.id.qualityCard, R.id.langCard, R.id.top10Card,
            R.id.homeCard, R.id.usageCard).forEach { id ->
            findViewById<View>(id).apply {
                setOnFocusChangeListener { v, has -> lift(v, has) }
                setOnClickListener { open(id) }
            }
        }
        findViewById<View>(R.id.tvSettings).setOnClickListener { startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) }
        findViewById<View>(R.id.homeSwitchCard).apply {
            setOnFocusChangeListener { v, has -> lift(v, has) }
            setOnClickListener {
                HomeScreen.set(this@SettingsActivity, !HomeScreen.isOn(this@SettingsActivity))
                showHomeSwitch(animate = true)
            }
        }
        showHomeSwitch(animate = false)
        // (Not offered yet: opening on its own when the TV starts or wakes needs permissions a TV
        // doesn't give an app without ADB.)
        findViewById<View>(R.id.homeSwitchCard).visibility = View.GONE
        findViewById<TextView>(R.id.serverLink).apply {
            text = "Nightcap server · ${Server.url.removePrefix("http://").removePrefix("https://")}"
            setOnClickListener { startActivity(ConnectActivity.intent(this@SettingsActivity)) }
        }
        showCards()
        findViewById<View>(R.id.profileCard).requestFocus()
    }

    // The profile's settings loaded again each time this comes to the front (changed on the web
    // meanwhile, say), not only when it opened.
    override fun onResume() {
        super.onResume()
        if (Server.ready) load()
    }

    override fun onDestroy() {
        // Saves still queued finish after the screen closes; only previews are dropped.
        io.shutdown()
        previewIo.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun load() = io.execute {
        val json = runCatching { get("/launcher/profile.json") }.onFailure { Log.w(TAG, "Settings unavailable", it) }.getOrNull()
            ?: return@execute runOnUiThread { loadFailed = true }
        runOnUiThread {
            loaded = true
            loadFailed = false
            profile = Profile(json.getString("id"), json.getString("name"), json.optString("avatar").ifEmpty { null },
                json.optBoolean("isAdmin"))
            settings = json.getJSONObject("settings")
            still = json.optString("still").ifEmpty { null }
            weatherCity = json.optString("weatherCity").ifEmpty { null }
            usage = json.optJSONObject("usage")
            aiOn = json.optBoolean("aiAvailable", true)
            val o = json.getJSONObject("options")
            rowLanguages = (0 until o.getJSONArray("languages").length()).map { o.getJSONArray("languages").getJSONObject(it).getString("code") }
            countries = o.getJSONArray("countries").let { a -> (0 until a.length()).map { a.getJSONObject(it).let { c -> c.getString("code") to c.getString("name") } } }
            showCards()
        }
    }

    private fun get(path: String): JSONObject {
        val request = Request.Builder().url(Server.url + path).build()
        return Feed.http.newCall(request).execute().use { r ->
            check(r.isSuccessful) { "Server answered ${r.code}" }
            JSONObject(r.body!!.string())
        }
    }

    /** Posters for a preview (lang:hi, top10:IN), fetched once. Runs on a background thread. */
    private fun posters(key: String): List<String> = posters[key] ?: runCatching {
        get("/launcher/preview/$key.json").getJSONArray("posters").let { a -> (0 until a.length()).map(a::getString) }
    }.getOrDefault(emptyList()).also { if (it.isNotEmpty()) posters[key] = it }

    // ---------- The cards ----------

    private fun showCards() {
        val p = profile
        if (p != null) {
            findViewById<ImageView>(R.id.profileAvatar).setImageResource(p.picture.image)
            tint(findViewById(R.id.profileDisc), p.picture.tint)
            findViewById<TextView>(R.id.profileName).text = p.name
            findViewById<TextView>(R.id.profileRole).text = if (p.isAdmin) "Admin profile" else "Profile"
            aura.glowTo(p.picture.tint)
        }
        val audio = prefs.getString(PlayerPrefs.AUDIO, PlayerPrefs.DEFAULT_AUDIO)!!
        val audioCode = PlayerPrefs.codeOf(audio)
        findViewById<TextView>(R.id.audioNative).text = audioCode?.let(PlayerPrefs.NATIVE::get) ?: audio
        // The audio language also picks the version: dubbed ones in this language come first.
        findViewById<TextView>(R.id.audioEnglish).text = "$audio versions first"
        val quality = Quality.of(settings.optString("quality"))
        findViewById<TextView>(R.id.qualityValue).text = quality.title
        findViewById<TextView>(R.id.qualityBadge).text = quality.badge
        findViewById<TextView>(R.id.qualitySub).text = quality.short

        val subs = prefs.getString(PlayerPrefs.SUBTITLES, PlayerPrefs.DEFAULT_SUBTITLES)!!
        val off = subs == PlayerPrefs.OFF
        findViewById<TextView>(R.id.subsSample).apply {
            text = if (off) "Off" else PlayerPrefs.GLYPHS[subs] ?: "Aa"
            alpha = if (off) 0.45f else 1f
        }
        findViewById<TextView>(R.id.subsValue).text = if (off) "No subtitles" else PlayerPrefs.NAMES[subs] ?: subs

        val chosen = list("languages")
        val chips = findViewById<LinearLayout>(R.id.langChips)
        chips.removeAllViews()
        chosen.take(8).chunked(4).forEach { pair ->
            chips.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                pair.forEach { code -> addView(chip(PlayerPrefs.ROW_NATIVE[code] ?: code)) }
            })
        }
        findViewById<TextView>(R.id.langValue).text = when {
            chosen.isEmpty() -> "None: Home sticks to English"
            chosen.size > 8 -> "${chosen.size} rows · +${chosen.size - 8} more"
            else -> if (chosen.size == 1) "1 row" else "${chosen.size} rows"
        }
        findViewById<TextView>(R.id.top10Value).text = list("top10_countries").firstOrNull()?.let(::countryName).orEmpty()

        findViewById<TextView>(R.id.homeWeather).text = onOff("Weather", settings.optBoolean("show_weather", true))
        findViewById<TextView>(R.id.homeAi).apply {
            text = onOff("AI cost", settings.optBoolean("show_ai", p?.isAdmin == true))
            visibility = if (aiOn) View.VISIBLE else View.GONE
        }
        val u = usage
        findViewById<View>(R.id.usageCard).visibility = if (u != null) View.VISIBLE else View.GONE
        placeInLastRow(R.id.usageCard, 1)
        if (u != null) {
            findViewById<TextView>(R.id.usageValue).text = monthCost(u)
            val calls = u.optInt("month_calls")
            findViewById<TextView>(R.id.usageSub).text = "$calls ${if (calls == 1) "request" else "requests"} · ${cost(u.optDouble("today_cost"), u.optInt("today_unpriced_calls"))} today"
        }
    }

    /** "● Weather" when it shows on Home, "○ Weather" (dimmed) when it doesn't. */
    private fun onOff(name: String, on: Boolean) = android.text.SpannableString("${if (on) "●" else "○"}  $name").apply {
        setSpan(android.text.style.ForegroundColorSpan(getColor(if (on) R.color.lamp else R.color.muted)), 0, 1, 0)
        if (!on) setSpan(android.text.style.ForegroundColorSpan(getColor(R.color.muted)), 1, length, 0)
    }

    private fun money(usd: Double) = if (usd >= 0.01 || usd == 0.0) "$%.2f".format(usd) else "under 1¢"

    /** This month's AI cost (see cost). */
    private fun monthCost(u: JSONObject) = cost(u.optDouble("month_cost"), u.optInt("month_unpriced_calls"))

    /** [usd], or "$0.42+" / "Cost unknown" when [unpriced] calls were to a model without a price. */
    private fun cost(usd: Double, unpriced: Int) = when {
        unpriced == 0 -> money(usd)
        usd == 0.0 -> "Cost unknown"
        else -> "${money(usd)}+"
    }

    private fun chip(text: String) = TextView(this).apply {
        this.text = text
        setBackgroundResource(R.drawable.settings_chip)
        setTextColor(getColor(R.color.text))
        textSize = 10f
        fontVariationSettings = "'wght' 600"
        setPadding((10 * dp).toInt(), (3 * dp).toInt(), (10 * dp).toInt(), (3 * dp).toInt())
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { setMargins(0, (3 * dp).toInt(), (5 * dp).toInt(), (3 * dp).toInt()) }
    }

    private fun list(key: String) = settings.optJSONArray(key)?.let { a -> (0 until a.length()).map(a::getString) }.orEmpty()

    private fun countryName(code: String) = (countries.firstOrNull { it.first == code }?.second ?: code)
        .removePrefix("the ").replaceFirstChar(Char::uppercase)

    private fun tint(disc: View, color: Int) =
        ((disc.background.mutate() as LayerDrawable).getDrawable(0) as GradientDrawable).setColor(color)

    /** The focused card rises a little towards you. */
    private fun placeInLastRow(card: Int, column: Int) = findViewById<View>(card).let { v ->
        v.layoutParams = (v.layoutParams as GridLayout.LayoutParams).apply {
            rowSpec = GridLayout.spec(LAST_ROW)
            columnSpec = GridLayout.spec(column)
        }
    }

    private fun lift(v: View, has: Boolean) {
        val s = if (has) 1.05f else 1f
        v.animate().scaleX(s).scaleY(s).translationZ(if (has) 14 * dp else 0f).setDuration(240).setInterpolator(EASE).start()
    }

    private fun open(id: Int) {
        // (The settings kept on the server: only once they're here. Audio and subtitles are the TV's own.)
        if (!loaded && id != R.id.audioCard && id != R.id.subsCard) {
            Notice.show(this, if (loadFailed) "Couldn't load your settings. Check the connection." else "Still loading your settings…")
            if (loadFailed) { loadFailed = false; load() }
            return
        }
        when (id) {
            R.id.profileCard -> openEditor()
            R.id.audioCard -> openAudio()
            R.id.subsCard -> openSubtitles()
            R.id.qualityCard -> openQuality()
            R.id.langCard -> openLanguages()
            R.id.top10Card -> openTop10()
            R.id.homeCard -> openHome()
            R.id.usageCard -> openUsage()
        }
    }

    // ---------- The panel ----------

    /** Slides the panel in over the dimmed cards; [build] fills it. */
    /** The home-screen switch, as it is now: on, Nightcap is the TV's default home screen; off, just an app. */
    private fun showHomeSwitch(animate: Boolean) {
        val on = HomeScreen.isOn(this)
        findViewById<View>(R.id.homeSwitchTrack).backgroundTintList =
            android.content.res.ColorStateList.valueOf(if (on) getColor(R.color.lamp) else 0x55A0A8B8)
        findViewById<View>(R.id.homeSwitchKnob).apply {
            val x = if (on) 10 * dp else 0f
            if (animate) animate().translationX(x).setDuration(180).setInterpolator(EASE).start() else translationX = x
        }
        findViewById<TextView>(R.id.homeSwitchValue).text = if (on) "Nightcap" else "Just an app"
        findViewById<TextView>(R.id.homeSwitchSub).text = if (on) "Opens when the TV turns on" else "The TV keeps its own home"
    }

    private fun showPanel(title: String, hint: String, build: () -> Unit) {
        openCard = currentFocus
        findViewById<TextView>(R.id.panelTitle).text = title
        findViewById<TextView>(R.id.panelHint).text = hint
        preview.removeAllViews()
        panelItems.removeAllViews()
        findViewById<ScrollView>(R.id.panelScroll).scrollTo(0, 0)
        build()
        // (Focus stays in the panel: the cards behind it can't take it while it's open.)
        (main as android.view.ViewGroup).descendantFocusability = android.view.ViewGroup.FOCUS_BLOCK_DESCENDANTS
        scrim.visibility = View.VISIBLE
        scrim.animate().alpha(1f).setDuration(260).start()
        main.animate().scaleX(0.96f).scaleY(0.96f).alpha(0.55f).setDuration(320).setInterpolator(EASE).start()
        panel.visibility = View.VISIBLE
        panel.translationX = 60 * dp
        panel.alpha = 0f
        panel.animate().translationX(0f).alpha(1f).setDuration(360).setInterpolator(EASE).start()
    }

    private fun closePanel() {
        val card = openCard ?: return
        openCard = null
        (main as android.view.ViewGroup).descendantFocusability = android.view.ViewGroup.FOCUS_AFTER_DESCENDANTS
        showCards()
        scrim.animate().alpha(0f).setDuration(200).withEndAction { scrim.visibility = View.GONE }.start()
        main.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(300).setInterpolator(EASE).start()
        panel.animate().translationX(60 * dp).alpha(0f).setDuration(220).setInterpolator(EASE)
            .withEndAction { panel.visibility = View.GONE }.start()
        card.requestFocus()
    }

    /** A choice row; [onFocus] drives the preview, [onClick] chooses. */
    private fun choice(name: String, sub: String?, ticked: Boolean, onFocus: () -> Unit = {}, onClick: (View) -> Unit): View {
        val v = LayoutInflater.from(this).inflate(R.layout.item_choice, panelItems, false)
        v.findViewById<TextView>(R.id.choiceName).text = name
        v.findViewById<TextView>(R.id.choiceSub).apply { text = sub; visibility = if (sub.isNullOrEmpty()) View.GONE else View.VISIBLE }
        v.findViewById<View>(R.id.choiceTick).visibility = if (ticked) View.VISIBLE else View.INVISIBLE
        v.setOnFocusChangeListener { _, has ->
            if (!has) return@setOnFocusChangeListener
            onFocus()
            // Keep the chosen row in the middle of the list, clear of the faded edges.
            val scroll = findViewById<ScrollView>(R.id.panelScroll)
            scroll.post { scroll.smoothScrollTo(0, (v.top - (scroll.height - v.height) / 2).coerceAtLeast(0)) }
        }
        v.setOnClickListener(onClick)
        panelItems.addView(v)
        return v
    }

    private fun tick(row: View, on: Boolean) {
        row.findViewById<View>(R.id.choiceTick).visibility = if (on) View.VISIBLE else View.INVISIBLE
    }

    private fun openAudio() = showPanel("Audio", "Versions in this language come first, dubbed ones too, and inside a film this track plays.") {
        val current = prefs.getString(PlayerPrefs.AUDIO, PlayerPrefs.DEFAULT_AUDIO)!!
        var start: View? = null
        PlayerPrefs.NAMES.entries.distinctBy { it.value }.forEach { (code, english) ->
            val native = PlayerPrefs.NATIVE[code] ?: english
            val row = choice(native, if (native == english) null else english, english == current) {
                prefs.edit().putString(PlayerPrefs.AUDIO, english).apply()
                save(JSONObject().put("settings", JSONObject().put("audio_language", english)))
                closePanel()
            }
            if (english == current) start = row
        }
        (start ?: panelItems.getChildAt(0)).requestFocus()
    }

    /** The still from what you're watching, softened to suggest each quality, with its badge and
     *  roughly how much it streams; OK keeps it. */
    private fun openQuality() = showPanel("Quality", "Versions in this quality come first. If there isn't one, the next one up, then down.") {
        val frame = stillFrame()
        val image = frame.getChildAt(0) as ImageView
        val badge = TextView(this).apply {
            setBackgroundResource(R.drawable.caption_box)
            setTextColor(getColor(R.color.text))
            textSize = 10f
            fontVariationSettings = "'wght' 800"
            letterSpacing = 0.06f
            setPadding((8 * dp).toInt(), (2 * dp).toInt(), (8 * dp).toInt(), (2 * dp).toInt())
        }
        frame.addView(badge, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply {
            setMargins(0, (12 * dp).toInt(), (12 * dp).toInt(), 0)
        })
        val stats = TextView(this).apply {
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 11f
            fontVariationSettings = "'wght' 600"
            setShadowLayer(6 * dp, 0f, 1.5f * dp, 0xE6000000.toInt())
            setPadding((16 * dp).toInt(), 0, (16 * dp).toInt(), (12 * dp).toInt())
        }
        frame.addView(stats, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        val current = Quality.of(settings.optString("quality"))
        var start: View? = null
        Quality.entries.forEach { q ->
            val row = choice(q.title, q.detail, q == current, onFocus = {
                badge.text = q.badge
                stats.text = q.data
                Blur.set(image, if (q.blurDp > 0f) q.blurDp * dp else null)
            }) {
                settings.put("quality", q.key)
                save(JSONObject().put("settings", JSONObject().put("quality", q.key)))
                closePanel()
            }
            if (q == current) start = row
        }
        (start ?: panelItems.getChildAt(0)).requestFocus()
    }

    /** A rounded frame holding the still from what you're watching (with a dark foot for text). */
    private fun stillFrame(): FrameLayout {
        val frame = FrameLayout(this).apply {
            setBackgroundResource(R.drawable.preview_frame)
            clipToOutline = true
            outlineProvider = rounded(14f)
        }
        val image = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        still?.let { image.load(it) { crossfade(250) } }
        frame.addView(image, FrameLayout.LayoutParams(-1, -1))
        frame.addView(View(this).apply { setBackgroundResource(R.drawable.subtitle_scrim) },
            FrameLayout.LayoutParams(-1, (90 * dp).toInt(), Gravity.BOTTOM))
        preview.addView(frame, FrameLayout.LayoutParams(-1, (200 * dp).toInt()))
        return frame
    }

    /** A still from what you're watching, with the focused language's subtitle on it. */
    private fun openSubtitles() = showPanel("Subtitles", "Shown when there are subtitles in this language.") {
        val frame = stillFrame()
        val line = TextView(this).apply {
            setTextColor(0xFFFFFFFF.toInt())
            textSize = 12.5f
            fontVariationSettings = "'wght' 600"
            gravity = Gravity.CENTER
            setShadowLayer(6 * dp, 0f, 1.5f * dp, 0xE6000000.toInt())
            setPadding((18 * dp).toInt(), 0, (18 * dp).toInt(), (14 * dp).toInt())
        }
        frame.addView(line, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))

        fun showLine(code: String) {
            val text = if (code == PlayerPrefs.OFF) "" else PlayerPrefs.SAMPLE[code].orEmpty()
            line.animate().cancel()
            line.animate().alpha(0f).setDuration(90).withEndAction {
                line.text = text
                line.animate().alpha(1f).setDuration(160).start()
            }.start()
        }

        val current = prefs.getString(PlayerPrefs.SUBTITLES, PlayerPrefs.DEFAULT_SUBTITLES)!!
        var start: View? = null
        val options = listOf(PlayerPrefs.OFF to "Off") + PlayerPrefs.NAMES.entries.distinctBy { it.value }.map { it.key to it.value }
        options.forEach { (code, english) ->
            val native = if (code == PlayerPrefs.OFF) "Off" else PlayerPrefs.NATIVE[code] ?: english
            val sub = if (code == PlayerPrefs.OFF) "No subtitles" else english.takeIf { it != native }
            val row = choice(native, sub, code == current, onFocus = { showLine(code) }) {
                prefs.edit().putString(PlayerPrefs.SUBTITLES, code).apply()
                save(JSONObject().put("settings", JSONObject().put("subtitles", code)))
                closePanel()
            }
            if (code == current) start = row
        }
        (start ?: panelItems.getChildAt(0)).requestFocus()
    }

    /** Posters along the top: the focused language's own titles; OK ticks it on or off. */
    private fun openLanguages() = showPanel("Language rows", "Each one gets its own Latest shows and movies rows on Home. Tick as many as you like.") {
        val strip = posterStrip(6, 54f)
        val keys = rowLanguages.map { "lang:$it" }
        val chosen = list("languages").toMutableList()
        rowLanguages.forEach { code ->
            val native = PlayerPrefs.ROW_NATIVE[code] ?: code
            val english = englishRowName(code)
            choice(native, english.takeIf { it != native }, code in chosen, onFocus = { fillStrip(strip, "lang:$code", keys) }) { row ->
                if (code in chosen) chosen.remove(code) else chosen.add(code)
                tick(row, code in chosen)
                settings.put("languages", JSONArray(chosen))
                save(JSONObject().put("settings", JSONObject().put("languages", JSONArray(chosen))))
            }
        }
        panelItems.getChildAt(0)?.requestFocus()
    }

    /** The focused country's top six, in order, numbered; OK puts it on Home. */
    private fun openTop10() = showPanel("Top 10", "Which country's Top 10 shows and movies are on Home.") {
        val strip = posterStrip(6, 54f, ranked = true)
        val keys = countries.map { "top10:${it.first}" }
        val current = list("top10_countries").firstOrNull()
        var start: View? = null
        countries.forEach { (code, _) ->
            val row = choice(countryName(code), null, code == current, onFocus = { fillStrip(strip, "top10:$code", keys) }) {
                val list = JSONArray(listOf(code) + list("top10_countries").filter { it != code })
                settings.put("top10_countries", list)
                save(JSONObject().put("settings", JSONObject().put("top10_countries", list)))
                closePanel()
            }
            if (code == current) start = row
        }
        (start ?: panelItems.getChildAt(0))?.requestFocus()
    }

    /** What shows on Home: OK turns one on or off; the panel stays open. */
    private fun openHome() = showPanel("Home screen", "What shows on Home for this profile.") {
        val p = profile
        fun toggle(key: String, name: String, sub: String?, default: Boolean) {
            choice(name, sub, settings.optBoolean(key, default)) { row ->
                val on = !settings.optBoolean(key, default)
                settings.put(key, on)
                tick(row, on)
                save(JSONObject().put("settings", JSONObject().put(key, on)))
            }
        }
        // p is null when the profile didn't load: then whether a place is set isn't known.
        val noPlace = p != null && weatherCity == null
        toggle("show_weather", "Weather",
            if (noPlace) "No place set. An admin can set it in the web app."
            else listOfNotNull("Top right", weatherCity).joinToString(" · "), true)
        if (aiOn) toggle("show_ai", "AI cost", "This month's spend, bottom right", p?.isAdmin == true)
        panelItems.getChildAt(0)?.requestFocus()
    }

    /** The admin's view of what the AI has cost this month, and each profile's share. */
    private fun openUsage() = showPanel("AI this month", "Picks, reasons and search. Each profile's share of the month.") {
        val u = usage ?: return@showPanel
        choice("All profiles", "${monthCost(u)} · ${u.optInt("month_calls")} requests · ${cost(u.optDouble("today_cost"), u.optInt("today_unpriced_calls"))} today", false) {}
        val each = u.optJSONArray("by_profile")
        for (i in 0 until (each?.length() ?: 0)) {
            val e = each!!.getJSONObject(i)
            choice(e.optString("name"), "${cost(e.optDouble("cost"), e.optInt("unpriced"))} · ${e.optInt("calls")} requests", false) {}
        }
        panelItems.getChildAt(0)?.requestFocus()
    }

    private fun englishRowName(code: String) = when (code) {
        "hi" -> "Hindi"; "ko" -> "Korean"; "anime" -> "Japanese animation, and anime from elsewhere"; "ja" -> "Japanese"; "ta" -> "Tamil"; "te" -> "Telugu"
        "ml" -> "Malayalam"; "es" -> "Spanish"; "fr" -> "French"; "tr" -> "Turkish"; "zh" -> "Chinese"
        else -> code
    }

    /** A row of [count] poster slots (with big rank numbers when [ranked]). */
    private fun posterStrip(count: Int, widthDp: Float, ranked: Boolean = false): List<ImageView> {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false }
        val images = (0 until count).map { i ->
            val cell = FrameLayout(this).apply { clipChildren = false }
            if (ranked) cell.addView(TextView(this).apply {
                text = "${i + 1}"
                typeface = resources.getFont(R.font.big_shoulders)
                fontVariationSettings = "'wght' 800"
                includeFontPadding = false
                setTextColor(getColor(R.color.text))
                textSize = 13f
                gravity = Gravity.CENTER
            }, FrameLayout.LayoutParams((widthDp * dp).toInt(), -2, Gravity.BOTTOM))
            val image = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundResource(R.drawable.preview_frame)
                clipToOutline = true
                outlineProvider = rounded(8f)
            }
            cell.addView(image, FrameLayout.LayoutParams((widthDp * dp).toInt(), (widthDp * 1.5f * dp).toInt(), Gravity.TOP)
                .apply { if (ranked) bottomMargin = (20 * dp).toInt() })
            row.addView(cell, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = (6 * dp).toInt() })
            image
        }
        preview.addView(row)
        return images
    }

    private var stripKey: String? = null

    /** Shows [key]'s posters in the strip; moving quickly through the list only loads where you stop.
     *  The rows either side of it ([keys] is the panel's order) load quietly too, so the next move
     *  shows its posters at once. Nothing else is fetched. */
    private fun fillStrip(images: List<ImageView>, key: String, keys: List<String>) {
        stripKey = key
        val at = keys.indexOf(key)
        listOf(at + 1, at + 2, at - 1).mapNotNull(keys::getOrNull).forEach { near ->
            previewIo.execute {
                posters(near).forEach { url -> imageLoader.enqueue(ImageRequest.Builder(this).data(url).build()) }
            }
        }
        handler.removeCallbacksAndMessages(STRIP)
        handler.postAtTime({
            previewIo.execute {
                val urls = posters(key)
                runOnUiThread {
                    if (stripKey != key) return@runOnUiThread
                    images.forEachIndexed { i, v ->
                        val url = urls.getOrNull(i)
                        v.animate().alpha(0f).setDuration(90).withEndAction {
                            if (url == null) v.setImageDrawable(null) else v.load(url) { crossfade(200) }
                            v.animate().alpha(1f).setStartDelay(i * 35L).setDuration(220).start()
                        }.start()
                    }
                }
            }
        }, STRIP, android.os.SystemClock.uptimeMillis() + 140)
    }

    private fun rounded(radiusDp: Float) = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, view.width, view.height, radiusDp * dp)
    }

    // ---------- The profile editor ----------

    private fun openEditor() {
        val p = profile ?: return
        editing = true
        carousel.show(Avatars.all, Avatars.all.indexOfFirst { it.key == p.picture.key }.coerceAtLeast(0))
        carousel.onChanged = { a -> previewAvatar(a) }
        carousel.onPick = { a -> keepAvatar(a) }
        findViewById<TextView>(R.id.editorName).text = p.name
        findViewById<TextView>(R.id.editorAvatarName).text = p.picture.label
        val edit = findViewById<View>(R.id.editName)
        edit.visibility = View.VISIBLE
        edit.setOnClickListener { editName() }
        findViewById<View>(R.id.nameField).visibility = View.GONE
        main.animate().alpha(0f).scaleX(0.94f).scaleY(0.94f).setDuration(260).setInterpolator(EASE)
            .withEndAction { main.visibility = View.INVISIBLE }.start()
        editor.visibility = View.VISIBLE
        editor.alpha = 0f
        editor.scaleX = 1.04f
        editor.scaleY = 1.04f
        editor.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(360).setInterpolator(EASE).start()
        carousel.requestFocus()
    }

    private fun previewAvatar(a: Avatars.Avatar) {
        aura.glowTo(a.tint)
        findViewById<TextView>(R.id.editorAvatarName).text = a.label
    }

    private fun keepAvatar(a: Avatars.Avatar) {
        val p = profile ?: return
        if (a.key != p.picture.key || p.avatar == null) {
            profile = p.copy(avatar = a.key)
            save(JSONObject().put("avatar", a.key))
        }
        closeEditor()
    }

    private fun editName() {
        val field = findViewById<EditText>(R.id.nameField)
        findViewById<View>(R.id.editName).visibility = View.GONE
        field.visibility = View.VISIBLE
        field.setText(profile?.name)
        field.setSelection(field.text.length)
        field.setOnEditorActionListener { _, action, event ->
            val done = action == EditorInfo.IME_ACTION_DONE || (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            if (done) saveName(field.text.toString())
            done
        }
        field.requestFocus()
        field.post { getSystemService(InputMethodManager::class.java).showSoftInput(field, 0) }
    }

    private fun saveName(typed: String) {
        val name = typed.trim().replace(Regex("\\s+"), " ")
        if (name.isEmpty()) return Notice.show(this, "A name needs at least one letter")
        val p = profile ?: return
        if (name != p.name) {
            profile = p.copy(name = name)
            save(JSONObject().put("name", name))
        }
        hideKeyboard()
        findViewById<TextView>(R.id.editorName).text = name
        findViewById<View>(R.id.nameField).visibility = View.GONE
        findViewById<View>(R.id.editName).visibility = View.VISIBLE
        carousel.requestFocus()
    }

    private fun closeEditor() {
        editing = false
        hideKeyboard()
        editor.animate().alpha(0f).scaleX(1.04f).scaleY(1.04f).setDuration(240).setInterpolator(EASE)
            .withEndAction { editor.visibility = View.GONE }.start()
        main.visibility = View.VISIBLE
        main.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(340).setInterpolator(EASE).start()
        showCards()
        findViewById<View>(R.id.profileCard).requestFocus()
    }

    private fun hideKeyboard() {
        currentFocus?.let { getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0) }
    }

    // ---------- Saving and keys ----------

    /** Saves a change for this profile; the side menu and Home pick it up. */
    private fun save(body: JSONObject) {
        val id = profile?.id ?: return
        // Someone else's profile: the admin's, with the PIN.
        if (id != Profiles.currentId) return AdminPin.ensure(this) { send(id, body) }
        send(id, body)
    }

    private fun send(id: String, body: JSONObject) {
        io.execute {
            val ok = Feed.post("/launcher/profile", body.put("id", id))
            if (ok) runCatching { Profiles.fetch() }
            runOnUiThread { if (!ok) Notice.show(this, "Couldn't save that. Try again.") }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            val field = findViewById<View>(R.id.nameField)
            when {
                // Back from typing: keep the old name.
                editing && field.visibility == View.VISIBLE -> if (event.action == KeyEvent.ACTION_UP) {
                    hideKeyboard()
                    field.visibility = View.GONE
                    findViewById<View>(R.id.editName).visibility = View.VISIBLE
                    carousel.requestFocus()
                }
                // Back from the avatars: keep the old one.
                editing -> if (event.action == KeyEvent.ACTION_UP) closeEditor()
                openCard != null -> if (event.action == KeyEvent.ACTION_UP) closePanel()
                else -> return super.dispatchKeyEvent(event)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION") overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    /** The quality choices, as the server knows them ([key]) and as the cards show them. */
    enum class Quality(val key: String, val title: String, val badge: String, val short: String, val detail: String,
                       val data: String, val blurDp: Float) {
        BEST("best", "Best", "UHD", "Sharpest there is", "4K when there's a version in 4K, otherwise the next best",
            "Up to about 15 GB an hour", 0f),
        UHD("4K", "4K", "4K", "Ultra HD", "The sharpest picture; needs a fast connection", "About 7 to 15 GB an hour", 0f),
        FULL_HD("1080p", "1080p", "HD", "Full HD", "Very sharp, smaller files, quick to start", "About 2 to 4 GB an hour", 0.8f),
        HD("720p", "720p", "HD", "Saves data", "Fine on smaller screens; uses the least data", "About 1 GB an hour", 2f);

        companion object {
            fun of(key: String?) = entries.firstOrNull { it.key == key } ?: BEST
        }
    }

    companion object {
        private const val TAG = "Nightcap"
        private val STRIP = Any()
        private val EASE = PathInterpolator(0.2f, 0f, 0f, 1f)
        private const val LAST_ROW = 2

        fun intent(context: Context) = Intent(context, SettingsActivity::class.java)
    }
}
