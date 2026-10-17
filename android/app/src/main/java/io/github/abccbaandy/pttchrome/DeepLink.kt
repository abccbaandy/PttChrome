package io.github.abccbaandy.pttchrome

import java.net.URI
import java.net.URISyntaxException

/**
 * 外部 App（LINE／Telegram…）點連結帶進來的網址 → 交給網頁的 deep link fragment（docs/deep-link.md「Android APK」）。
 *
 * 只做「搬家」不做驗證：產出的 fragment 就是網頁 `deep_link.parseDeepLink` 吃的正規形式
 * `<Board>/M.<v1>.A.<v2>.html`，看板／AID 的完整檢查仍由網頁端負責（認不出 ⇒ 照常開站）。
 * 這裡的 regex 只是用來判斷「這條是不是我們接得住的」，接不住的 ptt.cc 網址要原樣交還瀏覽器。
 * 純邏輯，JVM test 守護（DeepLinkTest）。
 */
object DeepLink {
    sealed interface Result {
        /** 跳到這篇文章：[fragment] 不含 `#`，接在頁面網址後面或設給 `location.hash`。 */
        data class Article(val fragment: String) : Result

        /** 本站但沒帶文章：把 App 叫到前景就好。 */
        data object OpenApp : Result

        /** 不是我們接得住的：交還瀏覽器（manifest 的 pathPattern 比這裡寬，會有漏網之魚）。 */
        data object NotOurs : Result
    }

    private const val PTT_HOST = "www.ptt.cc"

    /** 與網頁 `aid_codec.BOARD_RE` 同一份字元集。 */
    private val BOARD = Regex("""^[0-9A-Za-z][0-9A-Za-z_.-]{1,31}$""")

    /** 與網頁 deep link 的檔名規則一致（pttbbs docs/aids.txt）：`.A` 後面可以沒有 hex。 */
    private val FILENAME = Regex("""^[MG]\.\d+\.A(?:\.[0-9A-F]{3})?\.html$""")

    private val PTT_ARTICLE_PATH = Regex("""^/bbs/([^/]+)/([^/]+)$""")

    /**
     * 「本站連結」恆以正式版網址 [AppConfig.PAGE_URL] 判定（manifest 也只認它）：fragment 與頁面來源無關，
     * dev server 模式下點正式版連結同樣要在 App 內跳文（模擬器實測過交給瀏覽器的版本，不合理）。
     */
    fun classify(url: String, pageUrl: String = AppConfig.PAGE_URL): Result {
        val uri = parse(url) ?: return Result.NotOurs
        val scheme = uri.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") return Result.NotOurs
        val host = uri.host?.lowercase() ?: return Result.NotOurs
        return when {
            host == PTT_HOST -> fromPtt(uri)
            isOwnSite(uri, scheme, host, pageUrl) -> fromOwnSite(uri)
            else -> Result.NotOurs
        }
    }

    private fun fromPtt(uri: URI): Result {
        val m = PTT_ARTICLE_PATH.matchEntire(uri.path ?: "") ?: return Result.NotOurs
        val (board, file) = m.destructured
        if (!BOARD.matches(board) || !FILENAME.matches(file)) return Result.NotOurs
        return Result.Article("$board/$file")
    }

    // 網頁自己的連結格式什麼都吃（hash／query 都有，見 docs/deep-link.md「URL 合約」），原樣轉交即可。
    // query 形式改寫成 hash 的 key=value 形式：App 已開著時是設 location.hash（不重載、不重新登入）。
    private fun fromOwnSite(uri: URI): Result {
        uri.rawFragment?.takeIf { it.isNotEmpty() }?.let { return Result.Article(it) }
        val params = (uri.rawQuery ?: "").split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i <= 0) null else it.substring(0, i) to it.substring(i + 1)
        }.toMap()
        val board = params["board"]
        val aid = params["aid"]
        if (!board.isNullOrEmpty() && !aid.isNullOrEmpty()) return Result.Article("board=$board&aid=$aid")
        return Result.OpenApp
    }

    private fun isOwnSite(uri: URI, scheme: String, host: String, pageUrl: String): Boolean {
        val page = parse(pageUrl) ?: return false
        if (scheme != page.scheme?.lowercase() || host != page.host?.lowercase() || uri.port != page.port) return false
        val base = (page.path ?: "/").ifEmpty { "/" }
        val path = (uri.path ?: "").ifEmpty { "/" }
        // GitHub Pages 會把 /PttChrome 轉址成 /PttChrome/，兩種都算。
        return path == base || path == base.trimEnd('/') || path == base + "index.html"
    }

    /**
     * App 已開著時交給網頁的 JS。**必須 `location.replace`，不可 `location.hash =`**：後者每次多疊一筆
     * history entry，疊在返回鍵 sentinel 上面 ⇒ 下一次返回只是落回 sentinel（history_back_guard 視為
     * 「沒往外退」）而被無聲吞掉，history 也越疊越長（手機實測）。replace 換掉當前 entry，hashchange 照發。
     */
    fun hashNavigationJs(fragment: String): String = "location.replace(${jsString("#$fragment")})"

    /** JS 雙引號字串字面值。本站 fragment 是外部 App 給的任意字串，不可直接拼進 JS。 */
    internal fun jsString(s: String): String = buildString {
        append('"')
        for (ch in s) {
            when {
                ch == '"' || ch == '\\' -> append('\\').append(ch)
                ch < ' ' || ch == ' ' || ch == ' ' || ch == '<' || ch == '>' ->
                    append("\\u").append(String.format("%04x", ch.code))
                else -> append(ch)
            }
        }
        append('"')
    }

    private fun parse(url: String): URI? = try { URI(url.trim()) } catch (_: URISyntaxException) { null }
}
