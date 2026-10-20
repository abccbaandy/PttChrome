package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MessageNotifierTest {
    @Test
    fun keepsNormalNotice() {
        assertEquals(
            MessageNotice("friend01 說", "晚上一起吃飯嗎", "friend01"),
            parseNotice("friend01 說", "晚上一起吃飯嗎", "friend01"),
        )
    }

    @Test
    fun emptyTitleIsDropped() {
        assertNull(parseNotice("", "body", "tag"))
        assertNull(parseNotice("  ", "body", "tag"))
    }

    @Test
    fun controlCharsBecomeSpacesAndLongTextIsCut() {
        val n = parseNotice("a\u001b[1mb", "x".repeat(1000), "")!!
        assertEquals("a [1mb", n.title)
        assertEquals(400, n.body.length)
        // 沒給 tag ＝用標題當 tag（同一人只留最新一則）。
        assertEquals(n.title, n.tag)
    }
}
