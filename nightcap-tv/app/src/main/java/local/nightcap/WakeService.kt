package local.nightcap

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper

/**
 * After a long standby Google TV opens its own home screen when the TV wakes. This small service
 * notices the screen coming on and, if Google TV's home is what's showing, brings up Nightcap.
 * Anything else (an HDMI input, Live TV, an app) is left alone. Waking up also means asking
 * who's watching (when there's more than one profile).
 */
class WakeService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val screenOn = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handler.removeCallbacksAndMessages(null)
            if (intent.action == Intent.ACTION_SCREEN_OFF) return goingToSleep()
            // Give Google TV a moment to finish putting its home screen up first.
            handler.postDelayed(::takeOverFromGoogleHome, SETTLE_MS)
        }
    }

    /** The next wake asks who's watching. With Nightcap in front, Who's watching goes up now,
     *  while the screen is dark, so the TV wakes straight onto it instead of flashing Home. */
    private fun goingToSleep() {
        val ours = frontApp() == packageName
        // Fell asleep mid-film: carry on as the same person.
        if (ours && NightcapApp.front in setOf(WatchActivity::class.java, PlayerActivity::class.java)) return
        Profiles.askNextTime()
        if (ours && NightcapApp.front != ProfilesActivity::class.java && Profiles.shouldAsk()) openProfiles()
    }

    private fun openProfiles() =
        // No opening animation: it would play as the screen comes on, showing what's underneath first.
        startActivity(ProfilesActivity.intent(this).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Nightcap on wake", NotificationManager.IMPORTANCE_MIN))
        foreground()
        registerReceiver(screenOn, IntentFilter(Intent.ACTION_SCREEN_ON).apply { addAction(Intent.ACTION_SCREEN_OFF) })
        // Play on TV's check every 10 seconds, while the screen is on (see Inbox).
        Inbox.start(this)
    }

    // Every start asks for it again (Home starts this each time it opens): Android stops the app if a
    // start isn't answered in time, even with the service already running.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foreground()
        return START_STICKY
    }

    private fun foreground() = startForeground(1, Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_nav_home)
        .setContentTitle("Nightcap").setContentText("Opens Nightcap when the TV wakes").build())

    override fun onDestroy() {
        Inbox.stop()
        unregisterReceiver(screenOn)
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?) = null

    private fun takeOverFromGoogleHome() {
        when (frontApp()) {
            // (Only while Nightcap is the TV's Home screen: Settings → Home screen.)
            GOOGLE_HOME -> if (!HomeScreen.isOn(this)) return
                else if (Profiles.shouldAsk()) openProfiles()
                else startActivity(Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            // Normally already up (see goingToSleep); this catches a sleep it missed.
            packageName -> if (NightcapApp.front != ProfilesActivity::class.java && Profiles.shouldAsk()) openProfiles()
            // Another app or input is on: Nightcap asks the next time it opens.
        }
    }

    /** The app that most recently came to the front, from Android's usage records. */
    private fun frontApp(): String? {
        val usage = getSystemService(UsageStatsManager::class.java)
        val now = System.currentTimeMillis()
        val events = usage.queryEvents(now - 60_000, now)
        val e = UsageEvents.Event()
        var last: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) last = e.packageName
        }
        return last
    }

    companion object {
        private const val CHANNEL = "wake"
        private const val SETTLE_MS = 1_500L
        private const val GOOGLE_HOME = "com.google.android.apps.tv.launcherx"

        fun start(context: Context) = runCatching {
            context.startForegroundService(Intent(context, WakeService::class.java))
        }
    }
}
