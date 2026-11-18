package local.nightcap

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.PathInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.view.Gravity
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors

/**
 * The first screen on a new TV (and after the server forgets it): which Nightcap server, then
 * which household on it.
 *
 * Servers on the home network are found by themselves (Discovery) and shown as tiles; one
 * elsewhere is typed in the glass card (its address, or a link to it), and must use https. A server at home may let a TV pick
 * its household (tiles again); otherwise (always on the internet) the panel asks for the
 * household's join code.
 */
class ConnectActivity : TvActivity() {
    private val io = Executors.newSingleThreadExecutor()
    private val dp by lazy { resources.displayMetrics.density }
    private lateinit var aura: AuraView
    private lateinit var main: View
    private lateinit var title: TextView
    private lateinit var hint: TextView
    private lateinit var tiles: LinearLayout
    private lateinit var status: TextView
    private lateinit var scrim: View
    private lateinit var panel: View
    private lateinit var panelField: EditText
    private lateinit var panelGo: TextView
    private lateinit var panelStatus: TextView
    /** The server being joined (choosing its household), or null while choosing the server. */
    private var chosen: String? = null
    /** What the panel's OK does, or null when it's closed. */
    private var panelAction: (() -> Unit)? = null
    private var openedFrom: View? = null
    private var busy = false
    /** A join code that came in the typed link (after #), filled in when the code is asked for. */
    private var linkCode: String? = null
    private lateinit var codeBoxes: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connect)
        aura = findViewById(R.id.aura)
        main = findViewById(R.id.main)
        title = findViewById(R.id.connectTitle)
        hint = findViewById(R.id.connectHint)
        tiles = findViewById(R.id.tiles)
        status = findViewById(R.id.connectStatus)
        scrim = findViewById(R.id.scrim)
        panel = findViewById(R.id.panel)
        panelField = findViewById(R.id.panelField)
        panelGo = findViewById(R.id.panelGo)
        panelStatus = findViewById(R.id.panelStatus)
        panelGo.setOnClickListener { panelAction?.invoke() }
        val cancel = findViewById<View>(R.id.panelCancel)
        cancel.setOnClickListener { cancelPanel() }
        codeBoxes = findViewById(R.id.codeBoxes)
        // With the keyboard put away, Down from the field goes to the buttons, and Up comes back.
        panelField.setOnKeyListener { _, code, e ->
            (code == KeyEvent.KEYCODE_DPAD_DOWN && e.action == KeyEvent.ACTION_DOWN).also { if (it) panelGo.requestFocus() }
        }
        listOf(panelGo, cancel).forEach { b ->
            b.setOnKeyListener { _, code, e ->
                (code == KeyEvent.KEYCODE_DPAD_UP && e.action == KeyEvent.ACTION_DOWN).also { if (it) panelField.requestFocus() }
            }
        }
        panelField.setOnFocusChangeListener { _, _ -> showCode() }
        panelField.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(t: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(t: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(t: Editable?) = showCode()
        })
        panelField.setOnEditorActionListener { _, action, _ ->
            (action == EditorInfo.IME_ACTION_GO || action == EditorInfo.IME_ACTION_DONE).also { if (it) panelAction?.invoke() }
        }
        aura.glowTo(SERVER_TINT)
        search()
        // Sent here because the household removed this TV: said, not left to guess.
        intent.getStringExtra(EXTRA_REMOVED_FROM)?.let { say("This TV was removed from $it. Join again with a join code.") }
    }

    // ---------- Step 1: which server ----------

    private fun search() {
        chosen = null
        title.text = "Connect to Nightcap"
        hint.text = "Pick your Nightcap server. One on your home network shows up here by itself."
        say("")
        tiles.removeAllViews()
        connectedTile()?.let(tiles::addView)
        // The other servers this TV has joined: one press goes back to one, no code.
        Server.saved.filter { it.url != Server.url || !Server.ready }.forEach { s ->
            tiles.addView(tile("SWITCH TO", s.household.ifBlank { "Your household" }, s.where, HOUSEHOLD_TINT, R.drawable.ic_nav_home) { v -> joined(v, s) })
        }
        val looking = tile("ON YOUR NETWORK", "Looking…", "Searching your home network", SERVER_TINT, R.drawable.ic_wifi) {}
            .apply { isFocusable = false }
        Waiting.on(looking.findViewById(R.id.tileName))
        tiles.addView(looking)
        val another = anotherServerTile()
        tiles.addView(another)
        another.requestFocus()
        io.execute {
            // (Not the one in use, or one joined already: those have their own tiles.)
            val known = Server.saved.map { it.url }.toSet() + listOfNotNull(Server.url.takeIf { Server.ready })
            val found = Discovery.search().filter { it.url !in known }
            runOnUiThread {
                if (isFinishing || chosen != null || looking.parent == null) return@runOnUiThread
                // The searching tile becomes what was found, in place: nothing else is drawn again
                // (no flash), and focus stays where it is.
                if (found.isEmpty()) return@runOnUiThread fill(looking, "ON YOUR NETWORK", "Nothing found", "Search again",
                    R.drawable.ic_wifi) { search() }
                fill(looking, "ON YOUR NETWORK", found[0].name, "On your home network", R.drawable.ic_wifi) { choose(found[0].url) }
                found.drop(1).forEachIndexed { n, s ->
                    tiles.addView(tile("ON YOUR NETWORK", s.name, "On your home network", SERVER_TINT, R.drawable.ic_wifi) { choose(s.url) },
                        tiles.indexOfChild(looking) + 1 + n)
                }
                tiles.addView(tile("ON YOUR NETWORK", "Search again", "Look once more", OTHER_TINT, R.drawable.ic_wifi) { search() })
            }
        }
    }

    /** The household this TV is in now, and where; pressed, a choice to keep using it or leave it.
     *  None for a TV that isn't in one. */
    private fun connectedTile(): View? {
        if (!Server.ready) return null
        val name = Server.household?.takeIf { it.isNotBlank() } ?: "Your household"
        val where = Server.where(Server.url)
        return tile("IN USE", name, where, SERVER_TINT, R.drawable.ic_nav_home) { v -> inUse(v, name, where) }
    }

    private fun inUse(from: View, name: String, where: String) {
        Sheet.show(this, from, name, "This TV uses it now: $where.", listOf(
            Sheet.Action(R.drawable.ic_nav_home, "Keep using it") {},
            Sheet.Action(R.drawable.ic_sign_out, "Leave this household") { askLeave(from, name, where) },
        ))
    }

    private fun askLeave(from: View, name: String, where: String) {
        Sheet.show(this, from, "Leave $name?", "On $where. This TV stops using it, and can join again with a join code.", listOf(
            Sheet.Action(R.drawable.ic_sign_out, "Leave") { leave(from, name, where) },
            Sheet.Action(R.drawable.ic_act_close, "Stay") {},
        ))
    }

    private fun leave(from: View, name: String, where: String) {
        if (busy) return
        busy = true
        say("Leaving…")
        io.execute {
            val left = runCatching { Server.leave() }
            runOnUiThread {
                busy = false
                if (isFinishing) return@runOnUiThread
                left.onSuccess { search(); say("This TV has left $name on $where.") }.onFailure {
                    say("")
                    // (Its server off or out of reach: it can still be forgotten here.)
                    couldntReach(from, name, where) { Server.forgetHere() }
                }
            }
        }
    }

    /** Leaving [name] couldn't reach its server: forget it on this TV only ([forget]), or keep it. */
    private fun couldntReach(from: View, name: String, where: String, forget: () -> Unit) {
        Sheet.show(this, from, "Couldn't reach $name",
            "On $where. Forget it on this TV only? It stays on that server's list of devices until it's removed there.", listOf(
                Sheet.Action(R.drawable.ic_sign_out, "Forget it here") { forget(); search(); say("This TV has forgotten $name on $where.") },
                Sheet.Action(R.drawable.ic_act_close, "Keep it") {},
            ))
    }

    private fun anotherServerTile() = tile("ANOTHER SERVER", "Type an address", "For a server outside your home", OTHER_TINT,
        R.drawable.ic_globe) {
        openPanel("Another server", "Type the address you were given (a short link works too).",
            // (Plain text: the phone's Google Home keyboard shows a "web address" box like a password.)
            "Address", "Connect", EditorInfo.TYPE_CLASS_TEXT or EditorInfo.TYPE_TEXT_FLAG_NO_SUGGESTIONS, EditorInfo.IME_ACTION_GO) {
            if (busy) return@openPanel
            val typed = panelField.text.toString()
            if (typed.isBlank()) return@openPanel showInPanel("Type the address you were given.")
            busy = true
            showInPanel("Connecting…")
            io.execute {
                // (A link is followed to the server it leads to.)
                val found = runCatching { Server.addressFrom(typed) }
                runOnUiThread {
                    busy = false
                    if (isFinishing) return@runOnUiThread
                    val url = found.getOrElse { return@runOnUiThread showInPanel(it.message ?: "Couldn't open that link.") }
                        ?: return@runOnUiThread showInPanel("That doesn't look like an address. Check it and try again.")
                    // Over the internet, everything (the join code too) would be readable on the way.
                    if (url.startsWith("http://") && !Server.atHome(url))
                        return@runOnUiThread showInPanel("That address isn't secure. Ask for its secure version.")
                    linkCode = Server.codeFrom(typed)
                    choose(url)
                }
            }
        }
    }

    /** Another household this TV has joined: switch to it, or leave it. */
    private fun joined(from: View, s: Server.Saved) {
        val name = s.household.ifBlank { "Your household" }
        Sheet.show(this, from, name, s.where, listOf(
            Sheet.Action(R.drawable.ic_nav_home, "Switch to it") { switchTo(s) },
            Sheet.Action(R.drawable.ic_sign_out, "Leave this household") {
                Sheet.show(this, from, "Leave $name?", "On ${s.where}. This TV stops using it, and can join again with a join code.", listOf(
                    Sheet.Action(R.drawable.ic_sign_out, "Leave") { leaveSaved(from, s, name) },
                    Sheet.Action(R.drawable.ic_act_close, "Stay") {},
                ))
            },
        ))
    }

    private fun leaveSaved(from: View, s: Server.Saved, name: String) {
        if (busy) return
        busy = true
        say("Leaving…")
        io.execute {
            val left = runCatching { Server.leave(s) }
            runOnUiThread {
                busy = false
                if (isFinishing) return@runOnUiThread
                left.onSuccess { search(); say("This TV has left $name on ${s.where}.") }.onFailure {
                    say("")
                    couldntReach(from, name, s.where) { Server.forget(s) }
                }
            }
        }
    }

    /** Back to a server this TV has joined: its own key, straight to Home. */
    private fun switchTo(s: Server.Saved) {
        if (busy) return
        Server.switchTo(s)
        goHome()
    }

    private fun goHome() {
        startActivity(Intent(this, HomeActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    // ---------- Step 2: which household ----------

    private fun choose(url: String) {
        if (busy) return
        // (One this TV has joined, found again on the network or typed: no joining again. Its code
        // in a link is let be; leave it first to join another household there.)
        Server.savedFor(url)?.takeIf { url != Server.url || !Server.ready }?.let { return switchTo(it) }
        busy = true
        say("Connecting…")
        io.execute {
            val joining = runCatching { Server.households(url) }
            runOnUiThread {
                busy = false
                if (isFinishing) return@runOnUiThread
                joining.onFailure { say(it.message ?: "Couldn't connect.") }.onSuccess { j ->
                    chosen = url
                    when {
                        // A code: always for a server that asks for one.
                        j.codeRequired || j.households.isEmpty() -> askCode(j.server)
                        // Only one household, and no code needed: nothing to ask.
                        j.households.size == 1 -> join(household = j.households.single().first)
                        else -> showHouseholds(j)
                    }
                }
            }
        }
    }

    private fun showHouseholds(j: Server.Joining) {
        closePanel(refocus = false)
        title.text = "Which household?"
        hint.text = "This TV joins one household on ${j.server}. Press Back for another server."
        say("")
        tiles.removeAllViews()
        j.households.forEach { (id, name) ->
            tiles.addView(tile("HOUSEHOLD", name, "Join", HOUSEHOLD_TINT, R.drawable.ic_nav_home) { join(household = id) })
        }
        tiles.getChildAt(0)?.requestFocus()
    }

    private fun askCode(server: String) {
        openPanel("Join code", "Type your household's join code. Whoever looks after your household can give it to you.",
            "Join code", "Join", EditorInfo.TYPE_CLASS_TEXT or EditorInfo.TYPE_TEXT_FLAG_CAP_CHARACTERS or
                EditorInfo.TYPE_TEXT_FLAG_NO_SUGGESTIONS, EditorInfo.IME_ACTION_DONE) {
            val typed = panelField.text.toString().trim()
            if (typed.isEmpty()) return@openPanel showInPanel("Type the household's join code.")
            join(code = typed)
        }
        // (The code that came in the link, ready to send.)
        linkCode?.let { panelField.setText(it); panelField.setSelection(it.length) }
        linkCode = null
    }

    private fun join(household: String? = null, code: String? = null) {
        val url = chosen ?: return
        if (busy) return
        busy = true
        say("Joining…")
        io.execute {
            val joined = runCatching { Server.join(url, household, code) }
            runOnUiThread {
                busy = false
                if (isFinishing) return@runOnUiThread
                joined.onSuccess {
                    startActivity(Intent(this, HomeActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                    finish()
                }.onFailure { say(it.message ?: "Couldn't join.") }
            }
        }
    }

    // ---------- The glass panel ----------

    private fun openPanel(heading: String, text: String, fieldHint: String, go: String, inputType: Int, ime: Int, action: () -> Unit) {
        openedFrom = currentFocus
        panelAction = action
        findViewById<TextView>(R.id.panelTitle).text = heading
        findViewById<TextView>(R.id.panelHint).text = text
        panelField.hint = fieldHint
        panelField.inputType = inputType
        panelField.imeOptions = ime or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        // A join code: its eight boxes, the field invisible over them taking the typing; an address: the field.
        val code = chosen != null
        codeMode(code)
        if (code) panelField.hint = ""
        panelField.setText("")
        panelGo.text = go
        showInPanel("")
        (main as ViewGroup).descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        scrim.visibility = View.VISIBLE
        scrim.animate().alpha(1f).setDuration(260).start()
        main.animate().scaleX(0.96f).scaleY(0.96f).alpha(0.35f).setDuration(320).setInterpolator(EASE).start()
        panel.visibility = View.VISIBLE
        panel.translationY = -24 * dp
        panel.alpha = 0f
        panel.animate().translationY(0f).alpha(1f).setDuration(360).setInterpolator(EASE).start()
        panelField.requestFocus()
        panelField.post { getSystemService(InputMethodManager::class.java).showSoftInput(panelField, 0) }
    }

    private fun closePanel(refocus: Boolean = true) {
        if (panelAction == null) return
        panelAction = null
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(panelField.windowToken, 0)
        (main as ViewGroup).descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        scrim.animate().alpha(0f).setDuration(200).withEndAction { scrim.visibility = View.GONE }.start()
        main.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(300).setInterpolator(EASE).start()
        panel.animate().translationY(-24 * dp).alpha(0f).setDuration(220).setInterpolator(EASE)
            .withEndAction { panel.visibility = View.GONE }.start()
        if (refocus) openedFrom?.takeIf { it.isAttachedToWindow }?.requestFocus() ?: tiles.getChildAt(0)?.requestFocus()
    }

    private fun codeMode(on: Boolean) {
        codeBoxes.visibility = if (on) View.VISIBLE else View.GONE
        if (on && codeBoxes.childCount == 0) repeat(CODE_LENGTH) { i ->
            codeBoxes.addView(TextView(this).apply {
                background = getDrawable(R.drawable.code_box)
                gravity = Gravity.CENTER
                setTextColor(getColor(R.color.text))
                textSize = 24f
                typeface = resources.getFont(R.font.big_shoulders)
                fontVariationSettings = "'wght' 700"
            }, LinearLayout.LayoutParams((46 * dp).toInt(), LinearLayout.LayoutParams.MATCH_PARENT)
                .apply { if (i > 0) marginStart = ((if (i == CODE_LENGTH / 2) 18 else 8) * dp).toInt() })
        }
        panelField.layoutParams = panelField.layoutParams.apply { height = ((if (on) 58 else 50) * dp).toInt() }
        panelField.setBackgroundResource(if (on) android.R.color.transparent else R.drawable.bar_bg)
        panelField.setTextColor(if (on) android.graphics.Color.TRANSPARENT else getColor(R.color.text))
        panelField.isCursorVisible = !on
        panelField.filters = if (on) arrayOf(InputFilter.AllCaps(), InputFilter.LengthFilter(CODE_LENGTH)) else arrayOf()
        if (on) showCode()
    }

    /** The code typed so far, a letter in each box, the next one to type outlined. */
    private fun showCode() {
        if (codeBoxes.visibility != View.VISIBLE) return
        val typed = panelField.text.toString()
        for (i in 0 until codeBoxes.childCount) {
            (codeBoxes.getChildAt(i) as TextView).apply {
                text = typed.getOrNull(i)?.toString().orEmpty()
                isSelected = panelField.hasFocus() && i == typed.length.coerceAtMost(CODE_LENGTH - 1)
            }
        }
    }

    /** Back, or Cancel: a code asked for straight after picking the server goes back to the servers. */
    private fun cancelPanel() {
        if (chosen != null) {
            closePanel(refocus = false)
            search()
        } else closePanel()
    }

    // ---------- Bits ----------

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            when {
                panelAction != null -> cancelPanel()
                chosen != null -> search()
                // In no household (none yet, or just left the one in use): nothing behind this screen
                // can be used, so Back closes Nightcap, rather than a screen of the household left.
                !Server.ready -> finishAffinity()
                else -> return super.onKeyDown(keyCode, event)
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /** A glass tile: a quiet [label], a big [name] and a line under it; focusing it lifts it and tints the glow. */
    private fun tile(label: String, name: String, sub: String, tint: Int, icon: Int, onClick: (View) -> Unit): View =
        LayoutInflater.from(this).inflate(R.layout.connect_choice, tiles, false).apply {
            fill(this, label, name, sub, icon, onClick)
            setOnFocusChangeListener { v, has ->
                val s = if (has) 1.05f else 1f
                v.animate().scaleX(s).scaleY(s).translationZ(if (has) 14 * dp else 0f).setDuration(240).setInterpolator(EASE).start()
                if (has) aura.glowTo(tint)
            }
        }

    /** A tile's words, icon and what it does (a tile that was waiting, now ready, can be picked). */
    private fun fill(v: View, label: String, name: String, sub: String, icon: Int, onClick: (View) -> Unit) {
        // (A tile that was waiting, "Looking…", stops breathing once it has its answer.)
        Waiting.off(v.findViewById(R.id.tileName))
        v.findViewById<TextView>(R.id.tileLabel).text = label
        v.findViewById<TextView>(R.id.tileName).text = name
        v.findViewById<TextView>(R.id.tileSub).text = sub
        v.findViewById<ImageView>(R.id.tileIcon).setImageResource(icon)
        v.isFocusable = true
        v.setOnClickListener { onClick(it) }
    }

    /** A line under the tiles (or in the panel, while it's open). */
    /** A line under the tiles (or in the panel, while it's open). Connecting…, Joining…, Leaving…: under
     *  way, so it breathes (see Waiting); anything else (an error, "This TV has left…") is still. */
    private fun say(text: String) {
        val view = if (panelAction != null) panelStatus.also { showInPanel(text) } else status.also { it.text = text }
        Waiting.set(view, text.endsWith("…"))
    }

    private fun showInPanel(text: String) {
        panelStatus.text = text
        panelStatus.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
    }

    override fun onDestroy() {
        io.shutdown()
        super.onDestroy()
    }

    companion object {
        private val EASE = PathInterpolator(0.2f, 0f, 0f, 1f)
        private const val CODE_LENGTH = 8
        // Cool glows, as behind Settings.
        private const val SERVER_TINT = 0xFF2E3F7A.toInt()
        private const val OTHER_TINT = 0xFF24506A.toInt()
        private const val HOUSEHOLD_TINT = 0xFF4A3A78.toInt()

        fun intent(context: Context) = Intent(context, ConnectActivity::class.java)

        /** The household that removed this TV (its name), when that's why Connect opened. */
        const val EXTRA_REMOVED_FROM = "removedFrom"
    }
}
