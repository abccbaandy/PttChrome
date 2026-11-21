package io.github.abccbaandy.pttchrome

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.nio.charset.Charset

/**
 * bridge 'fetchOg'（P110 網頁連結預覽卡的 APK 版）：原生直接抓網頁的分享資訊（og:title／og:site_name／og:image），
 * 不經圖片代理 Worker（網址不經過我們、Worker 掛了也照常）。解析規則跟 Worker 的 proxy/imgur-worker/src/og.js
 * 同一套，**兩邊一起改**。
 *
 * 跟 Worker 不同的地方：這裡是在使用者自己的手機上連線 ⇒ 連得到使用者家裡的網路。所以
 *   - 只收 https（network_security_config 本來就不准明文），http 的連結網頁端照舊走 Worker；
 *   - host 解析出來的位址只要有一個是私有／迴路／鏈路本地／CGNAT ⇒ 不連（[isPublicAddress]）。
 *     解析之後到連線之間被換掉位址（DNS rebinding）也拿不到東西：內網那台的 TLS 憑證對不上這個 host 名稱。
 * 轉址自己跟（最多 [MAX_REDIRECTS] 次），每一跳重新過 [acceptsUrl]＋位址檢查。總時限 [TOTAL_TIMEOUT_MS]、
 * 只讀前 [MAX_HTML_BYTES]。只回四個欄位，網頁端 link_card.linkCardDescriptor 再驗一次。
 * 純 JVM（`OgFetchTest`）。
 */
internal object OgFetch {
    const val MAX_REDIRECTS = 3
    const val TIMEOUT_MS = 6_000
    const val TOTAL_TIMEOUT_MS = 6_000L
    const val MAX_HTML_BYTES = 300_000
    const val MAX_URL_LENGTH = 2048
    const val MAX_TITLE = 200
    const val MAX_SITE = 60
    private const val UA = "ptt-link-preview/1.0 (+https://github.com/abccbaandy/PttChrome)"

    /** 跟 og.js#BLOCKED_SUFFIXES、link_card.js 同一份。 */
    private val BLOCKED_SUFFIXES = listOf(".local", ".localhost", ".internal", ".lan", ".home.arpa", ".intranet", ".corp")

    sealed interface Result {
        data class Ok(val title: String, val site: String, val image: String, val url: String) : Result
        /** 這頁沒有分享資訊（不是錯誤）。 */
        data object None : Result
        data class Failed(val error: String) : Result
    }

    private fun isIpLiteral(host: String): Boolean =
        host.startsWith("[") || host.contains(':') || Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$").matches(host) ||
            host.startsWith("0x", ignoreCase = true) || Regex("^\\d+$").matches(host)

    /** 只收 https、預設埠、沒有帳密，host 不能是 IP／localhost／單一標籤／內網尾碼。 */
    fun acceptsUrl(url: String): Boolean {
        if (url.isEmpty() || url.length > MAX_URL_LENGTH) return false
        val u = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        if (!u.scheme.equals("https", ignoreCase = true)) return false
        if (u.rawUserInfo != null || u.port != -1) return false
        val host = u.host?.lowercase()?.removeSuffix(".") ?: return false
        if (host.isEmpty() || isIpLiteral(host)) return false
        if (host == "localhost" || !host.contains('.')) return false
        return BLOCKED_SUFFIXES.none { host.endsWith(it) }
    }

    /** 公開網路上的位址才連（私有、迴路、鏈路本地、未指定、多播、CGNAT 100.64/10、IPv6 ULA fc00::/7 都不行）。 */
    fun isPublicAddress(a: InetAddress): Boolean {
        if (a.isAnyLocalAddress || a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isMulticastAddress) {
            return false
        }
        val b = a.address
        if (a is Inet4Address) {
            val b0 = b[0].toInt() and 0xff
            val b1 = b[1].toInt() and 0xff
            if (b0 == 0) return false
            if (b0 == 100 && b1 in 64..127) return false
        }
        if (a is Inet6Address) {
            if ((b[0].toInt() and 0xfe) == 0xfc) return false
        }
        return true
    }

