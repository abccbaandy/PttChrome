package io.github.abccbaandy.pttchrome

import org.json.JSONArray
import org.json.JSONException
import java.io.File
import java.security.MessageDigest

/**
 * App 更新的純邏輯（docs/android-app.md「App 內更新」；JVM `UpdateCheckTest`）：
 * GitHub Releases API 的回應 → 最新一版 → 跟目前版本比。下載與安裝在 [AppUpdater]。
 *
 * 來源＝`android.yml` 自動發的 Release：tag `android-v<x.y.z>`＋附件 `pttchrome.apk`
 *（`scripts/android-release.mjs`）。不是這個形狀的一律不認。
 */
internal data class AppRelease(
    val version: String,
    val apkUrl: String,
    /** GitHub 算的附件 SHA-256（hex）；舊 Release 沒有這個欄位時是 null。 */
    val sha256: String?,
    val size: Long,
    val notes: String,
)

internal sealed interface UpdateResult {
    /** 目前不是正式發佈的版本（debug／CI 的 dev build）：簽章不同裝不上去，不檢查。 */
    data object Unsupported : UpdateResult
    data object UpToDate : UpdateResult
    data class Available(val release: AppRelease) : UpdateResult
}

internal object UpdateCheck {
    const val RELEASES_API = "https://api.github.com/repos/abccbaandy/PttChrome/releases?per_page=30"
    const val TAG_PREFIX = "android-v"
    const val APK_NAME = "pttchrome.apk"

    /** 附件網址只認本 repo 的 Release 下載路徑：API 回應被動手腳也不會去別處抓 APK。 */
    const val DOWNLOAD_PREFIX = "https://github.com/abccbaandy/PttChrome/releases/download/"

    /** release note 尾段固定的安裝步驟（`scripts/android-release.mjs#INSTALL_SECTION`）：App 內不必顯示。 */
    const val INSTALL_HEADING = "## 安裝／更新"

    private const val MAX_NOTES = 1200
    private val VERSION = Regex("""(\d{1,9})\.(\d{1,9})\.(\d{1,9})""")

    /** 只收 `x.y.z`：`1.0.0-debug`、`0.0.12-dev` 都不是正式版。 */
    fun parseVersion(name: String): List<Int>? =
        VERSION.matchEntire(name.trim())?.groupValues?.drop(1)?.map { it.toInt() }

    fun compareVersions(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until 3) if (a[i] != b[i]) return a[i].compareTo(b[i])
        return 0
    }

    /** Releases API 的 JSON → 版號最大的一版（草稿、prerelease、沒有 APK 的都跳過）；回應不成形 ⇒ null。 */
    fun latestRelease(json: String): AppRelease? {
        val list = try {
            JSONArray(json)
        } catch (_: JSONException) {
            return null
        }
        var best: AppRelease? = null
        var bestVersion: List<Int>? = null
        for (i in 0 until list.length()) {
            val r = list.optJSONObject(i) ?: continue
            if (r.optBoolean("draft") || r.optBoolean("prerelease")) continue
            val tag = r.optString("tag_name")
            if (!tag.startsWith(TAG_PREFIX)) continue
            val version = parseVersion(tag.removePrefix(TAG_PREFIX)) ?: continue
            val assets = r.optJSONArray("assets") ?: continue
            val apk = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }
                .firstOrNull { it.optString("name") == APK_NAME } ?: continue
            val url = apk.optString("browser_download_url")
            if (!url.startsWith(DOWNLOAD_PREFIX)) continue
            if (bestVersion != null && compareVersions(version, bestVersion) <= 0) continue
            bestVersion = version
            best = AppRelease(
                version = version.joinToString("."),
                apkUrl = url,
                sha256 = parseDigest(apk.optString("digest")),
                size = apk.optLong("size", -1),
                notes = releaseNotes(if (r.isNull("body")) "" else r.optString("body")),
            )
        }
        return best
    }

    fun evaluate(currentVersion: String, releasesJson: String): UpdateResult? {
        val current = parseVersion(currentVersion) ?: return UpdateResult.Unsupported
        val latest = latestRelease(releasesJson) ?: return null
        val newer = compareVersions(parseVersion(latest.version)!!, current) > 0
        return if (newer) UpdateResult.Available(latest) else UpdateResult.UpToDate
    }

    /** `sha256:<64 hex>` → 小寫 hex；其他演算法或壞掉的值當作沒有。 */
    fun parseDigest(digest: String): String? {
        val hex = digest.trim().lowercase().removePrefix("sha256:")
        return hex.takeIf { digest.trim().lowercase().startsWith("sha256:") && Regex("[0-9a-f]{64}").matches(it) }
    }

    /** release note（markdown）→ 對話框用的純文字：去掉固定的安裝步驟、`## ` 標題記號，過長截斷。 */
    fun releaseNotes(body: String): String {
        val text = body.replace("\r\n", "\n").substringBefore(INSTALL_HEADING)
            .lines().joinToString("\n") { it.replace(Regex("^#+\\s*"), "").replace(Regex("^- "), "• ").trimEnd() }
            .replace(Regex("\\n{3,}"), "\n\n").trim()
        return if (text.length <= MAX_NOTES) text else text.take(MAX_NOTES).trimEnd() + "…"
    }

    /** 每天第一次回到 App 才自動檢查；`today` 是本機日期字串。 */
    fun shouldAutoCheck(lastCheckDay: String?, today: String): Boolean = lastCheckDay != today

    /** 下載完的檔案是不是 Release 上那一份：大小＋SHA-256（有給的話）。 */
    fun verifyDownload(file: File, release: AppRelease): Boolean {
        if (!file.isFile || file.length() == 0L) return false
        if (release.size > 0 && file.length() != release.size) return false
        val expected = release.sha256 ?: return true
        return sha256Hex(file) == expected
    }

    fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
