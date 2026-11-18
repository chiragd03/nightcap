package local.nightcap

import android.app.Activity
import android.app.Application
import android.os.Bundle
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache

class NightcapApp : Application(), ImageLoaderFactory {
    override fun onCreate() {
        super.onCreate()
        Server.init(this)
        Profiles.init(this)
        // Just restarted after the player crashed: reopen it over the screen Android brings back.
        var rescue = PlayerRescue.pending(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                front = activity.javaClass
                resumedRef = java.lang.ref.WeakReference(activity)
                rescue?.let { if (activity !is WatchActivity) activity.startActivity(it) }
                rescue = null
                // A note left for later ("Couldn't play this link"): on whichever screen comes up next
                // (not over a player).
                if (activity !is WatchActivity && activity !is PlayerActivity && activity !is LivePlayerActivity)
                    Notice.showPending(activity)
                Inbox.resumed(activity)
            }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) { visible++ }
            override fun onActivityPaused(activity: Activity) {
                if (resumedRef?.get() === activity) resumedRef = null
            }
            override fun onActivityStopped(activity: Activity) { visible-- }
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }

    companion object {
        /** The Nightcap screen last in front (it stays set while the TV sleeps). */
        @Volatile var front: Class<*>? = null

        private var resumedRef: java.lang.ref.WeakReference<Activity>? = null

        /** Nightcap screens on screen (started), in front or under a TV panel (its settings, voice search). */
        @Volatile var visible = 0

        /** The Nightcap screen in front right now, if Nightcap is. */
        val resumed: Activity? get() = resumedRef?.get()
    }

    // Posters are cached on disk so a cold start draws the last screen without the network.
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .okHttpClient(Feed.http)
        .crossfade(false)
        .allowRgb565(true)
        .respectCacheHeaders(false)
        .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.2).build() }
        .diskCache { DiskCache.Builder().directory(cacheDir.resolve("images")).maxSizeBytes(200L * 1024 * 1024).build() }
        .build()
}
