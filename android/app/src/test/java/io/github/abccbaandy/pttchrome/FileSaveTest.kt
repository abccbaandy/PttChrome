package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertEquals
import org.junit.Test

class FileSaveTest {
    @Test
    fun keepsNormalNames() {
        assertEquals("ptt-debug-20261008-120000.json", safeFileName("ptt-debug-20261008-120000.json"))
    }

    @Test
    fun stripsPathSeparatorsAndLeadingDots() {
        assertEquals("_.._etc_passwd", safeFileName("/../etc/passwd"))
        assertEquals("hidden", safeFileName("..hidden"))
        assertEquals("a_b", safeFileName("a\\b"))
    }

    @Test
    fun emptyFallsBackToDefault() {
        assertEquals("pttchrome.txt", safeFileName(""))
        assertEquals("pttchrome.txt", safeFileName("..."))
    }

    @Test
    fun longNamesKeepTheExtension() {
        val out = safeFileName("x".repeat(300) + ".json")
        assertEquals(120, out.length)
        assertEquals(true, out.endsWith(".json"))
    }
}
