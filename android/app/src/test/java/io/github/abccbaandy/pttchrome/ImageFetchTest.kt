package io.github.abccbaandy.pttchrome

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** bridge 'fetchImage' 的純 JVM 部分（P107）：網址／型別判斷、縮圖倍率、下載上限。縮圖編碼要 Android，這裡不測。 */
class ImageFetchTest {
    private val server = MockWebServer()

    @Before fun setUp() = server.start()

    @After fun tearDown() = server.close()

    private fun image(bytes: ByteArray, type: String = "image/jpeg") =
        MockResponse.Builder().code(200).addHeader("Content-Type", type).body(Buffer().write(bytes)).build()

    private fun download(path: String, maxBytes: Int = ImageFetch.MAX_BYTES) =
        ImageFetch.download(server.url(path).toString(), maxBytes = maxBytes, requireHttps = false)

    @Test
    fun acceptsOnlyHttpsUrlsWithHost() {
        assertTrue(ImageFetch.acceptsUrl("https://i.imgur.com/abc.jpg"))
        assertTrue(ImageFetch.acceptsUrl("HTTPS://pbs.twimg.com/media/x?format=jpg"))
        listOf(
            "http://i.imgur.com/abc.jpg",
            "file:///sdcard/a.jpg",
            "content://media/1",
            "https:///nohost.jpg",
            "https://user:pw@example.com/a.jpg",
            "not a url",
            "",
        ).forEach { assertFalse(it, ImageFetch.acceptsUrl(it)) }
    }

    @Test
    fun acceptsStaticImageTypesButNotGif() {
        assertTrue(ImageFetch.acceptsContentType("image/jpeg"))
        assertTrue(ImageFetch.acceptsContentType("IMAGE/PNG; charset=binary"))
        assertTrue(ImageFetch.acceptsContentType("image/webp"))
        listOf(null, "", "text/html", "image/gif", "Image/GIF", "application/octet-stream").forEach {
            assertFalse(it.toString(), ImageFetch.acceptsContentType(it))
        }
    }

    @Test
    fun sampleSizeKeepsWidthAtLeastTarget() {
        assertEquals(1, ImageFetch.sampleSize(800))
        assertEquals(1, ImageFetch.sampleSize(2159))
        assertEquals(2, ImageFetch.sampleSize(2160))
        assertEquals(4, ImageFetch.sampleSize(4320))
        assertEquals(4, ImageFetch.sampleSize(8000))
        listOf(800, 2159, 2160, 4000, 8000, 12000).forEach { w ->
            assertTrue("$w", w <= 1080 || w / ImageFetch.sampleSize(w) >= 1080)
        }
    }

    @Test
    fun scaledSizeIsProportionalAndCapped() {
        assertEquals(800 to 600, ImageFetch.scaledSize(800, 600))
        assertEquals(1080 to 810, ImageFetch.scaledSize(2160, 1620))
        assertEquals(1080 to 1, ImageFetch.scaledSize(100000, 10))
    }

    @Test
    fun downloadsImageBytes() {
        val bytes = ByteArray(40_000) { (it % 251).toByte() }
        server.enqueue(image(bytes))
        val d = download("/a.jpg")
        assertTrue(d is ImageFetch.Download.Ok)
        assertArrayEquals(bytes, (d as ImageFetch.Download.Ok).bytes)
    }

    @Test
    fun followsRedirects() {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", server.url("/b.png").toString()).build())
        server.enqueue(image(byteArrayOf(1, 2, 3), "image/png"))
        val d = download("/a.png")
        assertTrue(d is ImageFetch.Download.Ok)
    }

    @Test
    fun rejectsErrorPagesGifsAndHtml() {
        server.enqueue(MockResponse.Builder().code(404).addHeader("Content-Type", "image/jpeg").body("nope").build())
        assertEquals(ImageFetch.Download.Failed("http"), download("/404.jpg"))
        server.enqueue(image(byteArrayOf(1), "image/gif"))
        assertEquals(ImageFetch.Download.Failed("type"), download("/a.gif"))
        server.enqueue(MockResponse.Builder().code(200).addHeader("Content-Type", "text/html").body("<html>").build())
        assertEquals(ImageFetch.Download.Failed("type"), download("/removed.jpg"))
    }

    @Test
    fun stopsAtSizeLimit() {
        server.enqueue(image(ByteArray(5000)))
        assertEquals(ImageFetch.Download.Failed("tooLarge"), download("/big.jpg", maxBytes = 4096))
        server.enqueue(image(ByteArray(4096)))
        assertTrue(download("/exact.jpg", maxBytes = 4096) is ImageFetch.Download.Ok)
    }

    @Test
    fun rejectsPlainHttpInProduction() {
        assertEquals(ImageFetch.Download.Failed("url"), ImageFetch.download(server.url("/a.jpg").toString()))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun unreachableHostIsNetworkError() {
        val url = server.url("/a.jpg").toString()
        server.close()
        assertEquals(ImageFetch.Download.Failed("network"), ImageFetch.download(url, requireHttps = false))
    }

    @Test
    fun replyCarriesBase64OrRefusesHugeOutput() {
        val ok = ImageFetch.reply(7, byteArrayOf(1, 2, 3), 10, 20)
        assertEquals(7, ok.getInt("id"))
        assertTrue(ok.getBoolean("ok"))
        assertEquals("image/webp", ok.getString("mime"))
        assertEquals("AQID", ok.getString("data"))
        assertEquals(10, ok.getInt("w"))
        assertEquals(20, ok.getInt("h"))
        val big = ImageFetch.reply(8, ByteArray(ImageFetch.MAX_OUTPUT_BYTES + 1), 1, 1)
        assertFalse(big.getBoolean("ok"))
        assertEquals("tooLarge", big.getString("error"))
    }
}