    private val ENTITY = Regex("&(#x[0-9a-fA-F]{1,6}|#\\d{1,7}|[a-zA-Z]{2,6});")
    private val NAMED = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ")

    fun decodeEntities(s: String): String = ENTITY.replace(s) { m ->
        val body = m.groupValues[1]
        if (body[0] == '#') {
            val code = if (body.length > 1 && (body[1] == 'x' || body[1] == 'X')) body.substring(2).toIntOrNull(16) else body.substring(1).toIntOrNull()
            if (code == null || code <= 0 || code > 0x10ffff || code in 0xd800..0xdfff) m.value else String(Character.toChars(code))
        } else {
            NAMED[body.lowercase()] ?: m.value
        }
    }

    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]+")
    private val SPACES = Regex("\\s+")

    /** 控制字元換空白、連續空白收一個、以 code point 截到上限。 */
    fun clean(s: String?, max: Int): String {
        if (s.isNullOrEmpty()) return ""
        val one = decodeEntities(s).replace(CONTROL, " ").replace(SPACES, " ").trim()
        val count = one.codePointCount(0, one.length)
        if (count <= max) return one
        val end = one.offsetByCodePoints(0, max - 1)
        return one.substring(0, end) + "…"
    }

    private fun cleanImage(raw: String?, base: String): String {
        if (raw.isNullOrBlank()) return ""
        val u = try {
            URI(base).resolve(decodeEntities(raw.trim()).replace(" ", "%20"))
        } catch (_: Exception) {
            return ""
        }
        if (!u.scheme.equals("https", ignoreCase = true) || u.rawUserInfo != null || u.host.isNullOrEmpty()) return ""
        val s = u.toString()
        return if (s.length > MAX_URL_LENGTH) "" else s
    }

    // `[^<>]*`：不跨過下一個 `<`（同 og.js 的 ReDoS 守護）。
    private val META = Regex("<meta\\b[^<>]*>", RegexOption.IGNORE_CASE)
    private val TITLE = Regex("<title\\b[^<>]*>([^<]{1,2000})</title>", RegexOption.IGNORE_CASE)

    private fun attr(tag: String, name: String): String? {
        for (p in listOf("\\s$name\\s*=\\s*\"([^\"]*)\"", "\\s$name\\s*=\\s*'([^']*)'", "\\s$name\\s*=\\s*([^\\s\"'>]+)")) {
            val m = Regex(p, RegexOption.IGNORE_CASE).find(tag)
            if (m != null) return m.groupValues[1]
        }
        return null
    }

    /** HTML → 分享資訊；沒有標題回 null（這頁不放卡）。og 優先、再 twitter:、標題最後退回 <title>。 */
    fun parseMeta(html: String, baseUrl: String): Result.Ok? {
        val head = if (html.length > MAX_HTML_BYTES) html.substring(0, MAX_HTML_BYTES) else html
        val found = HashMap<String, String>()
        for (m in META.findAll(head)) {
            val tag = m.value
            val key = (attr(tag, "property") ?: attr(tag, "name") ?: "").lowercase()
            val content = attr(tag, "content") ?: continue
            if (key.isEmpty()) continue
            found.putIfAbsent(key, content)
        }
        var title = clean(found["og:title"] ?: found["twitter:title"], MAX_TITLE)
        if (title.isEmpty()) title = clean(TITLE.find(head)?.groupValues?.get(1), MAX_TITLE)
        if (title.isEmpty()) return null
        val host = try {
            URI(baseUrl).host?.removePrefix("www.") ?: ""
        } catch (_: Exception) {
            ""
        }
        val site = clean(found["og:site_name"], MAX_SITE).ifEmpty { host }
        val image = cleanImage(
            found["og:image:secure_url"] ?: found["og:image"] ?: found["og:image:url"] ?: found["twitter:image"] ?: found["twitter:image:src"],
            baseUrl,
        )
        return Result.Ok(title, site, image, baseUrl)
    }

    private val HEADER_CHARSET = Regex("charset\\s*=\\s*[\"']?([\\w-]+)", RegexOption.IGNORE_CASE)
    private val META_CHARSET = Regex("<meta\\b[^<>]*charset\\s*=\\s*[\"']?([\\w-]+)", RegexOption.IGNORE_CASE)

    /** Content-Type 的 charset，沒有就看前 4 KB 的 <meta charset>，都沒有或不認得 ⇒ UTF-8。 */
    fun pickCharset(contentType: String?, head: ByteArray): Charset {
        val name = HEADER_CHARSET.find(contentType ?: "")?.groupValues?.get(1)
            ?: META_CHARSET.find(String(head, 0, minOf(head.size, 4096), Charsets.ISO_8859_1))?.groupValues?.get(1)
        return try {
            if (name != null) Charset.forName(name) else Charsets.UTF_8
        } catch (_: Exception) {
            Charsets.UTF_8
        }
    }

    /**
     * 抓網頁、跟轉址、讀前 [MAX_HTML_BYTES]、解析。error：'url'（不收的網址或轉址）／'address'（解析到內網）／
     * 'http'（非 2xx）／'network'。
     */
    fun fetch(
        url: String,
        /** 測試用：本機 MockWebServer 是 http＋127.0.0.1。正式呼叫一律 true。 */
        strict: Boolean = true,
        resolve: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
        open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    ): Result {
        var target = url
        val deadline = System.nanoTime() + TOTAL_TIMEOUT_MS * 1_000_000
        var hop = 0
        while (true) {
            if (strict && !acceptsUrl(target)) return Result.Failed("url")
            if (strict) {
                val host = try {
                    URI(target).host
                } catch (_: Exception) {
                    return Result.Failed("url")
                }
                val addrs = try {
                    resolve(host)
                } catch (_: Exception) {
                    return Result.Failed("network")
                }
                if (addrs.isEmpty() || addrs.any { !isPublicAddress(it) }) return Result.Failed("address")
            }
            val conn = try {
                open(URL(target))
            } catch (_: Exception) {
                return Result.Failed("network")
            }
            try {
                conn.connectTimeout = TIMEOUT_MS
                conn.readTimeout = TIMEOUT_MS
                conn.instanceFollowRedirects = false
                conn.setRequestProperty("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1")
                conn.setRequestProperty("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.5")
                conn.setRequestProperty("User-Agent", UA)
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location")
                    if (loc.isNullOrEmpty() || hop >= MAX_REDIRECTS) return Result.Failed("url")
                    target = try {
                        URI(target).resolve(loc).toString()
                    } catch (_: Exception) {
                        return Result.Failed("url")
                    }
                    hop++
                    continue
                }
                if (code !in 200..299) return Result.Failed("http")
                val ct = conn.contentType?.lowercase() ?: ""
                if (!ct.startsWith("text/html") && !ct.startsWith("application/xhtml+xml")) return Result.None
                val out = ByteArrayOutputStream(64 * 1024)
                val buf = ByteArray(16 * 1024)
                conn.inputStream.use { input ->
                    while (out.size() < MAX_HTML_BYTES) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (System.nanoTime() > deadline) return Result.Failed("network")
                        out.write(buf, 0, minOf(n, MAX_HTML_BYTES - out.size()))
                    }
                }
                val bytes = out.toByteArray()
                val html = String(bytes, pickCharset(conn.contentType, bytes))
                return parseMeta(html, target) ?: Result.None
            } catch (_: IOException) {
                return Result.Failed("network")
            } finally {
                conn.disconnect()
            }
        }
    }

    /** bridge 回覆：{ ok, title, site, image, url }／{ ok, none:true }／{ ok:false, error }。 */
    fun reply(id: Int, r: Result): JSONObject = when (r) {
        is Result.Ok -> JSONObject().put("id", id).put("ok", true)
            .put("title", r.title).put("site", r.site).put("image", r.image).put("url", r.url)
        Result.None -> JSONObject().put("id", id).put("ok", true).put("none", true)
        is Result.Failed -> failed(id, r.error)
    }

    fun failed(id: Int, error: String): JSONObject = JSONObject().put("id", id).put("ok", false).put("error", error)
}
