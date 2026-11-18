package local.nightcap

import local.nightcap.PlayOrder.File
import org.junit.Assert.assertEquals
import org.junit.Test

/** Which file the player tries next (PlayOrder). Run: ./gradlew :app:testDebugUnitTest */
class PlayOrderTest {

    private fun order(files: List<File>, want: String? = null, quality: String? = null, original: String? = "hi",
                      now: Long = 0): List<String> {
        val tried = mutableSetOf<String>()
        val out = mutableListOf<String>()
        while (true) {
            val i = PlayOrder.next(files, tried, want, quality, original, now = now)
            if (i < 0) return out
            out += files[i].key
            tried += files[i].key
        }
    }

    @Test fun theAccountLineWhenTheOnlyFileLeftWasRefused() {
        val files = listOf(File("a", true, service = "service-b", skipped = true))
        assertEquals(PlayOrder.Ending.ACCOUNT, PlayOrder.ending(files, setOf("a")))
    }

    @Test fun theWantOnlyInDeadFilesGetsOneTry() {
        val files = listOf(File("en", true, languages = listOf("en")),
            File("hiNamed", true, languages = listOf("hi"), dead = true),
            File("hiHeard", true, languages = listOf("hi"), fromHeader = true, dead = true))
        assertEquals(2, PlayOrder.deadWant(files, emptySet(), "hi", "en"))
        // (Tried: the next dead one.)
        assertEquals(1, PlayOrder.deadWant(files, setOf("hiHeard"), "hi", "en"))
        // A living Hindi file left: not now.
        val living = files + File("hiOk", true, languages = listOf("hi"))
        assertEquals(-1, PlayOrder.deadWant(living, emptySet(), "hi", "en"))
        // Nothing in Hindi at all.
        assertEquals(-1, PlayOrder.deadWant(files.take(1), emptySet(), "hi", "en"))
    }

    @Test fun noPickKeepsTheServersOrder() {
        val files = listOf(File("a", true), File("b", true), File("c", false), File("d", true))
        assertEquals(listOf("a", "b", "d", "c"), order(files))
    }

    @Test fun neverSuspectNotDownloadedSkippedOrUnopenable() {
        val files = listOf(File("s", true, suspect = true), File("n", true, notDownloaded = true),
            File("k", true, skipped = true), File("o", true, openable = false), File("ok", true))
        assertEquals(listOf("ok"), order(files))
    }

    @Test fun aNotDownloadedFileIsTriedWhenAllowed() {
        val files = listOf(File("n", true, notDownloaded = true), File("ok", true))
        assertEquals(0, PlayOrder.next(files, emptySet(), allowed = setOf("n"), first = "n"))
    }

    @Test fun wantedLanguageFirstButNeverBeforeVerified() {
        val files = listOf(
            File("en4k", true, languages = listOf("en"), resolution = "4K"),
            File("hiUnverified", false, languages = listOf("hi")),
            File("hi720", true, languages = listOf("hi"), resolution = "720p"),
        )
        assertEquals(listOf("hi720", "en4k", "hiUnverified"), order(files, want = "hi"))
    }

    @Test fun wantedLanguageAndQualityTogetherFirst() {
        val files = listOf(
            File("hi720", true, languages = listOf("hi"), resolution = "720p"),
            File("en1080", true, languages = listOf("en"), resolution = "1080p"),
            File("hi1080", true, languages = listOf("hi"), resolution = "1080p"),
        )
        assertEquals(listOf("hi1080", "hi720", "en1080"), order(files, want = "hi", quality = "1080p"))
    }

    @Test fun headerConfirmedThenNamedThenNamesNone() {
        val files = listOf(
            File("none", true),
            File("named", true, languages = listOf("en")),
            File("header", true, languages = listOf("en", "hi"), fromHeader = true),
        )
        assertEquals(listOf("header", "named", "none"), order(files, want = "en", original = "hi"))
    }

