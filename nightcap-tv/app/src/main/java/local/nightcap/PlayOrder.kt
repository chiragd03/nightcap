package local.nightcap

/**
 * Which file the player tries next, and how a play ends when nothing is left: one rule for the
 * start, after a failure, a pick's candidates and the next episode (WatchActivity). Plain Kotlin,
 * tested on its own (PlayOrderTest).
 *
 * Main groups, in order:
 * - with a picked language (the *want*): verified + want + quality → verified + want → verified rest →
 *   unverified + want → unverified rest; inside each "+ want" group the want confirmed by the file's own
 *   header first, then named by its file name, then files naming no language;
 * - with no want but a picked quality: verified + quality → verified → unverified + quality → unverified;
 * - neither: the server's order (it ranks by the profile's language and quality).
 * Within each main group, after its other files: files with a recent sighting, then files of a tripped
 * add-on and service. After every main group: files being prepared, busy files (each once its time has
 * come), then dead ones. Within a group, the server's order.
 * Never: a file that seems to be another one's (suspect), one the service hasn't downloaded yet
 * (opening it starts a download; unless [next]'s `allowed`), one tried this play, one with nothing to
 * open, or one of a service (and type) whose key or plan refused it.
 */
object PlayOrder {

    data class File(
        /** Stays the same for the same file through the play. */
        val key: String,
        val verified: Boolean,
        /** Seems to be another episode's or title's file (otherEpisode, otherLength). */
        val suspect: Boolean = false,
        /** Not downloaded yet by the service it goes through (`cached: false`). */
        val notDownloaded: Boolean = false,
        /** Has an address or a YouTube id. */
        val openable: Boolean = true,
        /** Its audio languages (two-letter codes). */
        val languages: List<String> = emptyList(),
        /** Whether [languages] came from the file's own header (else from its name). */
        val fromHeader: Boolean = false,
        /** "4K", "1080p", "720p", "480p" or "". */
        val resolution: String = "",
        /** The service it goes through (its id), or null (a direct file, a plugin's). */
        val service: String? = null,
        /** The stream finder's type for it: "usenet" or "debrid" (a followed link), or null. */
        val kind: String? = null,
        /** A recent sighting (the server's `seen`): last within its group. */
        val seen: Boolean = false,
        /** Its add-on and service were tripped (a 403, a store limit): last within its group. */
        val sunk: Boolean = false,
        /** Its service (and type) refused it (a bad key; the plan lacks it): never tried by itself. */
        val skipped: Boolean = false,
        /** Being prepared: not before this time (ms). */
        val preparingUntil: Long? = null,
        /** Busy: not before this time (ms). */
        val busyUntil: Long? = null,
        /** Recorded dead by the server: tried only when nothing else is left. */
        val dead: Boolean = false,
    )

    /** What a service told the player this play. [kind]: only files of that type (null: all of the service's). */
    sealed class Trip(open val service: String, open val kind: String?) {
        /** A bad key (`401`): that service's files are skipped. */
        data class BadKey(override val service: String) : Trip(service, null)
        /** The plan lacks it (`payment_required`): that service's files of that type are skipped. */
        data class NotInPlan(override val service: String, override val kind: String) : Trip(service, kind)
        /** A `403` or a store limit twice: that service's files sink within their groups. */
        data class Sink(override val service: String) : Trip(service, null)
        /** Busy (`429` and the like): that service's files of that type wait until [until]. */
        data class Busy(override val service: String, override val kind: String?, val until: Long) : Trip(service, kind)
    }

    /** [files] with what [trips] say marked on them. A file with no service never trips, sinks or goes busy. */
    fun apply(files: List<File>, trips: List<Trip>): List<File> = files.map { f ->
        val s = f.service ?: return@map f
        var out = f
        for (t in trips) {
            if (t.service != s || (t.kind != null && t.kind != f.kind)) continue
            out = when (t) {
                is Trip.BadKey, is Trip.NotInPlan -> out.copy(skipped = true)
                is Trip.Sink -> out.copy(sunk = true)
                is Trip.Busy -> out.copy(busyUntil = maxOf(out.busyUntil ?: 0, t.until))
            }
        }
        out
    }

    /**
     * How well [file] has [language]: 0 its header says so, 1 its name says so, 2 it names no language
     * and [language] is English or the title's own ([original]), 3 not. One rule with the server's.
     */
    fun level(file: File, language: String, original: String?): Int = when {
        language in file.languages -> if (file.fromHeader) 0 else 1
        file.languages.isEmpty() && (language == "en" || language == original) -> 2
        else -> 3
    }

    fun speaks(file: File, language: String?, original: String?) =
        language == null || level(file, language, original) < 3

    /** Whether [file] may be tried at all this play. */
    fun usable(file: File, tried: Set<String>, allowed: Set<String> = emptySet()) =
        file.openable && !file.suspect && !file.skipped && file.key !in tried &&
            (!file.notDownloaded || file.key in allowed)

