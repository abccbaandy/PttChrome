package io.github.abccbaandy.pttchrome

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress

/** bridge 'fetchOg'（P110 APK 版）：網址／位址邊界、解析（跟 Worker og.js 同規則）、轉址與讀取上限。 */
class OgFetchTest {
    private val server = MockWebServer()

    @Before fun setUp() = server.start()

    @After fun tearDown() = server.close()

    private fun html(body: String, type: String = "text/html; charset=utf-8") =
        MockResponse.Builder().code(200).addHeader("Content-Type", type).body(body).build()

    private fun fetch(path: String) = OgFetch.fetch(server.url(path).toString(), strict = false)

    @Test
    fun acceptsOnlyPublicHttpsNames() {
        assertTrue(OgFetch.acceptsUrl("https://www.example.com/a?id=1"))
        listOf(
            "http://www.example.com/",
            "https://example.com:8443/",
            "https://user:pw@example.com/",
            "https://192.168.1.1/",
            "https://[::1]/",
            "https://0x7f000001/",
            "https://2130706433/",
            "https://localhost/",
            "https://router/",
            "https://nas.local/",
            "https://printer.home.arpa/",
            "file:///sdcard/a.html",
            "not a url",
            "",
        ).forEach { assertFalse(it, OgFetch.acceptsUrl(it)) }
    }

    @Test
    fun rejectsPrivateAddresses() {
        listOf("127.0.0.1", "10.0.0.8", "172.16.3.4", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1")
            .forEach { assertFalse(it, OgFetch.isPublicAddress(InetAddress.getByName(it))) }
        listOf("8.8.8.8", "1.1.1.1", "100.128.0.1", "2001:4860:4860::8888")
            .forEach { assertTrue(it, OgFetch.isPublicAddress(InetAddress.getByName(it))) }
    }

    @Test
    fun strictModeRefusesNamesThatResolveToPrivateAddresses() {
        var opened = false
        val r = OgFetch.fetch(
            "https://router.example.com/",
            resolve = { arrayOf(InetAddress.getByName("8.8.8.8"), InetAddress.getByName("192.168.1.1")) },
            open = { opened = true; throw AssertionError("不該連線") },
        )
        assertEquals(OgFetch.Result.Failed("address"), r)
        assertFalse(opened)
    }

    @Test
    fun parsesOgFirstThenTwitterThenTitle() {
        val r = OgFetch.parseMeta(
            """<head><meta property="og:title" content="標題 &amp; 副標"><meta name="twitter:title" content="不是這個">
               <meta property='og:site_name' content='新聞網'><meta property="og:image" content="/img/a.jpg"></head>""",
            "https://news.example.com/a/1",
        )!!
        assertEquals("標題 & 副標", r.title)
        assertEquals("新聞網", r.site)
        assertEquals("https://news.example.com/img/a.jpg", r.image)
        val t = OgFetch.parseMeta("<title>只有 title</title>", "https://www.example.com/")!!
        assertEquals("只有 title", t.title)
        assertEquals("example.com", t.site)
        assertEquals("", t.image)
        assertNull(OgFetch.parseMeta("<p>沒有標題</p>", "https://example.com/"))
    }

    @Test
    fun dropsHttpImagesAndTruncatesByCodePoint() {
        val long = "😀".repeat(300)
        val r = OgFetch.parseMeta("""<meta property="og:title" content="$long"><meta property="og:image" content="http://x.com/a.jpg">""", "https://a.com/")!!
        assertEquals(OgFetch.MAX_TITLE, r.title.codePointCount(0, r.title.length))
        assertTrue(r.title.endsWith("…"))
        assertEquals("", r.image)
    }

    @Test
    fun unclosedMetaFloodStaysFast() {
        val evil = "<meta ".repeat(50_000)
        val start = System.nanoTime()
        assertNull(OgFetch.parseMeta(evil, "https://a.com/"))
        assertTrue((System.nanoTime() - start) / 1_000_000 < 2_000)
    }

    @Test
    fun decodesBig5FromMetaCharset() {
        val page = "<meta charset=\"big5\"><title>中文標題</title>".toByteArray(charset("Big5"))
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/html").body(Buffer().write(page)).build())
        val r = fetch("/big5") as OgFetch.Result.Ok
        assertEquals("中文標題", r.title)
    }

    @Test
    fun followsRedirectsUpToLimit() {
        server.enqueue(MockResponse.Builder().code(301).addHeader("Location", "/b").build())
        server.enqueue(html("<title>到了</title>"))
        assertEquals("到了", (fetch("/a") as OgFetch.Result.Ok).title)
        repeat(OgFetch.MAX_REDIRECTS + 1) { server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/loop").build()) }
        assertEquals(OgFetch.Result.Failed("url"), fetch("/loop"))
    }

    @Test
    fun nonHtmlIsNoneAndErrorsAreFailed() {
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "image/png").body("x").build())
        assertEquals(OgFetch.Result.None, fetch("/png"))
        server.enqueue(MockResponse.Builder().code(404).build())
        assertEquals(OgFetch.Result.Failed("http"), fetch("/404"))
    }

