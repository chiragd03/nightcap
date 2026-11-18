package local.nightcap

import org.junit.Assert.assertEquals
import org.junit.Test

/** A libVLC track's language, read as the server reads a file's tracks (TrackLanguage). */
class TrackLanguageTest {

    @Test fun nameTrustedOverAnEnglishTag() = assertEquals("hi", TrackLanguage.of("Hindi 5.1 - [English]"))

    @Test fun nameTrustedWithNoTag() = assertEquals("hi", TrackLanguage.of("Hindi DD+ 5.1"))

    @Test fun nameTrustedOverAnUndeterminedTag() = assertEquals("ta", TrackLanguage.of("Tamil - [Undetermined]"))

    @Test fun anotherLanguageTagWinsOverTheName() = assertEquals("ta", TrackLanguage.of("Hindi - [Tamil]"))

    @Test fun englishTagWithNothingInTheName() = assertEquals("en", TrackLanguage.of("Track 1 - [English]"))

    @Test fun unknownTagIsNotTheName() = assertEquals(null, TrackLanguage.of("Hindi - [Malayalam]"))

    @Test fun ownNameAndThreeLetterCode() {
        assertEquals("hi", TrackLanguage.of("हिन्दी AAC"))
        assertEquals("ta", TrackLanguage.of("TAM 2.0"))
    }

    @Test fun twoLanguagesNamedIsNone() = assertEquals(null, TrackLanguage.of("Hindi + English"))

    @Test fun libvlcsPanjabiTag() = assertEquals("pa", TrackLanguage.of("Track 1 - [Panjabi]"))

    @Test fun titleHoldingABracketSplitsAtTheLast() = assertEquals("ta", TrackLanguage.of("Original - [Tamil] - [English]"))

    @Test fun dutchKnownByName() = assertEquals("Dutch", TrackLanguage.NAMES["nl"])
}
