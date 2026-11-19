package io.github.abccbaandy.pttchrome

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.Base64

/**
 * bridge 'fetchImage'（P107 離線文章連圖片一起存，只做 APK；docs/saved-articles.md「還沒做 1.」）：
 * 原生抓圖不受 CORS 限制（i.meee、i.urusai 這類沒 ACAO 的圖床網頁抓不到），縮成寬 ≤ [MAX_WIDTH] 的 WebP 回給網頁存進 IndexedDB。
 *
 * 只收 https（network_security_config 不准明文；網頁端 saved_image_pick.js 已把已知圖床改寫成 https）。
 * GIF 不收（縮了就不會動，動輒十幾 MB）。下載與判斷是純 JVM（`ImageFetchTest`），縮圖編碼在 [encodeWebp]（要 Android）。
 */
internal object ImageFetch {
    const val TIMEOUT_MS = 15_000
    /** 整張圖（連線＋讀完）的總時限：readTimeout 只管單次讀取，對方每次吐一點就能一直占著。 */
    const val TOTAL_TIMEOUT_MS = 30_000L
    /** 原圖上限：超過就中止（不讀完）。 */
    const val MAX_BYTES = 8 * 1024 * 1024
    const val MAX_WIDTH = 1080
    /** WebP 單邊上限（libwebp 16383）：縮完還超過的長截圖不存，解碼前就擋下。 */
    const val MAX_HEIGHT = 16383
    /** 解碼後的像素上限（ARGB 每像素 4 bytes ⇒ ~48 MB）：又高又窄的圖只看寬度算倍率會解出好幾百 MB。 */
    const val MAX_DECODE_PIXELS = 12_000_000L
    const val WEBP_QUALITY = 80
    /** 回給網頁的 WebP 上限：WebMessage 是一整串 base64 字串，太大的不送。 */
    const val MAX_OUTPUT_BYTES = 2 * 1024 * 1024

    sealed interface Download {
        class Ok(val bytes: ByteArray) : Download
        data class Failed(val error: String) : Download
    }

    /** 只收 https、要有 host、不帶帳密。 */
    fun acceptsUrl(url: String): Boolean {
        val u = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        return u.scheme.equals("https", ignoreCase = true) && !u.host.isNullOrEmpty() && u.rawUserInfo == null
    }

    /** `image/` 開頭但不是 GIF；沒給 Content-Type 不收（多半是錯誤頁）。 */
    fun acceptsContentType(contentType: String?): Boolean {
        val type = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return false
        return type.startsWith("image/") && type != "image/gif"
    }

    /**
     * BitmapFactory 的 inSampleSize：2 的次方，縮完寬度仍 ≥ maxWidth（之後再精確縮到 maxWidth）；
     * 解碼後像素超過 [MAX_DECODE_PIXELS] 就再加倍（寧可糊一點也不要 OOM）。
     */
    fun sampleSize(width: Int, height: Int = 1, maxWidth: Int = MAX_WIDTH): Int {
        var sample = 1
        while (width / (sample * 2) >= maxWidth) sample *= 2
        while ((width / sample).toLong() * (height / sample) > MAX_DECODE_PIXELS) sample *= 2
        return sample
    }

    /** 原圖尺寸 → 縮完的尺寸；縮完高度還超過 [MAX_HEIGHT]（WebP 編不出來）回 null。 */
    fun outputSize(width: Int, height: Int): Pair<Int, Int>? {
        if (width <= 0 || height <= 0) return null
        val sample = sampleSize(width, height)
        val out = scaledSize(width / sample, height / sample)
        return if (out.second > MAX_HEIGHT || out.first <= 0) null else out
    }

    /** 精確縮放後的尺寸：寬 ≤ maxWidth，等比例，至少 1px。 */
    fun scaledSize(width: Int, height: Int, maxWidth: Int = MAX_WIDTH): Pair<Int, Int> {
        if (width <= maxWidth) return width to height
        val h = (height.toLong() * maxWidth / width).toInt().coerceAtLeast(1)
        return maxWidth to h
    }

