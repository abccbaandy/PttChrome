package io.github.abccbaandy.pttchrome

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * 只綁 127.0.0.1 的 WebSocket 中繼：WebView（網頁版）連進來 → 以原生 OkHttp 連 PTT，
 * 上游 Origin 改寫成 term.ptt.cc。連線本體由前景服務持有，App 切到背景時不會被系統掐斷。
 *
 * - port 由系統挑（綁 0），路徑必須是 `/bbs/<token>`（token 每次啟動隨機）。
 * - 保活只靠 OkHttp 的 WebSocket ping；不注入 telnet 指令（會流進網頁的 telnet parser）。
 * - `/ssh/<token>`（docs/ssh.md「APK」）：SSH 協議的位元組管線，WebSocket ⇄ TCP ptt.cc:22，
 *   一個 byte 都不解讀（SSH 在網頁裡解開）。目的地寫死在 [connectPttSsh]；連不上 PTT 時握手照樣完成，
 *   再以 close code 4502 關掉（relay 合約，網頁據此分辨「PTT 連不上」）。
 */
class LocalWebSocketProxy(
    private val token: String,
    private val upstreamUrl: String = AppConfig.UPSTREAM_URL,
    private val upstreamOrigin: String = AppConfig.UPSTREAM_ORIGIN,
    /** 握手當下才取值：App 設定切換 dev server 後，proxy 只認新的頁面 origin（[PageSource]）。 */
    private val allowedPageOrigin: () -> String = { AppConfig.PAGE_ORIGIN },
    private val onStateChanged: (activeSessions: Int) -> Unit = {},
    /** 診斷事件（連上游耗時、第一筆 PTT 資料）；ConnectionService 接到 logcat（BootTrace）。 */
    private val onEvent: (String) -> Unit = {},
    /** 測試注入用；參數刻意是零個：目的地不能從外面傳進來。 */
    private val sshConnect: () -> Socket = { connectPttSsh() },
) {
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val active = AtomicInteger()
    @Volatile private var server: ServerSocket? = null
    @Volatile private var running = false
    private val sessions = java.util.Collections.synchronizedSet(HashSet<Session>())

    val port: Int get() = server?.localPort ?: -1
    val path: String get() = AppConfig.LOCAL_PATH_PREFIX + token
    val site: String get() = "wstelnet://127.0.0.1:$port$path"
    val sshPath: String get() = AppConfig.LOCAL_SSH_PATH_PREFIX + token
    val sshSite: String get() = "wssh://127.0.0.1:$port$sshPath"
    val activeSessions: Int get() = active.get()

    fun start() {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 8)
        server = s
        running = true
        thread(name = "ptt-proxy-accept", isDaemon = true) { acceptLoop(s) }
    }

    companion object {
        /** ⚠ 安全邊界：SSH 管線唯一的開 TCP 處，目的地是常數（docs/ssh.md「風險與對策」）。 */
        fun connectPttSsh(): Socket = Socket().apply {
            tcpNoDelay = true
            connect(InetSocketAddress(AppConfig.SSH_UPSTREAM_HOST, AppConfig.SSH_UPSTREAM_PORT), 10_000)
        }
    }

    fun close() {
        running = false
        try { server?.close() } catch (_: IOException) {}
        synchronized(sessions) { sessions.toList() }.forEach { it.close() }
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    /** 通知的「中斷連線」：關掉現有連線，但 proxy 仍在（網頁可以再按重連）。 */
    fun disconnectAll() {
        synchronized(sessions) { sessions.toList() }.forEach { it.close() }
    }

    private fun acceptLoop(s: ServerSocket) {
        while (running) {
            val socket = try { s.accept() } catch (_: IOException) { continue }
            socket.tcpNoDelay = true
            thread(name = "ptt-proxy-session", isDaemon = true) { Session(socket).run() }
        }
    }

    private inner class Session(private val local: Socket) {
        private val writeLock = Any()
        private val pending = ArrayDeque<Pair<Int, ByteArray>>()
        @Volatile private var out: OutputStream? = null
        @Volatile private var upstream: WebSocket? = null
        @Volatile private var sshUpstream: Socket? = null
        @Volatile private var upstreamOpened = false
        @Volatile private var localReady = false
        @Volatile private var closed = false
        private var counted = false

        fun run() {
            sessions.add(this)
            try {
                val input = local.getInputStream()
                val o = local.getOutputStream()
                out = o
                val req = WsProtocol.parseHttpRequest(WsProtocol.readHttpHeader(input))
                if (req.path == sshPath) {
                    runSsh(req, input, o)
                    return
                }
                when (val verdict = WsProtocol.evaluate(req, path, allowedPageOrigin())) {
                    is WsProtocol.Handshake.Reject -> {
                        o.write(WsProtocol.httpError(verdict.code, verdict.reason)); o.flush()
                        return
                    }
                    is WsProtocol.Handshake.Accept -> {
                        onEvent("proxyAccept")
                        if (!connectUpstream()) {
                            o.write(WsProtocol.httpError(502, "PTT Upstream Failed")); o.flush()
                            return
                        }
                        synchronized(writeLock) {
                            o.write(WsProtocol.switchingProtocols(verdict.key)); o.flush()
                            localReady = true
                            while (pending.isNotEmpty()) {
                                val (op, data) = pending.removeFirst()
                                WsProtocol.writeFrame(o, op, data)
                            }
                        }
                        counted = true
                        onStateChanged(active.incrementAndGet())
                        readLoop(WsProtocol.FrameReader(input))
                    }
                }
            } catch (_: Exception) {
                // WebView 端斷線、協定錯誤：一律收掉這條 session。
            } finally {
                close()
            }
        }

        /** SSH 協議：握手 → TCP ptt.cc:22 → 雙向搬 bytes。 */
        private fun runSsh(req: WsProtocol.HttpRequest, input: java.io.InputStream, o: OutputStream) {
            when (val verdict = WsProtocol.evaluate(req, sshPath, allowedPageOrigin())) {
                is WsProtocol.Handshake.Reject -> {
                    o.write(WsProtocol.httpError(verdict.code, verdict.reason)); o.flush()
                }
                is WsProtocol.Handshake.Accept -> {
                    onEvent("sshAccept")
                    synchronized(writeLock) {
                        o.write(WsProtocol.switchingProtocols(verdict.key)); o.flush()
                        localReady = true
                    }
                    val started = System.nanoTime()
                    val tcp = try {
                        sshConnect()
                    } catch (e: Exception) {
                        onEvent("sshUpstreamFailure ${e.javaClass.simpleName}")
                        sendClose(AppConfig.RELAY_CLOSE_UPSTREAM_FAILED, "upstream connect failed")
                        return
                    }
                    sshUpstream = tcp
                    onEvent("sshUpstreamOpen +${(System.nanoTime() - started) / 1_000_000}ms")
                    counted = true
                    onStateChanged(active.incrementAndGet())
                    thread(name = "ptt-ssh-upstream", isDaemon = true) {
                        val buf = ByteArray(16 * 1024)
                        try {
                            val tin = tcp.getInputStream()
                            while (true) {
                                val n = tin.read(buf)
                                if (n < 0) break
                                toLocal(WsProtocol.OP_BINARY, buf.copyOf(n))
                            }
                            sendClose(1000, "upstream closed")
                        } catch (_: IOException) {
                            sendClose(1011, "upstream error")
                        }
                        close()
                    }
                    sshReadLoop(WsProtocol.FrameReader(input), tcp.getOutputStream())
                }
            }
        }

        private fun sshReadLoop(reader: WsProtocol.FrameReader, tcpOut: OutputStream) {
            while (running && !closed) {
                val msg = reader.next() ?: return
                when (msg.opcode) {
                    WsProtocol.OP_CLOSE -> {
                        synchronized(writeLock) { WsProtocol.writeFrame(out!!, WsProtocol.OP_CLOSE, msg.payload) }
                        return
                    }
                    WsProtocol.OP_PING -> synchronized(writeLock) { WsProtocol.writeFrame(out!!, WsProtocol.OP_PONG, msg.payload) }
                    WsProtocol.OP_PONG -> Unit
                    WsProtocol.OP_BINARY -> {
                        tcpOut.write(msg.payload)
                        tcpOut.flush()
                    }
                    else -> {
                        sendClose(1003, "binary only")
                        return
                    }
                }
            }
        }

        private fun connectUpstream(): Boolean {
            val done = CountDownLatch(1)
            val request = Request.Builder().url(upstreamUrl).header("Origin", upstreamOrigin).build()
            val started = System.nanoTime()
            fun elapsed() = (System.nanoTime() - started) / 1_000_000
            var gotFirst = false
            fun first() {
                if (!gotFirst) { gotFirst = true; onEvent("upstreamFirstData +${elapsed()}ms") }
            }
            upstream = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    onEvent("upstreamOpen +${elapsed()}ms")
                    upstreamOpened = true
                    done.countDown()
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    first()
                    toLocal(WsProtocol.OP_BINARY, bytes.toByteArray())
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    first()
                    toLocal(WsProtocol.OP_TEXT, text.toByteArray(Charsets.UTF_8))
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                    sendClose(code, reason)
                    close()
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    onEvent("upstreamFailure +${elapsed()}ms ${t.javaClass.simpleName}")
                    done.countDown()
                    sendClose(1011, "upstream failed")
                    close()
                }
            })
            if (!done.await(12, TimeUnit.SECONDS)) {
                upstream?.cancel()
                return false
            }
            return upstreamOpened
        }

        private fun toLocal(opcode: Int, payload: ByteArray) {
            synchronized(writeLock) {
                if (closed) return
                if (!localReady) { pending.addLast(opcode to payload); return }
                try { WsProtocol.writeFrame(out!!, opcode, payload) } catch (_: IOException) { close() }
            }
        }

        private fun sendClose(code: Int, reason: String?) {
            synchronized(writeLock) {
                if (closed || !localReady) return
                try { WsProtocol.writeFrame(out!!, WsProtocol.OP_CLOSE, WsProtocol.closePayload(code, reason)) } catch (_: IOException) {}
            }
        }

        private fun readLoop(reader: WsProtocol.FrameReader) {
            while (running && !closed) {
                val msg = reader.next() ?: return
                when (msg.opcode) {
                    WsProtocol.OP_CLOSE -> {
                        val code = if (msg.payload.size >= 2)
                            ((msg.payload[0].toInt() and 0xff) shl 8) or (msg.payload[1].toInt() and 0xff) else 1000
                        upstream?.close(if (code in 1000..4999 && code != 1005 && code != 1006) code else 1000, "webview closed")
                        synchronized(writeLock) { WsProtocol.writeFrame(out!!, WsProtocol.OP_CLOSE, msg.payload) }
                        return
                    }
                    WsProtocol.OP_PING -> synchronized(writeLock) { WsProtocol.writeFrame(out!!, WsProtocol.OP_PONG, msg.payload) }
                    WsProtocol.OP_PONG -> Unit
                    else -> {
                        val ws = upstream ?: throw IOException("upstream not open")
                        val ok = if (msg.opcode == WsProtocol.OP_TEXT) ws.send(String(msg.payload, Charsets.UTF_8))
                        else ws.send(msg.payload.toByteString())
                        if (!ok) throw IOException("upstream rejected message")
                    }
                }
            }
        }

        fun close() {
            synchronized(writeLock) {
                if (closed) return
                closed = true
            }
            upstream?.close(1000, "local client closed")
            try { sshUpstream?.close() } catch (_: IOException) {}
            try { local.close() } catch (_: IOException) {}
            sessions.remove(this)
            if (counted) {
                counted = false
                onStateChanged(active.decrementAndGet())
            }
        }
    }
}