    /**
     * The index in [files] (the server's order) of the next file to try now, or -1. [want]: a picked
     * language (null: none); [quality]: a picked quality (null: Auto); [original]: the title's own
     * language; [first]: a key tried before anything else when usable; [now]: the time (ms), for files
     * being prepared or busy; [withDead]: whether dead files may be tried (only when nothing else is).
     */
    fun next(
        files: List<File>, tried: Set<String>, want: String? = null, quality: String? = null,
        original: String? = null, allowed: Set<String> = emptySet(), first: String? = null,
        now: Long = 0, withDead: Boolean = true,
    ): Int {
        val left = files.indices.filter { usable(files[it], tried, allowed) }
        first?.let { k -> left.firstOrNull { files[it].key == k }?.let { return it } }
        val main = left.filter { !files[it].dead && files[it].preparingUntil == null && files[it].busyUntil == null }
        main.minWithOrNull(compareBy({ group(files[it], want, quality, original) }, { within(files[it]) },
            { wantLevel(files[it], want, original) }, { it }))?.let { return it }
        left.firstOrNull { files[it].preparingUntil?.let { t -> t <= now } == true }?.let { return it }
        left.firstOrNull { files[it].busyUntil?.let { t -> t <= now } == true }?.let { return it }
        // (Files still waiting their time come before a dead one: the caller waits for them, see soonest.)
        if (left.any { files[it].preparingUntil != null || files[it].busyUntil != null }) return -1
        return if (withDead) left.firstOrNull { files[it].dead } ?: -1 else -1
    }

    /** When the soonest file now waiting (being prepared, or busy) may be tried, or null if none is. */
    fun soonest(files: List<File>, tried: Set<String>, allowed: Set<String> = emptySet()): Long? =
        files.filter { usable(it, tried, allowed) }.mapNotNull { it.preparingUntil ?: it.busyUntil }.minOrNull()

    /** How many files are left in the main groups (for asking for more sources when few are). */
    fun mainLeft(files: List<File>, tried: Set<String>): Int = files.count {
        usable(it, tried) && !it.dead && !it.seen && !it.sunk && it.preparingUntil == null && it.busyUntil == null
    }

    /**
     * Before the walk leaves the wanted language for another: how long to wait (ms) for a busy or
     * preparing file in it, or null not to wait. Once per play ([waitedAlready]); only when, once the
     * waited try is over (~[TRY_MS]), at least [KEEP_MS] of the budget would still be left.
     */
    fun waitBeforeLeaving(files: List<File>, tried: Set<String>, want: String, original: String?, now: Long,
                          budgetEnd: Long, waitedAlready: Boolean): Long? {
        if (waitedAlready) return null
        val due = files.filter { usable(it, tried) && speaks(it, want, original) && !it.dead }
            .mapNotNull { it.preparingUntil ?: it.busyUntil }.minOrNull() ?: return null
        val at = maxOf(due, now)
        return if (at + TRY_MS + KEEP_MS <= budgetEnd) at - now else null
    }

    /**
     * Before the walk leaves the wanted language for another: the best dead file that has it (header-
     * confirmed first, then named, then names none; verified first), to be tried once, when no other
     * file in it is left to try or wait for; or -1.
     */
    fun deadWant(files: List<File>, tried: Set<String>, want: String, original: String?): Int {
        val left = files.indices.filter { usable(files[it], tried) && speaks(files[it], want, original) }
        if (left.any { !files[it].dead }) return -1
        return left.minWithOrNull(compareBy({ if (files[it].verified) 0 else 1 }, { level(files[it], want, original) }, { it })) ?: -1
    }

    /** The longest one waited-for try takes (its address asked, checked, started). */
    const val TRY_MS = 53_000L
    /** Budget kept for the other language after a wait for the wanted one. */
    const val KEEP_MS = 45_000L

    /** How a play ends when nothing is left to try. */
    enum class Ending { ACCOUNT, BUSY, PREPARE, COULDNT_PLAY }

    /**
     * Which line ends the play: the account line only when every file still untried was skipped by a
     * refusal's own scope (and none of them could be started instead); the busy line when busy files
     * were left; starting a not-downloaded file (§7) when one is left outside a refusal's scope;
     * otherwise "Couldn't play".
     */
    fun ending(files: List<File>, tried: Set<String>): Ending {
        // (A refused file counts as left, tried or not: the account is why it's over.)
        val untried = files.filter { it.openable && !it.suspect && (it.key !in tried || it.skipped) }
        val startable = untried.filter { it.notDownloaded && !it.skipped }
        return when {
            untried.isNotEmpty() && untried.all { it.skipped } -> Ending.ACCOUNT
            untried.any { it.busyUntil != null && !it.skipped } -> Ending.BUSY
            startable.isNotEmpty() -> Ending.PREPARE
            else -> Ending.COULDNT_PLAY
        }
    }

    /** The main group a file is tried in, lowest first. */
    fun group(file: File, want: String?, quality: String?, original: String?): Int {
        val unverified = if (file.verified) 0 else 3
        val speaks = want == null || speaks(file, want, original)
        val sharp = quality == null || file.resolution == quality
        return unverified + when {
            speaks && sharp -> 0
            speaks -> 1
            else -> 2
        }
    }

    /** Within a main group: others, then recently seen, then a tripped add-on's. */
    private fun within(file: File) = when {
        file.sunk -> 2
        file.seen -> 1
        else -> 0
    }

    /** Inside a "+ want" group: header-confirmed, named, names none. */
    private fun wantLevel(file: File, want: String?, original: String?) =
        if (want == null) 0 else level(file, want, original).coerceAtMost(2)
}