    @Test fun aFileNamingNoLanguageIsEnglishOrTheTitlesOwn() {
        val none = File("none", true)
        assertEquals(true, PlayOrder.speaks(none, "en", "ko"))
        assertEquals(true, PlayOrder.speaks(none, "ko", "ko"))
        assertEquals(false, PlayOrder.speaks(none, "hi", "ko"))
    }

    @Test fun aQualityPickAlone() {
        val files = listOf(File("720", true, resolution = "720p"), File("4k", true, resolution = "4K"),
            File("u4k", false, resolution = "4K"))
        assertEquals(listOf("4k", "720", "u4k"), order(files, quality = "4K"))
    }

    @Test fun seenThenTrippedSinkOnlyWithinTheirGroup() {
        val files = listOf(
            File("hiTripped", true, languages = listOf("hi"), sunk = true),
            File("hiSeen", true, languages = listOf("hi"), seen = true),
            File("en", true, languages = listOf("en")),
            File("hi", true, languages = listOf("hi")),
        )
        assertEquals(listOf("hi", "hiSeen", "hiTripped", "en"), order(files, want = "hi"))
    }

    @Test fun preparingAndBusyWaitTheirTurnThenDeadLast() {
        val files = listOf(File("dead", true, dead = true), File("busy", true, busyUntil = 50),
            File("prep", true, preparingUntil = 20), File("ok", true))
        assertEquals(listOf("ok"), order(files, now = 10))
        assertEquals(listOf("ok", "prep", "busy", "dead"), order(files, now = 100))
        assertEquals(20L, PlayOrder.soonest(files, setOf("ok")))
    }

    @Test fun firstOverridesTheOrderAndTriedIsNeverAgain() {
        val files = listOf(File("a", true), File("b", true), File("c", true))
        assertEquals(2, PlayOrder.next(files, emptySet(), first = "c"))
        assertEquals(1, PlayOrder.next(files, setOf("a")))
        assertEquals(-1, PlayOrder.next(files, setOf("a", "b", "c")))
    }

    @Test fun deadOnlyWhenAllowed() {
        val files = listOf(File("dead", true, dead = true))
        assertEquals(-1, PlayOrder.next(files, emptySet(), withDead = false))
        assertEquals(0, PlayOrder.next(files, emptySet()))
    }

    @Test fun noOriginalLanguageMeansNamesNoneIsEnglishOnly() {
        assertEquals(true, PlayOrder.speaks(File("x", true), "en", null))
        assertEquals(false, PlayOrder.speaks(File("x", true), "hi", null))
    }

    @Test fun unverifiedWithWantBeforeUnverifiedRestWithAQualityPick() {
        val files = listOf(File("uEn", false, languages = listOf("en"), resolution = "4K"),
            File("uHi", false, languages = listOf("hi"), resolution = "720p"))
        assertEquals(listOf("uHi", "uEn"), order(files, want = "hi", quality = "4K"))
    }

    // ----- Services: what a refusal or a busy service holds back, and how a play ends -----

    private val aLink = File("aL", true, service = "service-a", kind = "debrid")
    private val aUsenet = File("aU", true, service = "service-a", kind = "usenet")
    private val bLink = File("bLink", true, service = "service-b", kind = "debrid")
    private val direct = File("direct", true)

    @Test fun aBadKeyOnOneServiceLeavesTheOther() {
        val files = PlayOrder.apply(listOf(aLink, aUsenet, bLink, direct), listOf(PlayOrder.Trip.BadKey("service-a")))
        assertEquals(listOf("bLink", "direct"), order(files))
    }

    @Test fun usenetNotInThePlanLeavesFollowedLinks() {
        val files = PlayOrder.apply(listOf(aUsenet, aLink), listOf(PlayOrder.Trip.NotInPlan("service-a", "usenet")))
        assertEquals(listOf("aL"), order(files))
    }

