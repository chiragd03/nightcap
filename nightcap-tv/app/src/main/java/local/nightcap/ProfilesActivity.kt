package local.nightcap

import android.animation.ArgbEvaluator
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Bundle
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Who's watching: shown when the TV wakes (with more than one profile), and from the side menu.
 * Picking a profile opens Home for it. Back keeps the profile that was in use: from the menu it
 * returns to where you were, on waking it opens Home. The admin also gets "Add profile" at the end
 * of the row and "Manage profiles" (remove) under it.
 */
class ProfilesActivity : TvActivity() {

    private val io = Executors.newSingleThreadExecutor()
    private lateinit var people: LinearLayout
    private lateinit var aura: AuraView
    private var shown: List<Profile> = emptyList()
    private var leaving = false
    /** Removing profiles: picking one asks to remove it. */
    private var managing = false
    private var busy = false
    private lateinit var manage: TextView
    private lateinit var adder: View
    private lateinit var carousel: AvatarCarousel
    private lateinit var nameField: EditText
    private val fromMenu by lazy { intent.getBooleanExtra(EXTRA_FROM_MENU, false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // (Opened when the TV wakes, which can be before this TV is set up.)
        if (!Server.ready) {
            startActivity(ConnectActivity.intent(this))
            return finish()
        }
        setContentView(R.layout.activity_profiles)
        people = findViewById(R.id.people)
        aura = findViewById(R.id.aura)
        manage = findViewById(R.id.manage)
        adder = findViewById(R.id.adder)
        carousel = findViewById(R.id.carousel)
        nameField = findViewById(R.id.adderName)
        KeyboardLift.attach(this, adder, nameField)
        manage.setOnClickListener { setManaging(!managing) }
        findViewById<View>(R.id.adderSave).setOnClickListener { addProfile() }
        nameField.setOnEditorActionListener { _, action, event ->
            val done = action == EditorInfo.IME_ACTION_DONE || (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
            if (done) {
                hideKeyboard()
                findViewById<View>(R.id.adderSave).requestFocus()
            }
            done
        }
        Profiles.asked()
        if (fromMenu) findViewById<View>(R.id.whoHint).visibility = View.GONE
        findViewById<View>(R.id.whoRetry).setOnClickListener { loadProfiles() }
        findViewById<View>(R.id.whoChangeServer).setOnClickListener { startActivity(ConnectActivity.intent(this)) }
        show(Profiles.list(), entrance = true)
    }

    // The household's profiles fetched again each time this comes to the front (one added or
    // removed on the web, say), not only when it opened.
    override fun onResume() {
        super.onResume()
        if (!Server.ready) return
        loadProfiles()
    }

    private fun loadProfiles() {
        if (shown.isEmpty()) showStatus("Loading profiles…", actions = false)
        io.execute {
            val fresh = runCatching { Profiles.fetch() }.getOrNull()
            runOnUiThread {
                if (leaving || isFinishing) return@runOnUiThread
                // Nothing to show and the server couldn't be reached: said, with a way on.
                if (fresh == null) {
                    if (shown.isEmpty()) showStatus("Couldn't reach ${Server.household?.takeIf { it.isNotBlank() } ?: "the server"}.", actions = true)
                    return@runOnUiThread
                }
                hideStatus()
                when {
                    // A new TV, and the household has just one profile: it's the one watching.
                    Profiles.currentId == null && fresh.size == 1 -> { Profiles.choose(fresh.single()); openHome() }
                    fresh == shown -> Unit
                    // Mid-way through adding one: drawn when the row comes back.
                    adder.visibility == View.VISIBLE -> shown = fresh
                    else -> show(fresh, entrance = shown.isEmpty())
                }
            }
        }
    }

    private fun showStatus(text: String, actions: Boolean) {
        findViewById<TextView>(R.id.whoStatus).apply { this.text = text; visibility = View.VISIBLE }
        findViewById<View>(R.id.whoActions).visibility = if (actions) View.VISIBLE else View.GONE
        if (actions) findViewById<View>(R.id.whoRetry).requestFocus()
    }

    private fun hideStatus() {
        findViewById<View>(R.id.whoStatus).visibility = View.GONE
        findViewById<View>(R.id.whoActions).visibility = View.GONE
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    /** Whether this is the admin: only the admin adds and removes profiles. */
    private fun isAdmin(profiles: List<Profile> = shown) =
        profiles.firstOrNull { it.id == Profiles.currentId }?.isAdmin == true

    private fun show(profiles: List<Profile>, entrance: Boolean, focusId: String? = null) {
        val focusedId = focusId ?: (currentFocus?.tag as? Profile)?.id ?: Profiles.current()?.id
        shown = profiles
        people.removeAllViews()
        val inflater = LayoutInflater.from(this)
        profiles.forEachIndexed { i, p ->
            val v = inflater.inflate(R.layout.item_profile, people, false)
            v.tag = p
            v.findViewById<ImageView>(R.id.avatar).setImageResource(p.picture.image)
            ((v.findViewById<View>(R.id.discFill).background.mutate() as LayerDrawable).getDrawable(0) as GradientDrawable)
                .setColor(p.picture.tint)
            v.findViewById<TextView>(R.id.name).text = p.name
            v.setOnFocusChangeListener { _, has -> focusChanged(v, has) }
            v.setOnClickListener { if (managing) askRemove(p, v) else pick(p, v) }
            if (managing) {
                // The admin profile stays: it can't be removed.
                v.findViewById<View>(R.id.manageScrim).visibility = if (p.isAdmin) View.GONE else View.VISIBLE
                v.findViewById<View>(R.id.manageIcon).visibility = if (p.isAdmin) View.GONE else View.VISIBLE
                if (p.isAdmin) { v.isFocusable = false; v.alpha = 0.35f }
            }
            if (entrance) enter(v, i)
            people.addView(v)
        }
        if (isAdmin(profiles) && !managing && profiles.size < MAX_PROFILES) {
            val v = inflater.inflate(R.layout.item_profile, people, false)
            v.findViewById<ImageView>(R.id.avatar).apply {
                setImageResource(R.drawable.ic_add)
                layoutParams = layoutParams.apply { width = width * 3 / 5; height = height * 3 / 5 }
            }
            ((v.findViewById<View>(R.id.discFill).background.mutate() as LayerDrawable).getDrawable(0) as GradientDrawable)
                .setColor(ADD_TINT)
            v.findViewById<TextView>(R.id.name).text = "Add profile"
            v.setOnFocusChangeListener { _, has -> focusChanged(v, has) }
            // (Adding a profile takes the admin PIN: asked before the screen opens.)
            v.setOnClickListener { AdminPin.ensure(this) { openAdder() } }
            if (entrance) enter(v, profiles.size)
            people.addView(v)
        }
        manage.visibility = if (isAdmin(profiles) && profiles.size > 1) View.VISIBLE else View.GONE
        if (entrance) findViewById<View>(R.id.whoTitle).apply {
            alpha = 0f
            translationY = 10 * resources.displayMetrics.density
            animate().alpha(1f).translationY(0f).setDuration(420).setInterpolator(EASE).start()
        }
        val tiles = (0 until people.childCount).map(people::getChildAt).filter { it.isFocusable }
        val start = tiles.firstOrNull { (it.tag as? Profile)?.id == focusedId } ?: tiles.firstOrNull()
        (start ?: manage).requestFocus()
    }

    private fun enter(v: View, i: Int) {
        v.alpha = 0f
        v.translationY = 14 * resources.displayMetrics.density
        v.animate().alpha(1f).translationY(0f).setStartDelay(120L + i * 55L).setDuration(420).setInterpolator(EASE).start()
    }

    private fun focusChanged(v: View, has: Boolean) {
        val disc = v.findViewById<View>(R.id.disc)
        val scale = if (has) FOCUS_SCALE else 1f
        disc.animate().scaleX(scale).scaleY(scale).setDuration(260).setInterpolator(EASE).start()
        v.findViewById<View>(R.id.ring).animate().alpha(if (has) 1f else 0f).setDuration(200).start()
        v.findViewById<TextView>(R.id.name).apply {
            setTextColor(getColor(if (has) R.color.text else R.color.muted))
            fontVariationSettings = if (has) "'wght' 700" else "'wght' 500"
            animate().translationY(if (has) 6 * resources.displayMetrics.density else 0f).setDuration(260).setInterpolator(EASE).start()
        }
        // The others step back a little, so the one you're on stands out.
        for (i in 0 until people.childCount) {
            val other = people.getChildAt(i)
            other.findViewById<View>(R.id.disc).animate().alpha(if (other === v || !has) 1f else 0.6f).setDuration(220).start()
        }
        if (has) aura.glowTo((v.tag as? Profile)?.picture?.tint ?: ADD_TINT)
    }

    // ---------- Managing profiles (the admin) ----------

    private fun setManaging(on: Boolean) {
        managing = on
        findViewById<TextView>(R.id.whoTitle).text = if (on) "Manage profiles" else "Who's watching?"
        manage.text = if (on) "Done" else "Manage profiles"
        show(shown, entrance = false)
    }

    private fun askRemove(p: Profile, v: View) {
        if (p.isAdmin || busy) return
        Sheet.show(this, v, "Remove ${p.name}?", "Their watch history, ratings and settings go too", listOf(
            Sheet.Action(R.drawable.ic_act_remove, "Remove") { AdminPin.ensure(this) { remove(p) } },
            Sheet.Action(R.drawable.ic_act_close, "Keep") {},
        ))
    }

    private fun remove(p: Profile) {
        busy = true
        io.execute {
            val ok = Feed.post("/launcher/profiles/delete", JSONObject().put("id", p.id))
            val fresh = if (ok) runCatching { Profiles.fetch() }.getOrNull() else null
            runOnUiThread {
                busy = false
                if (!ok) return@runOnUiThread Notice.show(this, "Couldn't remove ${p.name}. Try again.")
                Notice.show(this, "Removed ${p.name}")
                shown = fresh ?: shown.filter { it.id != p.id }
                // Nobody left to remove: back to choosing.
                setManaging(managing && shown.size > 1)
            }
        }
    }

    // ---------- Adding a profile (the admin) ----------

    private fun openAdder() {
        if (busy) return
        // Start on an avatar nobody has yet.
        val taken = shown.map { it.picture.key }.toSet()
        val start = Avatars.all.indexOfFirst { it.key !in taken }.coerceAtLeast(0)
        carousel.show(Avatars.all, start)
        carousel.onChanged = { a -> adderAvatar(a) }
        carousel.onPick = { nameField.requestFocus(); showKeyboard() }
        adderAvatar(Avatars.all[start])
        nameField.setText("")
        val content = findViewById<View>(R.id.content)
        content.animate().alpha(0f).scaleX(0.94f).scaleY(0.94f).setDuration(260).setInterpolator(EASE)
            .withEndAction { content.visibility = View.INVISIBLE }.start()
        findViewById<View>(R.id.whoHint).visibility = View.GONE
        adder.visibility = View.VISIBLE
        adder.alpha = 0f
        adder.scaleX = 1.04f
        adder.scaleY = 1.04f
        adder.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(360).setInterpolator(EASE).start()
        carousel.requestFocus()
    }

    private fun adderAvatar(a: Avatars.Avatar) {
        aura.glowTo(a.tint)
        findViewById<TextView>(R.id.adderAvatarName).text = a.label
    }

    private fun closeAdder(focusId: String? = null) {
        hideKeyboard()
        adder.animate().alpha(0f).scaleX(1.04f).scaleY(1.04f).setDuration(240).setInterpolator(EASE)
            .withEndAction { adder.visibility = View.GONE }.start()
        val content = findViewById<View>(R.id.content)
        content.visibility = View.VISIBLE
        content.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(340).setInterpolator(EASE).start()
        if (!fromMenu) findViewById<View>(R.id.whoHint).visibility = View.VISIBLE
        show(shown, entrance = false, focusId = focusId)
    }

    private fun addProfile() {
        if (busy) return
        val name = nameField.text.toString().trim().replace(Regex("\\s+"), " ")
        if (name.isEmpty()) {
            nameField.requestFocus()
            return Notice.show(this, "Type a name first")
        }
        // (Unlocked when the screen opened; asked again only if that has run out since.)
        AdminPin.ensure(this) { add(name) }
    }

    private fun add(name: String) {
        if (busy) return
        busy = true
        val body = JSONObject().put("name", name).put("avatar", carousel.current.key)
        io.execute {
            // The server's reason when it says no ("There's already a profile called …").
            val answer = runCatching {
                val request = Request.Builder().url("${Server.url}/launcher/profiles")
                    .post(body.toString().toRequestBody("application/json".toMediaType())).build()
                Feed.http.newCall(request).execute().use { r -> r.isSuccessful to JSONObject(r.body!!.string()) }
            }.getOrNull()
            val fresh = if (answer?.first == true) runCatching { Profiles.fetch() }.getOrNull() else null
            runOnUiThread {
                busy = false
                val (ok, json) = answer ?: (false to JSONObject())
                if (!ok) return@runOnUiThread Notice.show(this, json.optString("error").ifBlank { "Couldn't add that profile. Try again." })
                val id = json.optString("id")
                shown = fresh ?: shown
                closeAdder(focusId = id)
            }
        }
    }

    private fun inScreen(v: View?): Boolean {
        var at: Any? = v
        while (at is View) {
            if (at.id == R.id.content || at === adder) return true
            at = at.parent
        }
        return v == null
    }

    private fun showKeyboard() = nameField.post { getSystemService(InputMethodManager::class.java).showSoftInput(nameField, 0) }

    private fun hideKeyboard() {
        currentFocus?.let { getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0) }
    }

    private fun pick(p: Profile, v: View) {
        if (leaving) return
        leaving = true
        // The same person again, from the menu: just go back to where they were.
        if (fromMenu && p.id == Profiles.currentId) return close()
        Profiles.choose(p)
        val disc = v.findViewById<View>(R.id.disc)
        disc.animate().scaleX(FOCUS_SCALE * 1.06f).scaleY(FOCUS_SCALE * 1.06f).setDuration(140).setInterpolator(EASE).withEndAction {
            findViewById<View>(android.R.id.content).animate().alpha(0f).setDuration(220).withEndAction(::openHome).start()
        }.start()
    }

    private fun openHome() {
        startActivity(Intent(this, HomeActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(HomeActivity.EXTRA_PROFILE_CHOSEN, true))
        finish()
        @Suppress("DEPRECATION") overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    private fun close() {
        finish()
        @Suppress("DEPRECATION") overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (leaving) return true
        // The remove question (a Sheet over the screen) handles its own keys.
        if (!inScreen(currentFocus)) return super.dispatchKeyEvent(event)
        if (event.keyCode == KeyEvent.KEYCODE_BACK && adder.visibility == View.VISIBLE) {
            if (event.action == KeyEvent.ACTION_UP && !busy) closeAdder()
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK && managing) {
            if (event.action == KeyEvent.ACTION_UP) setManaging(false)
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            // Nobody chosen yet (a new TV with several profiles): there's no one to carry on as.
            if (Profiles.currentId == null) {
                if (shown.isNotEmpty()) findViewById<TextView>(R.id.whoHint).apply { text = "Pick a profile to start"; visibility = View.VISIBLE }
                return true
            }
            // Carry on as whoever was watching.
            leaving = true
            if (fromMenu) close() else openHome()
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    companion object {
        private const val FOCUS_SCALE = 1.16f
        private const val MAX_PROFILES = 6
        /** The "Add profile" disc: a quiet grey-blue. */
        private const val ADD_TINT = 0xFF2A3344.toInt()
        private val EASE = PathInterpolator(0.2f, 0f, 0f, 1f)

        private const val EXTRA_FROM_MENU = "fromMenu"

        fun intent(context: Context) = Intent(context, ProfilesActivity::class.java)

        fun fromMenu(context: Context) = intent(context).putExtra(EXTRA_FROM_MENU, true)
    }
}

/** Two soft pools of light in the focused avatar's colour, easing from one colour to the next. */
class AuraView(context: Context, attrs: AttributeSet?) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var color = 0xFF2E3A4A.toInt()
    private var animator: ValueAnimator? = null

    fun glowTo(tint: Int) {
        // The disc colours are deep; the light they cast is brighter and richer.
        val hsv = FloatArray(3).also { android.graphics.Color.colorToHSV(tint, it) }
        hsv[1] = (hsv[1] * 1.35f).coerceAtMost(0.85f)
        hsv[2] = 0.78f
        val target = android.graphics.Color.HSVToColor(hsv)
        animator?.cancel()
        animator = ValueAnimator.ofObject(ArgbEvaluator(), color, target).apply {
            duration = 600
            addUpdateListener { color = it.animatedValue as Int; invalidate() }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        pool(canvas, w * 0.5f, h * 0.52f, w * 0.48f, 0x66)
        pool(canvas, w * 0.1f, h * 1.05f, w * 0.42f, 0x4A)
        pool(canvas, w * 0.95f, h * -0.05f, w * 0.38f, 0x40)
    }

    private fun pool(canvas: Canvas, x: Float, y: Float, r: Float, alpha: Int) {
        val c = (color and 0x00FFFFFF) or (alpha shl 24)
        paint.shader = RadialGradient(x, y, r, c, c and 0x00FFFFFF, Shader.TileMode.CLAMP)
        canvas.drawCircle(x, y, r, paint)
    }
}
