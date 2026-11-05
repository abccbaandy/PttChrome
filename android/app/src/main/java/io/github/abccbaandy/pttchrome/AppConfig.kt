package io.github.abccbaandy.pttchrome

/** 固定常數。改 [PAGE_ORIGIN] 或 applicationId 都要同步更新 assetlinks.json（docs/android-app.md）。 */
object AppConfig {
    /** WebView 載入的網頁版（GitHub Pages，網頁更新不必重裝 APK）。 */
    const val PAGE_URL = "https://abccbaandy.github.io/PttChrome/"

    /** 唯一被注入 bridge、也唯一被本機 proxy 接受的頁面 origin。 */
    const val PAGE_ORIGIN = "https://abccbaandy.github.io"

    const val UPSTREAM_URL = "wss://ws.ptt.cc/bbs"

    /** PTT 的 WebSocket 閘道只收 term.ptt.cc 的 Origin（docs/pttchrome-research.md）。 */
    const val UPSTREAM_ORIGIN = "https://term.ptt.cc"

    const val LOCAL_PATH_PREFIX = "/bbs/"

    /**
     * SSH 協議（docs/ssh.md「APK」）：本機 proxy 的 `/ssh/<token>` 只做「WebSocket ⇄ TCP ptt.cc:22」，
     * SSH 在網頁裡解開。⚠ 安全邊界：目的地只能是這兩個常數，絕不從請求解析
     *（tests/unit/ssh_relay.test.js 靜態守護）。
     */
    const val SSH_UPSTREAM_HOST = "ptt.cc"
    const val SSH_UPSTREAM_PORT = 22
    const val LOCAL_SSH_PATH_PREFIX = "/ssh/"

    /** relay 合約（src/js/ssh/ssh_transport.js#RELAY_CLOSE）：relay → PTT 的 TCP 失敗。 */
    const val RELAY_CLOSE_UPSTREAM_FAILED = 4502

    /** 連線協議（[AppSettings.protocol]），值與網頁的 connectionProtocol pref 相同。 */
    const val PROTOCOL_WEBSOCKET = "websocket"
    const val PROTOCOL_SSH = "ssh"

    fun isProtocol(v: String?): Boolean = v == PROTOCOL_WEBSOCKET || v == PROTOCOL_SSH

    /** 不認得的值（舊版存的、壞掉的）一律當 WebSocket。 */
    fun normalizeProtocol(v: String?): String = if (v == PROTOCOL_SSH) PROTOCOL_SSH else PROTOCOL_WEBSOCKET
}
