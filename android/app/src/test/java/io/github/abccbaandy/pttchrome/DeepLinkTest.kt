package io.github.abccbaandy.pttchrome

import io.github.abccbaandy.pttchrome.DeepLink.Result.Article
import io.github.abccbaandy.pttchrome.DeepLink.Result.NotOurs
import io.github.abccbaandy.pttchrome.DeepLink.Result.OpenApp
import org.junit.Assert.assertEquals
import org.junit.Test

/** 外部連結 → 網頁 deep link fragment。接不住的一律 NotOurs（交還瀏覽器），不准產出壞 fragment。 */
class DeepLinkTest {
    private fun c(url: String, page: String = AppConfig.PAGE_URL) = DeepLink.classify(url, page)

    @Test fun pttArticleBecomesCanonicalFragment() {
        assertEquals(Article("Gossiping/M.1786265274.A.5E3.html"), c("https://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html"))
        assertEquals(Article("Browsers/M.1786265274.A.html"), c("https://www.ptt.cc/bbs/Browsers/M.1786265274.A.html"))
        assertEquals(Article("Test/G.1600000000.A.0AF.html"), c("http://WWW.PTT.CC/bbs/Test/G.1600000000.A.0AF.html"))
        // LINE／Telegram 分享常帶追蹤參數或錨點：只看路徑。
        assertEquals(Article("C_Chat/M.1700000000.A.123.html"), c("https://www.ptt.cc/bbs/C_Chat/M.1700000000.A.123.html?utm_source=line#f1"))
    }

    @Test fun pttNonArticleIsHandedBack() {
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/Gossiping/index.html"))
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/Gossiping/"))
        assertEquals(NotOurs, c("https://www.ptt.cc/ask/over18?from=%2Fbbs%2FGossiping%2FM.1.A.html"))
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5e3.html")) // hex 必須大寫
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/Gossiping/M.abc.A.5E3.html"))
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/a/b/M.1786265274.A.5E3.html"))
        assertEquals(NotOurs, c("https://ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html"))
    }

    @Test fun pttBoardNameIsChecked() {
        // 看板名會被網頁原樣送進 s<board>\r：多一個字元就是多一個按鍵。
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/Go%20ssiping/M.1786265274.A.5E3.html"))
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/_bad/M.1786265274.A.5E3.html"))
        assertEquals(NotOurs, c("https://www.ptt.cc/bbs/A/M.1786265274.A.5E3.html"))
    }

    @Test fun ownSitePassesFragmentThrough() {
        assertEquals(Article("Gossiping/M.1786265274.A.5E3.html"), c("https://abccbaandy.github.io/PttChrome/#Gossiping/M.1786265274.A.5E3.html"))
        assertEquals(Article("Gossiping/1gIeu-3A"), c("https://abccbaandy.github.io/PttChrome#Gossiping/1gIeu-3A"))
        assertEquals(Article("aid=1gIeu-3A&board=Gossiping"), c("https://abccbaandy.github.io/PttChrome/index.html#aid=1gIeu-3A&board=Gossiping"))
    }

    @Test fun ownSiteQueryBecomesHashForm() {
        assertEquals(Article("board=Gossiping&aid=1gIeu-3A"), c("https://abccbaandy.github.io/PttChrome/?aid=1gIeu-3A&board=Gossiping"))
    }

    @Test fun ownSiteWithoutArticleJustOpensApp() {
        assertEquals(OpenApp, c("https://abccbaandy.github.io/PttChrome/"))
        assertEquals(OpenApp, c("https://abccbaandy.github.io/PttChrome/#"))
        assertEquals(OpenApp, c("https://abccbaandy.github.io/PttChrome/?board=Gossiping"))
    }

    @Test fun otherPagesOnSameHostAreNotOurs() {
        assertEquals(NotOurs, c("https://abccbaandy.github.io/"))
        assertEquals(NotOurs, c("https://abccbaandy.github.io/Other/#Gossiping/1gIeu-3A"))
        assertEquals(NotOurs, c("https://abccbaandy.github.io/PttChrome/assets/x.js"))
        assertEquals(NotOurs, c("http://abccbaandy.github.io/PttChrome/#Gossiping/1gIeu-3A"))
    }

