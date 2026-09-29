package io.github.abccbaandy.pttchrome

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 端對端：假 WebView（OkHttp client）→ LocalWebSocketProxy → 假 PTT（MockWebServer）。
 * 守護 Origin 改寫、雙向轉送、token／Origin 拒絕。
 */
class LocalWebSocketProxyTest {
    private val ptt = MockWebServer()
    private lateinit var proxy: LocalWebSocketProxy
    private val client = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()

    private val pttReceived = LinkedBlockingQueue<ByteString>()
    private val pttClosed = java.util.concurrent.CountDownLatch(1)
    private var pttSocket: WebSocket? = null

    @Before fun setUp() {
        ptt.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                pttSocket = webSocket
                webSocket.send("banner".encodeUtf8())
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { pttReceived.add(bytes) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                pttClosed.countDown()
            }
        }).build())
        ptt.start()
        proxy = LocalWebSocketProxy(
            token = "tok",
            upstreamUrl = ptt.url("/bbs").toString().replace("http://", "ws://"),
        )
        proxy.start()
    }

    @After fun tearDown() {
        proxy.close()
        ptt.close()
    }

    private class Events : WebSocketListener() {
        val messages = LinkedBlockingQueue<ByteString>()
        val failures = LinkedBlockingQueue<Response?>()
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) { messages.add(bytes) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            failures.add(response ?: Response.Builder().code(0).message("")
                .protocol(okhttp3.Protocol.HTTP_1_1).request(Request.Builder().url("http://x/").build()).build())
        }
    }

    private fun connect(path: String = proxy.path, origin: String = AppConfig.PAGE_ORIGIN): Pair<WebSocket, Events> {
        val ev = Events()
        val ws = client.newWebSocket(
            Request.Builder().url("ws://127.0.0.1:${proxy.port}$path").header("Origin", origin).build(), ev,
        )
        return ws to ev
    }

    @Test fun relaysBothWaysAndRewritesOrigin() {
        val (ws, ev) = connect()
        assertEquals("banner", ev.messages.poll(5, TimeUnit.SECONDS)?.utf8())

        val upgrade = ptt.takeRequest()
        assertEquals(AppConfig.UPSTREAM_ORIGIN, upgrade.headers["Origin"])

        ws.send("hello".encodeUtf8())
        assertEquals("hello", pttReceived.poll(5, TimeUnit.SECONDS)?.utf8())

        pttSocket!!.send(ByteString.of(0xff.toByte(), 0xfb.toByte(), 0x01))
        assertEquals(3, ev.messages.poll(5, TimeUnit.SECONDS)?.size)
        assertEquals(1, proxy.activeSessions)

        // WebView 關掉 → 上游（PTT）那條也要跟著收掉，不能留著佔一個登入名額。
        ws.close(1000, null)
        assertTrue(pttClosed.await(5, TimeUnit.SECONDS))
    }

    @Test fun rejectsWithoutToken() {
        val (_, ev) = connect(path = "/bbs")
        assertEquals(404, ev.failures.poll(5, TimeUnit.SECONDS)?.code)
        assertEquals(0, ptt.requestCount)
    }

    @Test fun rejectsForeignOrigin() {
        val (_, ev) = connect(origin = "https://evil.example")
        assertEquals(403, ev.failures.poll(5, TimeUnit.SECONDS)?.code)
        assertEquals(0, ptt.requestCount)
    }

    @Test fun siteUsesLoopbackAndToken() {
        assertTrue(proxy.site.startsWith("wstelnet://127.0.0.1:"))
        assertTrue(proxy.site.endsWith("/bbs/tok"))
    }
}
