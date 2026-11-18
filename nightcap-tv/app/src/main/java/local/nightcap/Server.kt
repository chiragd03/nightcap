package local.nightcap

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.InetAddress

/**
 * Which Nightcap server this TV talks to, and its key for the household it joined there (sent
 * with every request). Chosen on the Connect screen the first time Nightcap opens; nothing about
 * either is built into the app.
 *
 * Every server joined is remembered with its own key ([saved]), so the TV can go back to one
 * ([switchTo]) without joining it again: a home server for trying things out and the cloud one,
 * say. Leaving a household, or a server that no longer knows the TV, forgets that one only.
 */
object Server {
    private const val PREFS = "server"
    private const val KEY_URL = "url"
    private const val KEY_DEVICE = "deviceKey"
    private const val KEY_HOUSEHOLD = "household"
    private const val KEY_HOUSEHOLD_ID = "householdId"
    private const val KEY_SAVED = "saved"

    /** A server this TV has joined: its address, this TV's key there, and the household's name and id. */
    class Saved(val url: String, val key: String, val household: String, val householdId: String) {
        /** Where it is, as people read it: "Home network · 192.168.1.20:7171", "Internet · nightcap.example.com". */
        val where get() = where(url)
    }

    /** Where [address] is, as people read it: on the home network (its address), or on the internet
     *  (its name's first part, a long one cut short). */
    fun where(address: String): String {
        val host = address.removePrefix("http://").removePrefix("https://")
        if (atHome(address)) return "Home network · $host"
        val first = host.substringBefore('.').substringBefore(':')
        return "Internet · " + if (first.length > 20) first.take(18) + "…" else first
    }

