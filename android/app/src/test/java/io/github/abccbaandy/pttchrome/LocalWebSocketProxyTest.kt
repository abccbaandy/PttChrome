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
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 端對端：假 WebView（OkHttp client）→ LocalWebSocketProxy → 假 PTT（MockWebServer）。
 * 守護 Origin 改寫、雙向轉送、token／Origin 拒絕。
 * SSH 管線（`/ssh/<token>`，docs/ssh.md「APK」）：假 PTT 是本機 TCP echo（sshConnect 注入）。
 */
class LocalWebSocketProxyTest {
    private val ptt = MockWebServer()
    private lateinit var proxy: LocalWebSocketProxy
    private val client = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()

    private val pttReceived = LinkedBlockingQueue<ByteString>()
    private val pttClosed = java.util.concurrent.CountDownLatch(1)
    private var pttSocket: WebSocket? = null
    @Volatile private var pageOrigin = AppConfig.PAGE_ORIGIN

    /** 假 PTT 的 SSH：本機 TCP，回 "echo:" + 收到的 bytes。sshDown＝連不上。 */
    private val sshServer = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    @Volatile private var sshDown = false
    private val sshConnects = java.util.concurrent.atomic.AtomicInteger()

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
            allowedPageOrigin = { pageOrigin },
            sshConnect = {
                sshConnects.incrementAndGet()
                if (sshDown) throw java.io.IOException("refused")
                Socket().apply { connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), sshServer.localPort), 2000) }
            },
        )
        proxy.start()
        kotlin.concurrent.thread(isDaemon = true) {
            while (!sshServer.isClosed) {
                val c = try { sshServer.accept() } catch (_: Exception) { break }
                kotlin.concurrent.thread(isDaemon = true) {
                    try {
                        val buf = ByteArray(1024)
                        while (true) {
                            val n = c.getInputStream().read(buf)
                            if (n < 0) break
                            c.getOutputStream().write("echo:".toByteArray() + buf.copyOf(n))
                        }
                    } catch (_: Exception) {
                    } finally { c.close() }
                }
            }
        }
    }

    @After fun tearDown() {
        proxy.close()
        ptt.close()
        sshServer.close()
    }

    private class Events : WebSocketListener() {
        val messages = LinkedBlockingQueue<ByteString>()
        val failures = LinkedBlockingQueue<Response?>()
        val closings = LinkedBlockingQueue<Int>()
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            closings.add(code)
            webSocket.close(1000, null)
        }
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

    // App 設定切到 dev server：proxy 改認 dev 頁的 origin，正式版 origin 反而被拒（同一時間只認一個）。
    @Test fun followsCurrentPageOrigin() {
        pageOrigin = "http://localhost:8080"
        val (_, rejected) = connect(origin = AppConfig.PAGE_ORIGIN)
        assertEquals(403, rejected.failures.poll(5, TimeUnit.SECONDS)?.code)

        val (_, ev) = connect(origin = "http://localhost:8080")
        assertEquals("banner", ev.messages.poll(5, TimeUnit.SECONDS)?.utf8())
    }

    @Test fun siteUsesLoopbackAndToken() {
        assertTrue(proxy.site.startsWith("wstelnet://127.0.0.1:"))
        assertTrue(proxy.site.endsWith("/bbs/tok"))
    }

    // ---- SSH 管線 ----

    @Test fun sshPipesRawBytesBothWays() {
        val (ws, ev) = connect(path = proxy.sshPath)
        ws.send(ByteString.of(0x53, 0x53, 0x48, 0xff.toByte()))
        val got = ev.messages.poll(5, TimeUnit.SECONDS)
        assertEquals("echo:SSH", got?.substring(0, 8)?.utf8())
        assertEquals(0xff.toByte(), got?.toByteArray()?.get(8))
        assertEquals(1, sshConnects.get())
        // SSH 管線不碰 WebSocket 的上游（PTT 的 wsproxy）。
        assertEquals(0, ptt.requestCount)
        ws.close(1000, null)
    }

    @Test fun sshRejectsWithoutTokenOrForeignOrigin() {
        val (_, noToken) = connect(path = "/ssh")
        assertEquals(404, noToken.failures.poll(5, TimeUnit.SECONDS)?.code)
        val (_, foreign) = connect(path = proxy.sshPath, origin = "https://evil.example")
        assertEquals(403, foreign.failures.poll(5, TimeUnit.SECONDS)?.code)
        assertEquals(0, sshConnects.get())
    }

    // relay 合約：連不上 PTT 時握手照樣完成，再以 4502 關（網頁據此判「PTT 連不上」而非「relay 拒絕」）。
    @Test fun sshUpstreamFailureClosesWith4502() {
        sshDown = true
        val (_, ev) = connect(path = proxy.sshPath)
        assertEquals(AppConfig.RELAY_CLOSE_UPSTREAM_FAILED, ev.closings.poll(5, TimeUnit.SECONDS))
    }

    @Test fun sshSiteUsesLoopbackAndToken() {
        assertTrue(proxy.sshSite.startsWith("wssh://127.0.0.1:"))
        assertTrue(proxy.sshSite.endsWith("/ssh/tok"))
    }

    @Test fun protocolSettingNormalizes() {
        assertEquals(AppConfig.PROTOCOL_SSH, AppConfig.normalizeProtocol("ssh"))
        assertEquals(AppConfig.PROTOCOL_WEBSOCKET, AppConfig.normalizeProtocol(null))
        assertEquals(AppConfig.PROTOCOL_WEBSOCKET, AppConfig.normalizeProtocol("telnet"))
        assertTrue(AppConfig.isProtocol("websocket"))
        assertTrue(!AppConfig.isProtocol("ssh2"))
    }
}
