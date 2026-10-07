package io.github.abccbaandy.pttchrome

/**
 * bridge 'saveFile' 的檔名（網頁給的，只當系統「儲存檔案」對話框的預設檔名）：
 * 拿掉路徑分隔與控制字元，空的給預設值，過長截斷（多數檔案系統上限 255 bytes）。
 */
internal fun safeFileName(name: String): String {
    val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trimStart('.')
    val base = cleaned.ifEmpty { "pttchrome.txt" }
    return if (base.length <= MAX_FILE_NAME) base else base.takeLast(MAX_FILE_NAME)
}

private const val MAX_FILE_NAME = 120
