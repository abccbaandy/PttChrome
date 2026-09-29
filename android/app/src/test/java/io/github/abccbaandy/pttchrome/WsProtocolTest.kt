package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

class WsProtocolTest {
    private val path = "/bbs/abc123"
    private val origin = "https://abccbaandy.github.io"

    private fun req(
        path: String = this.path,
        origin: String? = this.origin,
        extra: Map<String, String> = emptyMap(),
    ): WsProtocol.HttpRequest {
        val h = mutableMapOf(
            "upgrade" to "websocket",
            "connection" to "keep-alive, Upgrade",
            "sec-websocket-version" to "13",
            "sec-websocket-key" to "dGhlIHNhbXBsZSBub25jZQ==",
        )
        if (origin != null) h["origin"] = origin
        h.putAll(extra)
        return WsProtocol.HttpRequest("GET", path, h)
    }

    @Test fun acceptKeyMatchesRfc6455Example() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", WsProtocol.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test fun parsesRequestLineAndHeaders() {
        val text = "GET /bbs/abc123?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://a.b\r\n\r\n"
        val r = WsProtocol.parseHttpRequest(WsProtocol.readHttpHeader(ByteArrayInputStream(text.toByteArray())))
        assertEquals("GET", r.method)
        assertEquals("/bbs/abc123", r.path)
        assertEquals("https://a.b", r.header("Origin"))
    }

    @Test fun acceptsValidHandshake() {
        assertTrue(WsProtocol.evaluate(req(), path, origin) is WsProtocol.Handshake.Accept)
    }

    // 沒有 token 的路徑＝本機別的 App 想拿 proxy 當 Origin 改寫跳板。
    @Test fun rejectsWrongOrMissingToken() {
        assertEquals(404, (WsProtocol.evaluate(req(path = "/bbs"), path, origin) as WsProtocol.Handshake.Reject).code)
        assertEquals(404, (WsProtocol.evaluate(req(path = "/bbs/nope"), path, origin) as WsProtocol.Handshake.Reject).code)
    }

    @Test fun rejectsForeignOrigin() {
        assertEquals(403, (WsProtocol.evaluate(req(origin = "https://evil.example"), path, origin) as WsProtocol.Handshake.Reject).code)
        assertEquals(403, (WsProtocol.evaluate(req(origin = null), path, origin) as WsProtocol.Handshake.Reject).code)
    }

    @Test fun rejectsNonUpgrade() {
        val r = req(extra = mapOf("connection" to "keep-alive"))
        assertEquals(400, (WsProtocol.evaluate(r, path, origin) as WsProtocol.Handshake.Reject).code)
    }

    private fun clientFrame(opcode: Int, payload: ByteArray, fin: Boolean = true): ByteArray {
        val out = ByteArrayOutputStream()
        out.write((if (fin) 0x80 else 0) or opcode)
        val mask = byteArrayOf(1, 2, 3, 4)
        when {
            payload.size < 126 -> out.write(0x80 or payload.size)
            payload.size <= 0xffff -> { out.write(0x80 or 126); out.write(payload.size shr 8); out.write(payload.size and 0xff) }
            else -> { out.write(0x80 or 127); for (s in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr s) and 0xff).toInt()) }
        }
        out.write(mask)
        out.write(ByteArray(payload.size) { (payload[it].toInt() xor mask[it and 3].toInt()).toByte() })
        return out.toByteArray()
    }

    @Test fun decodesMaskedFramesOfAllLengthClasses() {
        for (size in listOf(0, 125, 126, 65535, 65536, 300_000)) {
            val payload = ByteArray(size) { (it % 251).toByte() }
            val msg = WsProtocol.FrameReader(ByteArrayInputStream(clientFrame(2, payload))).next()!!
            assertEquals(2, msg.opcode)
            assertArrayEquals("size=$size", payload, msg.payload)
        }
    }

    @Test fun reassemblesFragments() {
        val bytes = clientFrame(2, "ab".toByteArray(), fin = false) +
            clientFrame(9, "p".toByteArray()) + // 控制 frame 可以插在分片中間
            clientFrame(0, "cd".toByteArray())
        val r = WsProtocol.FrameReader(ByteArrayInputStream(bytes))
        assertEquals(9, r.next()!!.opcode)
        val m = r.next()!!
        assertEquals(2, m.opcode)
        assertEquals("abcd", String(m.payload))
        assertNull(r.next())
    }

    @Test(expected = IOException::class)
    fun rejectsUnmaskedClientFrame() {
        WsProtocol.FrameReader(ByteArrayInputStream(byteArrayOf(0x82.toByte(), 0x01, 0x41))).next()
    }

    @Test fun serverFrameRoundTripsLengthHeader() {
        for (size in listOf(5, 200, 70_000)) {
            val out = ByteArrayOutputStream()
            WsProtocol.writeFrame(out, 2, ByteArray(size))
            val b = out.toByteArray()
            assertEquals(0x82, b[0].toInt() and 0xff)
            val header = when { size < 126 -> 2; size <= 0xffff -> 4; else -> 10 }
            assertEquals(header + size, b.size)
        }
    }
}
