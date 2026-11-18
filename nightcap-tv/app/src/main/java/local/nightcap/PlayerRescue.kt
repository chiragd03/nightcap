package local.nightcap

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import java.io.File
import java.util.UUID

/**
 * Brings the player back after libVLC takes the app down with it (a rare crash inside its
 * network code). While a video plays, the player keeps a note of what it's playing; a clean exit
 * removes it. If Nightcap starts again within moments, the note is still there, and Android says
 * the app last ended in a crash (not an install, a force stop, or the TV closing it to free
 * memory), the player reopens without the file that crashed it (or on the same one, if the video
 * had started), with the viewer's picks.
 */
object PlayerRescue {
    /** How fresh the note must be: the player touches it at least every 30 seconds. */
    private const val FRESH_MS = 90_000L
    /** Two rescues in a row and the source list is clearly the problem: stop trying. */
    private const val MAX_RESCUES = 2

    private fun file(context: Context) = File(context.filesDir, "playing.txt")

    fun newToken(): String = UUID.randomUUID().toString()

    /** What to reopen: [again], the player's intent with what it had tried and the rescue's number
     *  (WatchActivity.noteRescue). Only plain extras survive (Intent.toUri). */
    fun note(context: Context, token: String, again: Intent) = runCatching {
        file(context).writeText(token + "\n" + again.toUri(Intent.URI_INTENT_SCHEME))
    }

    fun stillPlaying(context: Context) = runCatching { file(context).setLastModified(System.currentTimeMillis()) }

    /** A clean exit: forgets the note, unless a newer player (the next episode) has written its own. */
    fun clear(context: Context, token: String) = runCatching {
        val f = file(context)
        if (f.exists() && f.readText().substringBefore("\n") == token) f.delete()
    }

    /** The player to reopen, if the last one crashed just now; the note is used up either way. */
    fun pending(context: Context): Intent? = runCatching {
        val f = file(context)
        if (!f.exists()) return null
        val fresh = System.currentTimeMillis() - f.lastModified() < FRESH_MS
        val uri = f.readText().substringAfter("\n")
        f.delete()
        if (!fresh || !crashedJustNow(context)) return null
        Intent.parseUri(uri, Intent.URI_INTENT_SCHEME).takeIf { it.getIntExtra(WatchActivity.EXTRA_RESCUES, 0) <= MAX_RESCUES }
            ?.setClass(context, WatchActivity::class.java)
    }.getOrNull()

    /** Whether the app's last exit (within the note's freshness) was a crash, Java or native (libVLC). */
    private fun crashedJustNow(context: Context): Boolean {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) return false
        val last = context.getSystemService(ActivityManager::class.java)
            .getHistoricalProcessExitReasons(context.packageName, 0, 1).firstOrNull() ?: return false
        val crash = last.reason == ApplicationExitInfo.REASON_CRASH || last.reason == ApplicationExitInfo.REASON_CRASH_NATIVE
        return crash && System.currentTimeMillis() - last.timestamp < FRESH_MS
    }
}
