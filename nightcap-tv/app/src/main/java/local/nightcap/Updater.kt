package local.nightcap

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * The app's own updates: Home asks the server (GET /launcher/app.json, see the server's appupdate.py)
 * once a day; a newer version is offered ("Update available · Install / Later"), downloaded from the
 * server (/launcher/app.apk) into Android's installer, which asks to confirm (and, the first time, to
 * let Nightcap install apps). Later, a download that failed, or a confirm backed out of: offered again
 * at the next day's check. Only a version Android refused to install isn't offered again (a newer one
 * is): never a download of the same broken file day after day.
 */
object Updater {
    private const val TAG = "Nightcap"
    private const val PREFS = "updates"
    private const val KEY_CHECKED = "checkedAt"
    private const val KEY_SKIP = "skipVersion"
    private const val EXTRA_VERSION = "versionCode"
    private const val DAY_MS = 24 * 60 * 60 * 1000L
    /** A check that couldn't reach the server: asked again after this, not on every Home. */
    private const val RETRY_MS = 60 * 60 * 1000L

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var busy = false
    /** Android's confirm, waiting for Home to be in front (never over a film). */
    private var confirm: Intent? = null

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** This app's processor kind, as its releases are named: the one its native libraries are for. */
    private fun abi(c: Context) = if (File(c.applicationInfo.nativeLibraryDir).name == "arm64") "arm64-v8a" else "armeabi-v7a"

    /** Home came to the front: a confirm waiting is shown; else asks for a newer version, once a day
     *  (and straight away after a first install, which has never asked). */
    fun check(home: Activity) {
        confirm?.let { confirm = null; return home.startActivity(it) }
        val p = prefs(home)
        val now = System.currentTimeMillis()
        if (busy || !Server.ready || now - p.getLong(KEY_CHECKED, 0) < DAY_MS) return
        busy = true
        val abi = abi(home)
        io.execute {
            val offer = runCatching {
                Feed.http.newCall(Request.Builder().url("${Server.url}/launcher/app.json?abi=$abi").build()).execute()
                    .use { r -> check(r.isSuccessful) { "Server answered ${r.code}" }; JSONObject(r.body!!.string()) }
            }.onFailure { Log.w(TAG, "Update check failed", it) }.getOrNull()
            main.post {
                busy = false
                if (offer == null) return@post p.edit().putLong(KEY_CHECKED, now - DAY_MS + RETRY_MS).apply()
                val code = offer.optInt("versionCode")
                if (code <= BuildConfig.VERSION_CODE || code == p.getInt(KEY_SKIP, 0)) {
                    p.edit().putLong(KEY_CHECKED, now).apply()
                    return@post
                }
                // (Home not in front any more, or a menu open: asked again next time Home is.)
                if (home.isFinishing || NightcapApp.resumed !== home || Sheet.open) return@post
                p.edit().putLong(KEY_CHECKED, now).apply()
                offer(home, code, offer.optString("versionName"), abi)
            }
        }
    }

    private fun offer(activity: Activity, code: Int, name: String, abi: String) {
        Sheet.show(activity, activity.currentFocus, "Update available", "Nightcap $name", listOf(
            Sheet.Action(R.drawable.ic_pl_play, "Install") { install(activity, code, abi) },
            // (Asked again at tomorrow's check.)
            Sheet.Action(R.drawable.ic_act_later, "Later") {},
        ))
    }

    /** The APK, from the server straight into Android's installer, which then asks to confirm. */
    private fun install(activity: Activity, code: Int, abi: String) {
        if (busy) return
        busy = true
        val app = activity.applicationContext
        Notice.show(activity, "Downloading the update…")
        io.execute {
            val installer = app.packageManager.packageInstaller
            val session = runCatching { installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)) }
                .getOrNull()
            val ok = session != null && runCatching {
                installer.openSession(session).use { s ->
                    Feed.slow.newCall(Request.Builder().url("${Server.url}/launcher/app.apk?abi=$abi").build()).execute().use { r ->
                        check(r.isSuccessful) { "Server answered ${r.code}" }
                        val body = r.body!!
                        s.openWrite("nightcap.apk", 0, body.contentLength()).use { out ->
                            body.byteStream().copyTo(out)
                            s.fsync(out)
                        }
                    }
                    // (Named by class: the receiver has no intent filter. Mutable: the installer adds its answer.)
                    val done = PendingIntent.getBroadcast(app, session, Intent(app, Result::class.java).putExtra(EXTRA_VERSION, code),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                    s.commit(done.intentSender)
                }
            }.onFailure { Log.w(TAG, "Update download failed", it) }.isSuccess
            if (!ok) session?.let { id -> runCatching { installer.abandonSession(id) } }
            main.post {
                busy = false
                if (!ok) NightcapApp.resumed?.let { Notice.show(it, "Couldn't download the update. It'll be offered again tomorrow.") }
            }
        }
    }

    /** Android's installer answering: it needs the viewer's OK (shown over Home), was backed out of
     *  (offered again tomorrow), or refused the file (not offered again). On success the old app
     *  stops and [Replaced] brings the new one up. */
    class Result : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION")
                    val ask = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return
                    val front = NightcapApp.resumed
                    if (front is HomeActivity) front.startActivity(ask) else confirm = ask
                }
                PackageInstaller.STATUS_SUCCESS -> Unit
                // (Backed out of, or the TV is full: offered again tomorrow.)
                PackageInstaller.STATUS_FAILURE_ABORTED, PackageInstaller.STATUS_FAILURE_STORAGE -> Unit
                else -> {
                    Log.w(TAG, "Update not installed ($status)")
                    prefs(context).edit().putInt(KEY_SKIP, intent.getIntExtra(EXTRA_VERSION, 0)).apply()
                    NightcapApp.resumed?.let { Notice.show(it, "Couldn't install the update") } ?: Notice.later("Couldn't install the update")
                }
            }
        }
    }

    /** The app was just updated: its background service again, and Nightcap back on screen (as at
     *  boot: on Google TV it isn't the system's home screen, so nothing else would bring it back). */
    class Replaced : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
            WakeService.start(context)
            if (!HomeScreen.isOn(context)) return
            // (Straight onto Who's watching when there's a choice to make, so Home doesn't flash first.)
            val first = if (Profiles.shouldAsk()) ProfilesActivity::class.java else HomeActivity::class.java
            context.startActivity(Intent(context, first).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
