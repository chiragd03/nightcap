package local.nightcap

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Request
import org.json.JSONObject

data class Profile(val id: String, val name: String, val avatar: String?, val isAdmin: Boolean) {
    val picture get() = Avatars.of(avatar, id)
}

/**
 * Who's watching. Every request to the server names the chosen profile ([header]); the list of
 * profiles is kept on disk so "Who's watching?" draws at once when the TV wakes.
 */
object Profiles {
    private const val PREFS = "profiles"
    private const val KEY_CURRENT = "current"
    private const val KEY_LIST = "list"
    private const val KEY_ASK = "ask"

    /** The chosen profile's id; null until one is picked. */
    @Volatile var currentId: String? = null
        private set
    private lateinit var appContext: Context

    fun init(context: Context) {
        appContext = context.applicationContext
        currentId = prefs().getString(KEY_CURRENT, null)
    }

    private fun prefs() = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The saved list (may be a little out of date). */
    fun list(): List<Profile> = runCatching { parse(prefs().getString(KEY_LIST, null) ?: return emptyList()) }
        .getOrDefault(emptyList())

    fun current(): Profile? = list().let { all -> all.firstOrNull { it.id == currentId } ?: all.firstOrNull() }

    /** Downloads the list and saves it. Runs on a background thread. */
    fun fetch(): List<Profile> {
        val request = Request.Builder().url("${Server.url}/launcher/profiles.json").build()
        val body = Feed.http.newCall(request).execute().use { r ->
            check(r.isSuccessful) { "Server answered ${r.code}" }
            r.body!!.string()
        }
        prefs().edit().putString(KEY_LIST, body).apply()
        return parse(body)
    }

    private fun parse(json: String): List<Profile> {
        val a = JSONObject(json).getJSONArray("profiles")
        return (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            Profile(o.getString("id"), o.getString("name"), o.optString("avatar").ifEmpty { null }, o.optBoolean("isAdmin"))
        }
    }

    /** Switches to [profile]: what's cached for the last one is set aside. */
    fun choose(profile: Profile) {
        if (profile.id == currentId) return
        currentId = profile.id
        // (An admin session is the admin profile's: another profile starts locked.)
        AdminPin.session = null
        prefs().edit().putString(KEY_CURRENT, profile.id).apply()
        Pages.clear()
        Feed.markChanged()
    }

    /** The TV woke up (or started): ask who's watching the next time Nightcap is in front. */
    fun askNextTime() = prefs().edit().putBoolean(KEY_ASK, true).apply()

    /** Whether to ask now. Only worth asking when there's more than one profile; with none chosen
     *  yet (a new TV), the only one is chosen, else the TV asks. */
    fun shouldAsk(): Boolean {
        if (currentId == null) {
            val all = list()
            if (all.size != 1) return true
            choose(all.single())
            asked()
            return false
        }
        if (!prefs().getBoolean(KEY_ASK, false)) return false
        if (list().size > 1) return true
        asked()
        return false
    }

    fun asked() = prefs().edit().putBoolean(KEY_ASK, false).apply()

    /** The server didn't know the chosen profile (it was removed): ask who's watching again. */
    private fun forget() {
        currentId = null
        prefs().edit().remove(KEY_CURRENT).putBoolean(KEY_ASK, true).apply()
    }

    /** Another household: none of the saved profiles are its own. */
    fun forgetAll() {
        currentId = null
        prefs().edit().remove(KEY_CURRENT).remove(KEY_LIST).putBoolean(KEY_ASK, true).apply()
    }

    /** Adds this TV's key (X-Device-Key), the chosen profile (X-Profile) and an unlocked admin
     *  session (X-Admin-Session, see AdminPin) to requests to the
     *  server, and notices a profile, or a TV, the server no longer knows. */
    val header = Interceptor { chain ->
        val request = chain.request()
        val id = currentId
        val key = Server.key
        // (Only to the server itself: same scheme, host and port, never a look-alike address.)
        val server = Server.url.takeIf { it.isNotEmpty() }?.toHttpUrlOrNull()
        val toServer = server != null && server.scheme == request.url.scheme && server.host == request.url.host &&
            server.port == request.url.port
        val named = if (!toServer) request else request.newBuilder().apply {
            if (key != null) header("X-Device-Key", key)
            if (id != null) header("X-Profile", id)
            AdminPin.session?.let { header("X-Admin-Session", it) }
        }.build()
        val response = chain.proceed(named)
        if (toServer && response.header("X-Profile-Unknown") != null) forget()
        // Home sends it back to the Connect screen the next time it opens.
        if (toServer && response.header("X-Join-Again") != null) Server.forget()
        response
    }
}
