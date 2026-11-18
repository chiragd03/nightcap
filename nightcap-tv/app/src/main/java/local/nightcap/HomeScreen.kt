package local.nightcap

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * Whether Nightcap offers itself as a Home screen app (the manifest's HomeScreen alias). On, Android
 * (on a TV that lets you pick one) or Button Mapper can make it the Home screen; off, it's an app
 * like any other. Settings → Home screen switches it.
 */
object HomeScreen {
    private fun alias(context: Context) = ComponentName(context, "local.nightcap.HomeScreen")

    fun isOn(context: Context): Boolean =
        context.packageManager.getComponentEnabledSetting(alias(context)) != PackageManager.COMPONENT_ENABLED_STATE_DISABLED

    fun set(context: Context, on: Boolean) = context.packageManager.setComponentEnabledSetting(alias(context),
        if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.DONT_KILL_APP)
}
