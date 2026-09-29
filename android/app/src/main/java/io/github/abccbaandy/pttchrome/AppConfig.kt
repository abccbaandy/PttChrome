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
}