    /**
     * 下載原圖。redirect 只跟到 https（HttpURLConnection 本來就不跨協定跟）；最後落點不是 https 就不收。
     * error：'url'／'http'（非 2xx）／'type'（不是靜態圖）／'tooLarge'／'network'。
     */
    fun download(
        url: String,
        maxBytes: Int = MAX_BYTES,
        totalTimeoutMs: Long = TOTAL_TIMEOUT_MS,
        /** 測試用：本機 MockWebServer 是 http。正式呼叫一律 true。 */
        requireHttps: Boolean = true,
        open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    ): Download {
        if (requireHttps && !acceptsUrl(url)) return Download.Failed("url")
        val conn = try {
            open(URL(url))
        } catch (_: Exception) {
            return Download.Failed("network")
        }
        val deadline = System.nanoTime() + totalTimeoutMs * 1_000_000
        try {
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("Accept", "image/webp,image/png,image/jpeg,image/*;q=0.8")
            val code = conn.responseCode
            if (code !in 200..299) return Download.Failed("http")
            if (requireHttps && !conn.url.protocol.equals("https", ignoreCase = true)) return Download.Failed("url")
            if (!acceptsContentType(conn.contentType)) return Download.Failed("type")
            val declared = conn.contentLengthLong
            if (declared > maxBytes) return Download.Failed("tooLarge")
            val out = ByteArrayOutputStream(if (declared in 1..maxBytes) declared.toInt() else 64 * 1024)
            val buf = ByteArray(16 * 1024)
            conn.inputStream.use { input ->
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (out.size() + n > maxBytes) return Download.Failed("tooLarge")
                    if (System.nanoTime() > deadline) return Download.Failed("network")
                    out.write(buf, 0, n)
                }
            }
            return Download.Ok(out.toByteArray())
        } catch (_: IOException) {
            return Download.Failed("network")
        } finally {
            conn.disconnect()
        }
    }

    /** bridge 回覆：成功 { ok, mime, data(base64), w, h }；失敗 { ok:false, error }。 */
    fun reply(id: Int, webp: ByteArray, width: Int, height: Int): JSONObject =
        if (webp.size > MAX_OUTPUT_BYTES) {
            failed(id, "tooLarge")
        } else {
            JSONObject().put("id", id).put("ok", true).put("mime", "image/webp")
                .put("data", Base64.getEncoder().encodeToString(webp)).put("w", width).put("h", height)
        }

    fun failed(id: Int, error: String): JSONObject = JSONObject().put("id", id).put("ok", false).put("error", error)

    /** 抓圖＋縮圖的整條（在 IO 執行緒呼叫）。 */
    fun fetch(id: Int, url: String): JSONObject {
        val bytes = when (val d = download(url)) {
            is Download.Failed -> return failed(id, d.error)
            is Download.Ok -> d.bytes
        }
        val encoded = encodeWebp(bytes) ?: return failed(id, "decode")
        return reply(id, encoded.first, encoded.second, encoded.third)
    }

    /** 原圖 bytes → (WebP bytes, 寬, 高)；解不開回 null。 */
    private fun encodeWebp(bytes: ByteArray): Triple<ByteArray, Int, Int>? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        outputSize(bounds.outWidth, bounds.outHeight) ?: return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight) }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        val (w, h) = scaledSize(decoded.width, decoded.height)
        val bitmap = if (w == decoded.width) decoded else Bitmap.createScaledBitmap(decoded, w, h, true)
        try {
            val out = ByteArrayOutputStream()
            @Suppress("DEPRECATION")
            val format = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
            if (!bitmap.compress(format, WEBP_QUALITY, out)) return null
            return Triple(out.toByteArray(), w, h)
        } finally {
            if (bitmap !== decoded) bitmap.recycle()
            decoded.recycle()
        }
    }
}