    @Test
    fun readsOnlyTheHead() {
        val body = "<title>前面</title>" + "x".repeat(OgFetch.MAX_HTML_BYTES * 2)
        server.enqueue(html(body))
        assertEquals("前面", (fetch("/big") as OgFetch.Result.Ok).title)
    }

    @Test
    fun embeddedAndReservedV4AreNotPublic() {
        listOf("64:ff9b::c0a8:101", "64:ff9b::a00:1", "2002:c0a8:101::1", "198.18.0.1", "240.0.0.1")
            .forEach { assertFalse(it, OgFetch.isPublicAddress(InetAddress.getByName(it))) }
        assertTrue(OgFetch.isPublicAddress(InetAddress.getByName("64:ff9b::808:808")))
    }

    @Test
    fun resolvesRelativeLocationsAgainstPathlessBase() {
        assertEquals("https://a.com/b", OgFetch.resolveRef("https://a.com", "b"))
        assertEquals("https://a.com/x/c", OgFetch.resolveRef("https://a.com/x/y", "c"))
        assertEquals("https://b.com/", OgFetch.resolveRef("https://a.com/x", "https://b.com/"))
    }

    /** 假連線：回一個固定的轉址，不碰網路。 */
    private fun redirectTo(location: String): (java.net.URL) -> java.net.HttpURLConnection = { u ->
        object : java.net.HttpURLConnection(u) {
            override fun getResponseCode() = 302
            override fun getHeaderField(name: String?) = if (name.equals("Location", ignoreCase = true)) location else null
            override fun connect() {}
            override fun disconnect() {}
            override fun usingProxy() = false
        }
    }

    @Test
    fun strictModeRechecksEveryHop() {
        val public = { _: String -> arrayOf(InetAddress.getByName("8.8.8.8")) }
        // 轉到 http：下一跳過不了 acceptsUrl。
        assertEquals(OgFetch.Result.Failed("url"), OgFetch.fetch("https://a.example.com/", resolve = public, open = redirectTo("http://a.example.com/")))
        // 轉到解析成內網的名稱：下一跳的位址檢查擋下，不會連第二次。
        var opened = 0
        val r = OgFetch.fetch(
            "https://a.example.com/",
            resolve = { h -> if (h == "a.example.com") public(h) else arrayOf(InetAddress.getByName("10.0.0.1")) },
            open = { u -> opened++; redirectTo("https://internal.example.com/")(u) },
        )
        assertEquals(OgFetch.Result.Failed("address"), r)
        assertEquals(1, opened)
    }

    @Test
    fun slowPageGivesUpWithinTotalTimeout() {
        server.enqueue(
            MockResponse.Builder().code(200).addHeader("Content-Type", "text/html")
                .body("<p>" + "x".repeat(10_000)).throttleBody(10, 1, java.util.concurrent.TimeUnit.SECONDS).build()
        )
        val start = System.nanoTime()
        val r = OgFetch.fetch(server.url("/slow").toString(), strict = false, totalTimeoutMs = 500)
        val ms = (System.nanoTime() - start) / 1_000_000
        assertEquals(OgFetch.Result.Failed("network"), r)
        assertTrue("$ms ms", ms < 3_000)
    }

    @Test
    fun replyShapes() {
        val ok = OgFetch.reply(3, OgFetch.Result.Ok("t", "s", "", "https://a.com/"))
        assertEquals(true, ok.getBoolean("ok"))
        assertEquals("t", ok.getString("title"))
        assertEquals(true, OgFetch.reply(4, OgFetch.Result.None).getBoolean("none"))
        assertEquals("network", OgFetch.reply(5, OgFetch.Result.Failed("network")).getString("error"))
    }
}
