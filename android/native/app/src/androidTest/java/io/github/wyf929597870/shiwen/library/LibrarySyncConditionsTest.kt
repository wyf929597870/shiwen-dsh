package io.github.wyf929597870.shiwen.library

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LibrarySyncConditionsTest {
    @Test fun conditionParserAcceptsAdditionalValidFieldsAndRejectsMalformedWifiOnly() {
        assertEquals(false, LibrarySyncWorkPolicy.wifiOnlySetting("{}"))
        assertEquals(true, LibrarySyncWorkPolicy.wifiOnlySetting("{\"wifiOnly\":true,\"futureOption\":{\"value\":1}}"))
        assertEquals(false, LibrarySyncWorkPolicy.wifiOnlySetting("{\"futureOption\":true,\"wifiOnly\":false}"))
        assertEquals(null, LibrarySyncWorkPolicy.wifiOnlySetting("{"))
        assertEquals(null, LibrarySyncWorkPolicy.wifiOnlySetting("{\"wifiOnly\":\"true\"}"))
        assertEquals(null, LibrarySyncWorkPolicy.wifiOnlySetting("{\"wifiOnly\":null}"))
    }
}
