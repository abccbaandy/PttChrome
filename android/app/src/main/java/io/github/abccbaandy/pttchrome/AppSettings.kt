package io.github.abccbaandy.pttchrome

import android.content.Context
import androidx.core.content.edit

/**
 * APK 自己的設定（[SettingsActivity]），存在本機 SharedPreferences。
 * 跟網頁的 prefs 無關：不經 pref_sync，不會同步到桌機。
 */
class AppSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var devServerEnabled: Boolean
        get() = prefs.getBoolean(KEY_DEV_ENABLED, false)
        set(v) = prefs.edit { putBoolean(KEY_DEV_ENABLED, v) }

    var devServerUrl: String
        get() = prefs.getString(KEY_DEV_URL, null) ?: PageSource.DEFAULT_DEV_URL
        set(v) = prefs.edit { putString(KEY_DEV_URL, v) }

    /**
     * 連線協議（docs/ssh.md「APK」）：'websocket'（預設）｜'ssh'。網頁的協議 pref 在 APK 不生效：
     * 原生依這個值注入對應的本機 proxy 站台（[ConnectionService.site]）。
     */
    var protocol: String
        get() = AppConfig.normalizeProtocol(prefs.getString(KEY_PROTOCOL, null))
        set(v) = prefs.edit { putString(KEY_PROTOCOL, AppConfig.normalizeProtocol(v)) }

    /** 上次查過更新的本機日期（[AppUpdater.autoCheck]：一天只自動查一次）。 */
    var lastUpdateCheckDay: String?
        get() = prefs.getString(KEY_UPDATE_CHECK_DAY, null)
        set(v) = prefs.edit { putString(KEY_UPDATE_CHECK_DAY, v) }

    /** 區網 IP 只在 debug APK 開放（見 [PageSource]）。 */
    val allowLan: Boolean get() = BuildConfig.DEBUG

    fun pageSource(): PageSource = PageSource.resolve(devServerEnabled, devServerUrl, allowLan)

    private companion object {
        const val FILE = "app_settings"
        const val KEY_DEV_ENABLED = "dev_server_enabled"
        const val KEY_DEV_URL = "dev_server_url"
        const val KEY_PROTOCOL = "connection_protocol"
        const val KEY_UPDATE_CHECK_DAY = "update_last_check_day"
    }
}