    /** "http://host:port", or "" before the TV is connected. */
    @Volatile var url: String = ""
        private set
    @Volatile var key: String? = null
        private set
    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context.applicationContext
        url = prefs().getString(KEY_URL, null).orEmpty()
        key = prefs().getString(KEY_DEVICE, null)
        // (A TV that joined before servers were remembered: its one server is the first.)
        if (prefs().getString(KEY_SAVED, null) == null && ready)
            remember(Saved(url, key!!, prefs().getString(KEY_HOUSEHOLD, null).orEmpty(), prefs().getString(KEY_HOUSEHOLD_ID, null).orEmpty()))
    }

    /** Every server this TV has joined and can go back to, the one in use too. */
    val saved: List<Saved>
        get() = runCatching {
            val a = org.json.JSONArray(prefs().getString(KEY_SAVED, null) ?: "[]")
            (0 until a.length()).map { a.getJSONObject(it) }.map {
                Saved(it.getString("url"), it.getString("key"), it.optString("household"), it.optString("householdId"))
            }
        }.getOrDefault(emptyList())

    /** The one saved for [address], if this TV has joined it. */
    fun savedFor(address: String) = saved.firstOrNull { it.url == address }

    private fun remember(s: Saved) = keepSaved(listOf(s) + saved.filter { it.url != s.url })

    private fun forgetSaved(address: String) = keepSaved(saved.filter { it.url != address })

    private fun keepSaved(list: List<Saved>) {
        val a = org.json.JSONArray()
        list.forEach { a.put(JSONObject().put("url", it.url).put("key", it.key).put("household", it.household).put("householdId", it.householdId)) }
        prefs().edit().putString(KEY_SAVED, a.toString()).apply()
    }

    /** Leaves the household on a saved server that isn't the one in use: that server forgets this TV
     *  (asked with its own key), then so does the TV. Runs on a background thread; throws with a
     *  message fit to show when the server can't be reached (forget it here only with [forget]). */
    fun leave(s: Saved) {
        val answered = runCatching {
            Feed.http.newCall(Request.Builder().url("${s.url}/launcher/leave").header("X-Device-Key", s.key)
                .post("{}".toRequestBody("application/json".toMediaType())).build()).execute().use { it.code }
        }.getOrElse { throw IllegalStateException("Couldn't reach it.") }
        // (A 401: that server had already forgotten this TV. Left either way.)
        if (answered !in 200..299 && answered != 401) throw IllegalStateException("Couldn't leave. Try again.")
        forgetSaved(s.url)
    }

    /** Forgets a saved server on this TV only (one that can't be reached to leave it). */
    fun forget(s: Saved) = forgetSaved(s.url)

    /** Goes back to a server this TV has joined, with its own key: no joining again. */
    fun switchTo(s: Saved) = save(s.url, s.key, s.household, s.householdId)

    private fun prefs() = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    val ready get() = url.isNotEmpty() && key != null

    /** A typed address ("192.168.1.20:7171", "https://nightcap.example.com") as "scheme://host:port",
     *  or null if it isn't one. A server on the internet must use https. */
    fun normalise(typed: String): String? {
        val t = typed.trim().trimEnd('/')
        if (t.isEmpty()) return null
        val withScheme = if (t.startsWith("http://") || t.startsWith("https://")) t else "http://$t"
        val parsed = withScheme.toHttpUrlOrNull() ?: return null
        if (parsed.encodedPath != "/" || parsed.query != null) return null
        return withScheme
    }

    /**
     * What was typed on the Connect screen, as the server's address: an address as it is ([normalise]),
     * or a link to the server (its invite link, or a short link to it, like is.gd/abc12), followed to
     * where it leads and cut to "scheme://host:port". Null if it's neither. Runs on a background
     * thread (a link is opened); throws with a message fit to show when a link can't be opened.
     */
    fun addressFrom(typed: String): String? {
        normalise(typed)?.let { plain ->
            // A name typed without http(s):// for a server outside the home: it's https there.
            val bare = !typed.trim().startsWith("http://") && !typed.trim().startsWith("https://")
            return if (bare && !atHome(plain)) "https://" + plain.removePrefix("http://") else plain
        }
        val t = typed.trim().substringBefore('#')
        val link = (if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t").toHttpUrlOrNull() ?: return null
        val landed = runCatching {
            Feed.http.newCall(Request.Builder().url(link).build()).execute().use { it.request.url }
        }.getOrElse { throw IllegalStateException("Couldn't reach that address. Check it and try again.") }
        val port = if (landed.port == okhttp3.HttpUrl.defaultPort(landed.scheme)) "" else ":${landed.port}"
        return "${landed.scheme}://${landed.host}$port"
    }

    /** The join code in an invite link (after #), if what was typed has one. */
    fun codeFrom(typed: String): String? = typed.substringAfter('#', "").trim().takeIf { it.isNotEmpty() }

    /** Whether [address] is on the home network (a private address or a .local name), where plain http is fine. */
    fun atHome(address: String): Boolean {
        val host = address.toHttpUrlOrNull()?.host ?: return false
        if (host.endsWith(".local")) return true
        if (!host.all { it.isDigit() || it == '.' }) return false
        return runCatching { InetAddress.getByName(host).let { it.isSiteLocalAddress || it.isLoopbackAddress } }.getOrDefault(false)
    }

    /** What joining [address] takes: a code, or one of its households. Runs on a background thread. */
    fun households(address: String): Joining {
        val json = call(Request.Builder().url("$address/join/households.json").build())
        val list = json.optJSONArray("households")
        return Joining(json.optString("server").ifEmpty { "Nightcap" }, json.optBoolean("codeRequired", true),
            (0 until (list?.length() ?: 0)).map { list!!.getJSONObject(it).let { h -> h.getString("id") to h.getString("name") } })
    }

    /** Joins a household on [address], by [household] id or by [code], and saves this TV's key.
     *  Runs on a background thread; throws with a message fit to show. */
    fun join(address: String, household: String? = null, code: String? = null) {
        // (Android's id for this app on this TV, the same after reinstalling: joining again
        // replaces this TV's old entry on the Devices page instead of adding another.)
        val install = android.provider.Settings.Secure.getString(appContext.contentResolver, android.provider.Settings.Secure.ANDROID_ID)
        val body = JSONObject().put("device", android.os.Build.MODEL)
            .apply { if (!install.isNullOrBlank()) put("install", "android:$install") }
            .apply { if (household != null) put("household", household); if (code != null) put("code", code) }
        val json = call(Request.Builder().url("$address/join")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build())
        val joined = json.getJSONObject("household")
        save(address, json.getString("key"), joined.optString("name"), joined.optString("id"))
    }

    private fun call(request: Request): JSONObject {
        val (status, text) = runCatching {
            Feed.http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() }
        }.getOrElse { throw IllegalStateException("Couldn't reach a Nightcap server there.") }
        val json = runCatching { JSONObject(text) }.getOrNull()
            ?: throw IllegalStateException("That address answered, but it isn't a Nightcap server.")
        if (status != 200) throw IllegalStateException(json.optString("error").ifEmpty { "The server said no ($status)." })
        return json
    }

    /** This TV now uses [address], with [deviceKey] for its household; what was cached for another is set aside. */
    private fun save(address: String, deviceKey: String, household: String, householdId: String) {
        // Another server, or another household on the same one: none of the saved profiles are its
        // own (who's watching is asked again). The same household joined again keeps them.
        val another = address != url || householdId.isEmpty() || householdId != prefs().getString(KEY_HOUSEHOLD_ID, null)
        prefs().edit().putString(KEY_URL, address).putString(KEY_DEVICE, deviceKey).putString(KEY_HOUSEHOLD, household)
            .putString(KEY_HOUSEHOLD_ID, householdId).apply()
        url = address
        key = deviceKey
        remember(Saved(address, deviceKey, household, householdId))
        if (another) Profiles.forgetAll()
        Pages.clear()
        Feed.markChanged()
    }

    /** The household this TV is in (its name), or null. */
    val household: String? get() = if (ready) prefs().getString(KEY_HOUSEHOLD, null) else null

    /** This TV leaves its household: the server forgets its key at once, and so does the TV, with the
     *  household's profiles. Runs on a background thread; throws with a message fit to show. */
    fun leave() {
        val answered = runCatching {
            Feed.http.newCall(Request.Builder().url("$url/launcher/leave").post("{}".toRequestBody("application/json".toMediaType())).build())
                .execute().use { it.code }
        }.getOrElse { throw IllegalStateException("Couldn't reach the server. Try again.") }
        // (A 401: the server had already forgotten this TV. Left either way.)
        if (answered !in 200..299 && answered != 401) throw IllegalStateException("Couldn't leave. Try again.")
        forgetHere()
    }

    /** The household in use is forgotten on this TV only (its server can't be reached to leave it):
     *  that server keeps the TV on its list until it's removed there. */
    fun forgetHere() {
        key = null
        prefs().edit().remove(KEY_DEVICE).remove(KEY_HOUSEHOLD_ID).apply()
        forgetSaved(url)
        Profiles.forgetAll()
        Pages.clear()
    }

    /** The server no longer knows this TV (its household or key is gone): it connects again, from
     *  the Connect screen at once if a Nightcap screen is open (else Home sends it there when it opens). */
    fun forget() {
        if (key == null) return
        val was = household?.takeIf { it.isNotBlank() }
        key = null
        prefs().edit().remove(KEY_DEVICE).apply()
        forgetSaved(url)
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            val open = NightcapApp.resumed ?: return@post
            if (open is ConnectActivity) return@post
            open.startActivity(ConnectActivity.intent(open)
                .putExtra(ConnectActivity.EXTRA_REMOVED_FROM, was ?: "your household")
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
        }
    }

    class Joining(val server: String, val codeRequired: Boolean, val households: List<Pair<String, String>>)
}
