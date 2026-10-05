package io.github.abccbaandy.pttchrome

import java.net.URI
import java.net.URISyntaxException

/**
 * WebView 要載入的網頁來源：正式版（GitHub Pages）或 App 設定裡的 dev server（電腦上的 `yarn start`）。
 * bridge 注入、WebMessageListener、本機 proxy 的 Origin 檢查都只認 [origin] 這一個（docs/android-app.md 不變量 4）。
 *
 * dev server 只收 `http`＋本機（`localhost`／`127.0.0.1`，配 `adb reverse`）；debug APK 另收私有 IPv4
 * （區網直連）。正式版不收區網 IP：那需要整個 App 放行明文 http（network_security_config 無法只放行 IP 範圍）。
 * 純邏輯，JVM test 守護（PageSourceTest）。
 */
data class PageSource(val url: String, val origin: String, val isDev: Boolean) {
    companion object {
        val PRODUCTION = PageSource(AppConfig.PAGE_URL, AppConfig.PAGE_ORIGIN, isDev = false)

        const val DEFAULT_DEV_URL = "http://localhost:8080/"
        private const val DEFAULT_DEV_PORT = 8080
        private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1")
        private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

        /** 設定值 → 實際載入的來源；dev 關閉或網址不合格一律回正式版。 */
        fun resolve(devEnabled: Boolean, devUrl: String, allowLan: Boolean): PageSource =
            if (devEnabled) parseDevServer(devUrl, allowLan) ?: PRODUCTION else PRODUCTION

        /**
         * 使用者輸入的 dev server 位址 → 正規化的 `http://host:port/`；不合格回 null。
         * 省略 scheme 視為 http、省略 port 視為 8080；path／query 一律丟掉（dev server 掛在根目錄）。
         */
        fun parseDevServer(input: String, allowLan: Boolean): PageSource? {
            val raw = input.trim()
            if (raw.isEmpty()) return null
            val withScheme = if (raw.contains("://")) raw else "http://$raw"
            val uri = try { URI(withScheme) } catch (_: URISyntaxException) { return null }
            if (!uri.scheme.equals("http", ignoreCase = true)) return null
            if (uri.rawUserInfo != null) return null
            val host = uri.host?.lowercase() ?: return null
            if (host !in LOOPBACK_HOSTS && !(allowLan && isPrivateIpv4(host))) return null
            val port = if (uri.port == -1) DEFAULT_DEV_PORT else uri.port
            if (port !in 1..65535) return null
            val origin = if (port == 80) "http://$host" else "http://$host:$port"
            return PageSource("$origin/", origin, isDev = true)
        }

        private fun isPrivateIpv4(host: String): Boolean {
            val m = IPV4.matchEntire(host) ?: return false
            val o = m.groupValues.drop(1).map { it.toInt() }
            if (o.any { it > 255 }) return false
            return o[0] == 10 ||
                (o[0] == 172 && o[1] in 16..31) ||
                (o[0] == 192 && o[1] == 168)
        }
    }
}
