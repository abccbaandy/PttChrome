package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CredentialBridgeTest {
    @Test
    fun acceptsWebOAuthClientId() {
        // 與網頁端 src/js/firebase_config.js#GOOGLE_WEB_CLIENT_ID 同形狀。
        assertTrue(isGoogleWebClientId("220067863446-6m0i5g5dj8i961c2um3bihe9kndoslfl.apps.googleusercontent.com"))
    }

    @Test
    fun rejectsAnythingElse() {
        listOf(
            "",
            "abc",
            "220067863446-x.apps.googleusercontent.com.evil.example",
            "x220067863446-abc.apps.googleusercontent.com",
            "220067863446-ABC.apps.googleusercontent.com",
        ).forEach { assertFalse(it, isGoogleWebClientId(it)) }
    }
}
