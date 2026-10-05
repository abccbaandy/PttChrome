package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** dev server 位址的白名單：正式版只收本機，debug 才收私有 IPv4；bridge 與 proxy 都依它的 origin 放行。 */
class PageSourceTest {
    private fun dev(input: String, allowLan: Boolean = false) = PageSource.parseDevServer(input, allowLan)

    @Test fun loopbackHostsNormalizeToRoot() {
        assertEquals(PageSource("http://localhost:8080/", "http://localhost:8080", true), dev("http://localhost:8080/"))
        assertEquals("http://127.0.0.1:5173", dev("http://127.0.0.1:5173")?.origin)
        assertEquals("http://localhost:8080/", dev("  LOCALHOST:8080/some/path?x=1#y ")?.url)
    }

    @Test fun defaultsSchemeAndPort() {
        assertEquals("http://localhost:8080", dev("localhost")?.origin)
        assertEquals("http://localhost:8080", dev("http://localhost")?.origin)
        assertEquals("http://localhost", dev("http://localhost:80")?.origin)
    }

    @Test fun rejectsNonHttp() {
        assertNull(dev("https://localhost:8080/"))
        assertNull(dev("ws://localhost:8080/"))
        assertNull(dev("file:///sdcard/index.html"))
        assertNull(dev(""))
    }

    @Test fun rejectsTricksThatPointElsewhere() {
        assertNull(dev("http://localhost@evil.example/"))
        assertNull(dev("http://user:pw@localhost:8080/"))
        assertNull(dev("http://localhost.evil.example:8080/"))
        assertNull(dev("http://127.0.0.1.nip.io:8080/"))
        assertNull(dev("http://localhost:99999/"))
    }

    @Test fun lanOnlyWhenAllowed() {
        for (ip in listOf("192.168.1.5", "10.0.0.2", "172.16.0.1", "172.31.255.254")) {
            assertNull(ip, dev("http://$ip:8080/"))
            assertEquals("http://$ip:8080", dev("http://$ip:8080/", allowLan = true)?.origin)
        }
    }

    @Test fun publicAddressesNeverAllowed() {
        for (host in listOf("8.8.8.8", "172.32.0.1", "192.169.0.1", "256.168.1.1", "example.com", "abccbaandy.github.io")) {
            assertNull(host, dev("http://$host:8080/", allowLan = true))
        }
    }

    @Test fun resolveFallsBackToProduction() {
        assertEquals(PageSource.PRODUCTION, PageSource.resolve(false, "http://localhost:8080/", allowLan = false))
        assertEquals(PageSource.PRODUCTION, PageSource.resolve(true, "https://evil.example/", allowLan = true))
        assertEquals(PageSource.PRODUCTION, PageSource.resolve(true, "http://192.168.1.5:8080/", allowLan = false))
        assertEquals("http://localhost:8080/", PageSource.resolve(true, "http://localhost:8080/", allowLan = false).url)
    }
}
