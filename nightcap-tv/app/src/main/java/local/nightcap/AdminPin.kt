package local.nightcap

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
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
 * The admin PIN: adding or removing profiles and changing someone else's need the admin profile
 * unlocked on this TV (an admin session from the server, sent as X-Admin-Session). With no PIN set
 * yet (or after the server's owner reset it), the admin chooses one here, typed twice. The session
 * lives in memory only, and goes when the profile changes or the app closes (the server ends it
 * after half an hour unused).
 */
object AdminPin {
    @Volatile var session: String? = null
    @Volatile private var checking = false
    private val io = Executors.newSingleThreadExecutor()

    /** Runs [then] once this TV is unlocked as the admin: straight away if it is, else after the PIN. */
    fun ensure(activity: Activity, then: () -> Unit) {
        // (A second press while it's checking: one PIN card, not two.)
        if (checking) return
        checking = true
        io.execute {
            val status = runCatching { call(Request.Builder().url("${Server.url}/household/admin.json").build()) }.getOrNull()
            activity.runOnUiThread {
                checking = false
                if (activity.isFinishing) return@runOnUiThread
                when {
                    status == null -> Notice.show(activity, "Couldn't reach the server. Try again.")
                    status.first == 403 -> Notice.show(activity, "Only the admin profile can do that")
                    status.first != 200 -> Notice.show(activity, "Couldn't check the admin PIN. Try again.")
                    !status.second.optBoolean("pinSet") -> choose(activity, null, then)
                    status.second.optBoolean("unlocked") -> then()
                    else -> ask(activity, null, then)
                }
            }
        }
    }

    private fun ask(activity: Activity, problem: String?, then: () -> Unit) =
        card(activity, "Admin PIN", problem ?: "Enter the admin PIN to make this change.", problem != null, "Unlock") {
            submit(activity, it, then)
        }

    /** No PIN yet: one chosen, then typed again; [first] is the first typing. */
    private fun choose(activity: Activity, problem: String?, then: () -> Unit, first: String? = null) {
        if (first == null) card(activity, "Set an admin PIN",
            problem ?: "Choose a PIN of 4 to 8 digits. It's asked for before admin changes.", problem != null, "Next") { pin ->
            if (pin.length !in 4..8) choose(activity, "A PIN is 4 to 8 digits.", then) else choose(activity, null, then, pin)
        } else card(activity, "Set an admin PIN", "Type it again.", false, "Set PIN") { pin ->
            if (pin != first) choose(activity, "Those didn't match. Choose a PIN again.", then) else set(activity, pin, then)
        }
    }

    private fun card(activity: Activity, title: String, detail: String, isProblem: Boolean, action: String, done: (String) -> Unit) {
        val card = LayoutInflater.from(activity).inflate(R.layout.pin_card, null, false)
        card.findViewById<TextView>(R.id.pinTitle).text = title
        val admin = Profiles.list().firstOrNull { it.id == Profiles.currentId }
        admin?.picture?.let { picture ->
            card.findViewById<ImageView>(R.id.pinAvatar).setImageResource(picture.image)
            ((card.findViewById<View>(R.id.pinDisc).background.mutate() as LayerDrawable).getDrawable(0) as GradientDrawable)
                .setColor(picture.tint)
        }
        card.findViewById<TextView>(R.id.pinWho).text = listOfNotNull(admin?.name, "Admin").joinToString("  ·  ")
        card.findViewById<TextView>(R.id.pinDetail).apply {
            text = detail
            if (isProblem) setTextColor(activity.getColor(R.color.text))
        }
        val field = card.findViewById<EditText>(R.id.pinField)
        val list = card.findViewById<LinearLayout>(R.id.pinChoices)
        fun choice(icon: Int, label: String) = LayoutInflater.from(activity).inflate(R.layout.sheet_item, list, false).apply {
            findViewById<ImageView>(R.id.sheetIcon).setImageResource(icon)
            findViewById<TextView>(R.id.sheetLabel).text = label
            list.addView(this)
        }
        val unlock = choice(R.drawable.ic_check, action)
        val cancel = choice(R.drawable.ic_act_close, "Cancel")
        val close = Sheet.present(activity, activity.currentFocus, card, card.findViewById(R.id.pinGlass),
            listOf(unlock to { hideKeyboard(activity); done(field.text.toString()) }, cancel to {}),
            widthDp = 340, across = false, onCancel = {})
        // Up from Unlock goes back to the PIN; Done on the keyboard unlocks; Back closes the card.
        unlock.nextFocusUpId = field.id
        field.setOnEditorActionListener { _, action, _ ->
            (action == EditorInfo.IME_ACTION_DONE).also { if (it) unlock.performClick() }
        }
        field.setOnKeyListener { _, code, e ->
            (code == KeyEvent.KEYCODE_BACK && e.action == KeyEvent.ACTION_UP).also { if (it) close() }
        }
        // (Once the card is up: it takes focus for its first choice as it appears.)
        field.postDelayed({
            field.requestFocus()
            activity.getSystemService(InputMethodManager::class.java).showSoftInput(field, 0)
        }, 350)
    }

    private fun hideKeyboard(activity: Activity) {
        activity.currentFocus?.let { activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0) }
    }

    /** A new PIN saved; the answer is a session, so this TV is unlocked straight away. */
    private fun set(activity: Activity, pin: String, then: () -> Unit) = io.execute {
        val answer = runCatching {
            call(Request.Builder().url("${Server.url}/household/admin/pin")
                .post(JSONObject().put("pin", pin).toString().toRequestBody("application/json".toMediaType())).build())
        }.getOrNull()
        activity.runOnUiThread {
            if (activity.isFinishing) return@runOnUiThread
            val (status, json) = answer ?: return@runOnUiThread Notice.show(activity, "Couldn't reach the server. Try again.")
            if (status == 200 && json.has("session")) {
                session = json.getString("session")
                Notice.show(activity, "Admin PIN set")
                then()
            } else Notice.show(activity, "Couldn't set the PIN. Try again.")
        }
    }

    private fun submit(activity: Activity, pin: String, then: () -> Unit) {
        if (pin.length !in 4..8) return ask(activity, "A PIN is 4 to 8 digits.", then)
        io.execute {
            val answer = runCatching {
                call(Request.Builder().url("${Server.url}/household/admin/unlock")
                    .post(JSONObject().put("pin", pin).toString().toRequestBody("application/json".toMediaType())).build())
            }.getOrNull()
            activity.runOnUiThread {
                if (activity.isFinishing) return@runOnUiThread
                val (status, json) = answer ?: return@runOnUiThread Notice.show(activity, "Couldn't reach the server. Try again.")
                when {
                    status == 200 && json.has("session") -> {
                        session = json.getString("session")
                        then()
                    }
                    status == 403 && json.optString("error").contains("set the admin PIN", ignoreCase = true) ->
                        choose(activity, null, then)
                    status == 429 -> Notice.show(activity,
                        "Too many wrong PINs. Try again in ${(json.optInt("lockedFor") + 59) / 60} minutes.")
                    json.has("triesLeft") -> json.optInt("triesLeft").let { left ->
                        ask(activity, "That isn't the PIN. $left ${if (left == 1) "try" else "tries"} left.", then)
                    }
                    else -> Notice.show(activity, "Couldn't unlock. Try again.")
                }
            }
        }
    }

    /** The answer's status and JSON (an empty object if it had none). */
    private fun call(request: Request): Pair<Int, JSONObject> =
        Feed.http.newCall(request).execute().use { r ->
            r.code to (runCatching { JSONObject(r.body!!.string()) }.getOrNull() ?: JSONObject())
        }
}
