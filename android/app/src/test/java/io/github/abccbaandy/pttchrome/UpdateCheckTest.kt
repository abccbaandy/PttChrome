package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UpdateCheckTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val sha = "ef0510211d2e30d6187ee8201bd90d1acb83c63a0d239f2c26a4135cf655521b"

    /** GitHub Releases API 一筆 release 的形狀（欄位取自真實回應，只留用到的）。 */
    private fun release(
        tag: String,
        draft: Boolean = false,
        prerelease: Boolean = false,
        asset: String = "pttchrome.apk",
        url: String = "https://github.com/abccbaandy/PttChrome/releases/download/$tag/pttchrome.apk",
        digest: String? = "sha256:$sha",
        body: String = "## 新功能\\n- 分享到 PttChrome\\n\\n## 安裝／更新\\n1. 用 Android 手機下載下面的 `pttchrome.apk`。\\n",
    ) = """
        {"tag_name":"$tag","draft":$draft,"prerelease":$prerelease,"body":"$body",
         "assets":[{"name":"$asset","size":1079196,"browser_download_url":"$url","digest":${digest?.let { "\"$it\"" } ?: "null"}}]}
    """.trimIndent()

    private fun api(vararg releases: String) = releases.joinToString(",", "[", "]")

    @Test
    fun parsesOnlyReleaseVersions() {
        assertEquals(listOf(1, 4, 0), UpdateCheck.parseVersion("1.4.0"))
        assertEquals(listOf(1, 10, 2), UpdateCheck.parseVersion(" 1.10.2 "))
        listOf("1.0.0-debug", "0.0.12-dev", "1.4", "v1.4.0", "", "1.4.0.1").forEach {
            assertNull(it, UpdateCheck.parseVersion(it))
        }
    }

    @Test
    fun comparesNumericallyNotAsText() {
        assertTrue(UpdateCheck.compareVersions(listOf(1, 10, 0), listOf(1, 9, 9)) > 0)
        assertTrue(UpdateCheck.compareVersions(listOf(1, 4, 0), listOf(1, 4, 1)) < 0)
        assertEquals(0, UpdateCheck.compareVersions(listOf(2, 0, 0), listOf(2, 0, 0)))
    }

    @Test
    fun picksHighestVersionRegardlessOfOrder() {
        val r = UpdateCheck.latestRelease(api(release("android-v1.9.0"), release("android-v1.10.0"), release("android-v1.2.1")))!!
        assertEquals("1.10.0", r.version)
        assertEquals("https://github.com/abccbaandy/PttChrome/releases/download/android-v1.10.0/pttchrome.apk", r.apkUrl)
        assertEquals(sha, r.sha256)
        assertEquals(1079196L, r.size)
        assertEquals("新功能\n• 分享到 PttChrome", r.notes)
    }

    @Test
    fun skipsDraftsPrereleasesOtherTagsAndReleasesWithoutApk() {
        val json = api(
            release("android-v9.0.0", draft = true),
            release("android-v8.0.0", prerelease = true),
            release("v7.0.0"),
            release("android-v6.0.0-test"),
            release("android-v5.0.0", asset = "notes.txt"),
            release("android-v1.4.0"),
        )
        assertEquals("1.4.0", UpdateCheck.latestRelease(json)!!.version)
    }

    @Test
    fun refusesApkHostedOutsideThisRepo() {
        val json = api(
            release("android-v9.0.0", url = "https://evil.example/pttchrome.apk"),
            release("android-v8.0.0", url = "https://github.com/someone/else/releases/download/android-v8.0.0/pttchrome.apk"),
            release("android-v7.0.0", url = "http://github.com/abccbaandy/PttChrome/releases/download/android-v7.0.0/pttchrome.apk"),
        )
        assertNull(UpdateCheck.latestRelease(json))
    }

    @Test
    fun malformedResponsesGiveNull() {
        listOf("", "not json", "{\"message\":\"API rate limit exceeded\"}", "[]", "[1,\"x\",null]").forEach {
            assertNull(it, UpdateCheck.latestRelease(it))
            assertNull(it, UpdateCheck.evaluate("1.4.0", it))
        }
    }

    @Test
    fun evaluateComparesWithInstalledVersion() {
        val json = api(release("android-v1.4.0"), release("android-v1.3.0"))
        assertEquals("1.4.0", (UpdateCheck.evaluate("1.3.0", json) as UpdateResult.Available).release.version)
        assertEquals(UpdateResult.UpToDate, UpdateCheck.evaluate("1.4.0", json))
        // 裝的比 Release 新（剛發版、API 還沒看到）不算有更新。
        assertEquals(UpdateResult.UpToDate, UpdateCheck.evaluate("1.5.0", json))
    }

    @Test
    fun devAndDebugBuildsAreUnsupported() {
        val json = api(release("android-v1.4.0"))
        assertEquals(UpdateResult.Unsupported, UpdateCheck.evaluate("1.0.0-debug", json))
        assertEquals(UpdateResult.Unsupported, UpdateCheck.evaluate("0.0.321-dev", json))
    }

    @Test
    fun digestOnlyAcceptsSha256() {
        assertEquals(sha, UpdateCheck.parseDigest("sha256:$sha"))
        assertEquals(sha, UpdateCheck.parseDigest("SHA256:${sha.uppercase()}"))
        listOf("", "null", sha, "sha1:$sha", "sha256:abc", "sha256:${sha}00").forEach {
            assertNull(it, UpdateCheck.parseDigest(it))
        }
        assertNull(UpdateCheck.latestRelease(api(release("android-v1.4.0", digest = null)))!!.sha256)
    }

    @Test
    fun notesDropInstallSectionAndMarkdownMarks() {
        val body = "## 新功能\n- A\n- B\n\n## 修正與改進\n- C\n\n## 安裝／更新\n1. 下載\n2. 安裝\n"
        assertEquals("新功能\n• A\n• B\n\n修正與改進\n• C", UpdateCheck.releaseNotes(body))
        assertEquals("", UpdateCheck.releaseNotes("## 安裝／更新\n1. 下載"))
        assertEquals("", UpdateCheck.releaseNotes(""))
        val long = UpdateCheck.releaseNotes("x".repeat(5000))
        assertTrue(long.length <= 1201 && long.endsWith("…"))
    }

    @Test
    fun autoCheckOncePerDay() {
        assertTrue(UpdateCheck.shouldAutoCheck(null, "2026-11-12"))
        assertTrue(UpdateCheck.shouldAutoCheck("2026-11-11", "2026-11-12"))
        assertFalse(UpdateCheck.shouldAutoCheck("2026-11-12", "2026-11-12"))
    }

    @Test
    fun verifiesDownloadedFileAgainstRelease() {
        val file = tmp.newFile("pttchrome.apk").apply { writeBytes("hello".toByteArray()) }
        val hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        assertEquals(hello, UpdateCheck.sha256Hex(file))
        fun rel(sha256: String?, size: Long) = AppRelease("1.4.0", "u", sha256, size, "")
        assertTrue(UpdateCheck.verifyDownload(file, rel(hello, 5)))
        // 舊 Release 沒有 digest：只比大小；大小也沒有就只要求非空檔。
        assertTrue(UpdateCheck.verifyDownload(file, rel(null, 5)))
        assertTrue(UpdateCheck.verifyDownload(file, rel(null, -1)))
        assertFalse(UpdateCheck.verifyDownload(file, rel(hello, 6)))
        assertFalse(UpdateCheck.verifyDownload(file, rel(sha, 5)))
        assertFalse(UpdateCheck.verifyDownload(tmp.newFile("empty.apk"), rel(null, -1)))
        assertFalse(UpdateCheck.verifyDownload(java.io.File(tmp.root, "missing.apk"), rel(null, -1)))
    }
}
