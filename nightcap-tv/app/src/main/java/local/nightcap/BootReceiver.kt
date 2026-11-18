package local.nightcap

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Opens Nightcap when the TV starts up. Google TV insists on being the system home screen, so
 * this (and Button Mapper for the Home button) is how the TV lands on Nightcap instead.
 * Starting an activity from here needs the "display over other apps" permission.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        WakeService.start(context)
        Profiles.askNextTime()
        // Nightcap as an app like any other (Settings → Home screen): the TV starts on its own home.
        if (!HomeScreen.isOn(context)) return
        // Straight onto Who's watching when there's a choice to make, so Home doesn't flash first.
        val first = if (Profiles.shouldAsk()) ProfilesActivity::class.java else HomeActivity::class.java
        context.startActivity(Intent(context, first).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
