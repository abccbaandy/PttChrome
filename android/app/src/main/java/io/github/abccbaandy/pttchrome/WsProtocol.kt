package io.github.abccbaandy.pttchrome

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale

/**
 * 本機 proxy 需要的 RFC 6455 伺服器端最小實作：握手解析、client frame 解碼、server frame 編碼。
 * 純 JVM（無 Android 依賴），由 src/test 的 WsProtocolTest 守護。
 */
object WsProtocol {
    private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    const val MAX_HEADER_BYTES = 16 * 1024
    const val MAX_FRAME_BYTES = 1024 * 1024

    const val OP_CONT = 0x0
    const val OP_TEXT = 0x1
    const val OP_BINARY = 0x2
    const val OP_CLOSE = 0x8
    const val OP_PING = 0x9
    const val OP_PONG = 0xA

    data class HttpRequest(val method: String, val path: String, val headers: Map<String, String>) {
        fun header(name: String): String? = headers[name.lowercase(Locale.ROOT)]
    }

    sealed class Handshake {
        data class Accept(val key: String) : Handshake()
        data class Reject(val code: Int, val reason: String) : Handshake()
    }

    fun acceptKey(key: String): String =
        Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.ISO_8859_1))
        )

    fun readHttpHeader(input: InputStream): String {
        val bytes = ByteArrayOutputStream()
        var matched = 0
        val terminator = byteArrayOf('\r'.code.toByte(), '\n'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        while (bytes.size() < MAX_HEADER_BYTES) {
            val v = input.read()
            if (v < 0) throw EOFException("handshake ended early")
            bytes.write(v)
            matched = if (v.toByte() == terminator[matched]) matched + 1 else if (v == '\r'.code) 1 else 0
            if (matched == terminator.size) return String(bytes.toByteArray(), Charsets.ISO_8859_1)
        }
        throw IOException("handshake headers too large")
    }

    fun parseHttpRequest(text: String): HttpRequest {
        val lines = text.split("\r\n")
        val requestLine = lines.firstOrNull()?.split(" ") ?: throw IOException("empty request")
        if (requestLine.size < 2) throw IOException("bad request line")
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase(Locale.ROOT)] = line.substring(colon + 1).trim()
        }
        return HttpRequest(requestLine[0], requestLine[1].substringBefore('?'), headers)
    }

    /**
     * 決定要不要升級成 WebSocket。路徑必須帶本次啟動的隨機 token：本機任何 App 都連得到
     * 127.0.0.1，沒有 token 它們就能把這裡當成「Origin 改寫跳板」。Origin 也要是網頁版本身。
     */
    fun evaluate(req: HttpRequest, expectedPath: String, allowedOrigin: String): Handshake {
        if (req.method != "GET" || req.path != expectedPath) return Handshake.Reject(404, "Not Found")
        if (req.header("origin") != allowedOrigin) return Handshake.Reject(403, "Forbidden")
        val connectionUpgrade = req.header("connection").orEmpty().split(",")
            .any { it.trim().equals("upgrade", ignoreCase = true) }
        if (!"websocket".equals(req.header("upgrade"), ignoreCase = true) || !connectionUpgrade ||
            req.header("sec-websocket-version") != "13"
        ) return Handshake.Reject(400, "Bad WebSocket Request")
        val key = req.header("sec-websocket-key")
        if (key.isNullOrEmpty()) return Handshake.Reject(400, "Missing WebSocket Key")
        return Handshake.Accept(key)
    }

    fun switchingProtocols(key: String): ByteArray =
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n").toByteArray(Charsets.ISO_8859_1)

    fun httpError(code: Int, reason: String): ByteArray {
        val body = "$reason\n".toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $code $reason\r\nConnection: close\r\nContent-Type: text/plain\r\n" +
            "Content-Length: ${body.size}\r\n\r\n"
        return head.toByteArray(Charsets.ISO_8859_1) + body
    }

    /** Server → client frame（不 mask，FIN=1）。 */
    fun writeFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
        out.write(0x80 or (opcode and 0x0f))
        when {
            payload.size < 126 -> out.write(payload.size)
            payload.size <= 0xffff -> {
                out.write(126)
                out.write((payload.size shr 8) and 0xff)
                out.write(payload.size and 0xff)
            }
            else -> {
                out.write(127)
                for (shift in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr shift) and 0xff).toInt())
            }
        }
        out.write(payload)
        out.flush()
    }

    fun closePayload(code: Int, reason: String?): ByteArray {
        val r = (reason ?: "").toByteArray(Charsets.UTF_8).let { if (it.size > 120) it.copyOf(120) else it }
        return byteArrayOf(((code shr 8) and 0xff).toByte(), (code and 0xff).toByte()) + r
    }

    data class Message(val opcode: Int, val payload: ByteArray)

    /**
     * 從 client（WebView）讀 frame，把分片組回完整 message；控制 frame 原樣回傳。
     * EOF ⇒ null。client frame 一定要 mask（RFC 6455 §5.1），否則視為協定錯誤。
     */
    class FrameReader(private val input: InputStream) {
        private var fragment: ByteArrayOutputStream? = null
        private var fragmentOpcode = 0

        fun next(): Message? {
            while (true) {
                val first = input.read()
                if (first < 0) return null
                val second = readOne()
                val fin = first and 0x80 != 0
                val opcode = first and 0x0f
                val masked = second and 0x80 != 0
                var length = (second and 0x7f).toLong()
                if (length == 126L) length = ((readOne() shl 8) or readOne()).toLong()
                else if (length == 127L) {
                    length = 0
                    for (i in 0 until 8) {
                        val b = readOne()
                        if (i == 0 && b and 0x80 != 0) throw IOException("negative frame length")
                        length = (length shl 8) or b.toLong()
                    }
                }
                if (!masked) throw IOException("client frame not masked")
                if (length > MAX_FRAME_BYTES) throw IOException("frame too large")
                val mask = readBytes(4)
                val payload = readBytes(length.toInt())
                for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()

                when (opcode) {
                    OP_CLOSE, OP_PING, OP_PONG -> return Message(opcode, payload)
                    OP_CONT -> {
                        val buf = fragment ?: throw IOException("unexpected continuation frame")
                        buf.write(payload)
                        if (buf.size() > MAX_FRAME_BYTES) throw IOException("message too large")
                        if (fin) {
                            fragment = null
                            return Message(fragmentOpcode, buf.toByteArray())
                        }
                    }
                    OP_TEXT, OP_BINARY -> {
                        if (fragment != null) throw IOException("interleaved fragmented message")
                        if (fin) return Message(opcode, payload)
                        fragmentOpcode = opcode
                        fragment = ByteArrayOutputStream().apply { write(payload) }
                    }
                    else -> throw IOException("unsupported opcode $opcode")
                }
            }
        }

        private fun readOne(): Int {
            val v = input.read()
            if (v < 0) throw EOFException("truncated frame")
            return v
        }

        private fun readBytes(count: Int): ByteArray {
            val bytes = ByteArray(count)
            var off = 0
            while (off < count) {
                val n = input.read(bytes, off, count - off)
                if (n < 0) throw EOFException("truncated frame")
                off += n
            }
            return bytes
        }
    }
}