    @Test fun usenetNotInThePlanWithANotDownloadedFollowedLinkLeftStartsItNotTheAccountLine() {
        val waiting = File("aWait", true, service = "service-a", kind = "debrid", notDownloaded = true)
        val files = PlayOrder.apply(listOf(aUsenet, aLink, waiting), listOf(PlayOrder.Trip.NotInPlan("service-a", "usenet")))
        assertEquals(PlayOrder.Ending.PREPARE, PlayOrder.ending(files, setOf("aL")))
        val onlyUsenet = PlayOrder.apply(listOf(aUsenet), listOf(PlayOrder.Trip.NotInPlan("service-a", "usenet")))
        assertEquals(PlayOrder.Ending.ACCOUNT, PlayOrder.ending(onlyUsenet, emptySet()))
    }

    @Test fun oneServiceBusyDoesNotHoldBackAnotherOrDirectFiles() {
        val files = PlayOrder.apply(listOf(aLink, bLink, direct), listOf(PlayOrder.Trip.Busy("service-a", "debrid", 60_000)))
        assertEquals(listOf("bLink", "direct"), order(files, now = 1_000))
        assertEquals(PlayOrder.Ending.BUSY, PlayOrder.ending(files, setOf("bLink", "direct")))
    }

    @Test fun aUsenetBusyDoesNotHoldBackThatServicesFollowedLinks() {
        val files = PlayOrder.apply(listOf(aUsenet, aLink), listOf(PlayOrder.Trip.Busy("service-a", "usenet", 60_000)))
        assertEquals(listOf("aL"), order(files, now = 1_000))
    }

    @Test fun aSinkStaysWithinTheWantedLanguage() {
        val hiA = File("hiA", true, languages = listOf("hi"), service = "service-a", kind = "debrid")
        val enB = File("enB", true, languages = listOf("en"), service = "service-b", kind = "debrid")
        val files = PlayOrder.apply(listOf(hiA, enB), listOf(PlayOrder.Trip.Sink("service-a")))
        assertEquals(listOf("hiA", "enB"), order(files, want = "hi"))
    }

    @Test fun aFileWithNoServiceNeverTrips() {
        val files = PlayOrder.apply(listOf(direct), listOf(PlayOrder.Trip.BadKey("service-a"), PlayOrder.Trip.Busy("service-a", null, 9_999)))
        assertEquals(listOf("direct"), order(files))
    }

    @Test fun endingsInOrder() {
        assertEquals(PlayOrder.Ending.COULDNT_PLAY, PlayOrder.ending(listOf(File("a", true)), setOf("a")))
        assertEquals(PlayOrder.Ending.PREPARE, PlayOrder.ending(listOf(File("a", true), File("n", true, notDownloaded = true)), setOf("a")))
    }

    @Test fun waitForTheWantedLanguageOnlyOnceAndOnlyIfTimeIsLeft() {
        val busyHi = File("hi", true, languages = listOf("hi"), busyUntil = 60_000)
        val files = listOf(busyHi, File("en", true, languages = listOf("en")))
        // 60 s to wait, then up to 53 s for the try, and 45 s kept: fits a budget ending at 200 s, not at 150 s.
        assertEquals(60_000L, PlayOrder.waitBeforeLeaving(files, emptySet(), "hi", null, 0, 200_000, false))
        assertEquals(null, PlayOrder.waitBeforeLeaving(files, emptySet(), "hi", null, 0, 150_000, false))
        assertEquals(null, PlayOrder.waitBeforeLeaving(files, emptySet(), "hi", null, 0, 200_000, true))
    }

    @Test fun mainLeftCountsOnlyTheMainGroups() {
        val files = listOf(File("a", true), File("b", true, seen = true), File("c", true, busyUntil = 5),
            File("d", true, dead = true), File("e", true))
        assertEquals(2, PlayOrder.mainLeft(files, setOf()))
        assertEquals(1, PlayOrder.mainLeft(files, setOf("a")))
    }
}