    @Test fun productionLinkIsOwnSiteRegardlessOfDevMode() {
        // MainActivity 一律用預設 pageUrl：App 在 dev server 模式下點正式版連結仍在 App 內跳文
        //（模擬器實測：舊版拿當前來源判定，dev 模式下本站連結全被交給瀏覽器）。
        assertEquals(Article("Gossiping/1gIeu-3A"), DeepLink.classify("https://abccbaandy.github.io/PttChrome/#Gossiping/1gIeu-3A"))
        // pageUrl 參數只是讓判定規則可測：換個頁面網址，規則一樣成立。
        assertEquals(Article("Gossiping/1gIeu-3A"), c("http://localhost:8080/#Gossiping/1gIeu-3A", "http://localhost:8080/"))
        assertEquals(NotOurs, c("http://localhost:8081/#Gossiping/1gIeu-3A", "http://localhost:8080/"))
    }

    @Test fun warmNavigationReplacesInsteadOfPushingHistory() {
        // 手機實測：`location.hash =` 每次多疊一筆 entry 蓋在返回鍵 sentinel 上，下一次返回被無聲吞掉。
        val js = DeepLink.hashNavigationJs("Gossiping/M.1786265274.A.5E3.html")
        assertEquals("location.replace(\"#Gossiping/M.1786265274.A.5E3.html\")", js)
        assertEquals(false, js.contains("location.hash"))
    }

    @Test fun fragmentCannotBreakOutOfJsString() {
        assertEquals("\"a\\\"b\\\\c\"", DeepLink.jsString("a\"b\\c"))
        assertEquals("\"x\\u000a\\u2028y\"", DeepLink.jsString("x\n\u2028y"))
        assertEquals("\"\\u003c/script\\u003e\"", DeepLink.jsString("</script>"))
        // 本站連結 fragment 原樣轉交（含 % 編碼與 &=）。
        assertEquals("\"#aid=1gIeu-3A&board=%E5%85%AB\"", DeepLink.jsString("#aid=1gIeu-3A&board=%E5%85%AB"))
    }

    // P69 分享選單：別的 App 丟過來的是一段文字（標題＋網址、整段訊息），不是單一網址。
    private fun share(text: String?) = DeepLink.fromSharedText(text)

    @Test fun sharedTextFindsFirstArticleLink() {
        val fr = Article("Gossiping/M.1786265274.A.5E3.html")
        assertEquals(fr, share("https://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html"))
        assertEquals(fr, share("[問卦] 有沒有分享的八卦？\nhttps://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html"))
        // LINE 的訊息：網址黏著全形字、句尾標點、括號
        assertEquals(fr, share("看這篇https://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html。好扯"))
        assertEquals(fr, share("(https://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html)."))
        // 前面的網址接不住就看下一個
        assertEquals(fr, share("https://example.com/x https://www.ptt.cc/bbs/Gossiping/index.html https://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html"))
        // 本站分享出去的連結也吃
        assertEquals(fr, share("PttChrome 連結 https://abccbaandy.github.io/PttChrome/#Gossiping/M.1786265274.A.5E3.html"))
    }

    @Test fun sharedTextWithoutArticle() {
        assertEquals(NotOurs, share(null))
        assertEquals(NotOurs, share(""))
        assertEquals(NotOurs, share("沒有連結的一段話"))
        assertEquals(NotOurs, share("https://www.ptt.cc/bbs/Gossiping/index.html"))
        assertEquals(NotOurs, share("https://example.com/M.1786265274.A.5E3.html"))
        // 看板名不合法照樣不收（會被原樣送進 s<board>\r）
        assertEquals(NotOurs, share("https://www.ptt.cc/bbs/_bad/M.1786265274.A.5E3.html"))
        assertEquals(OpenApp, share("推薦這個 https://abccbaandy.github.io/PttChrome/"))
    }

    @Test fun nonWebSchemesAreNotOurs() {
        assertEquals(NotOurs, c("intent://www.ptt.cc/bbs/Gossiping/M.1786265274.A.5E3.html#Intent;end"))
        assertEquals(NotOurs, c("javascript:alert(1)"))
        assertEquals(NotOurs, c("not a url"))
        assertEquals(NotOurs, c(""))
    }
}
