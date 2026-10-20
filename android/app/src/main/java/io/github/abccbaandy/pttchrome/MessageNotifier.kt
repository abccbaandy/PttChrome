package io.github.abccbaandy.pttchrome

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/**
 * bridge 'notify'：水球的系統通知（網頁 term_view.showWaterballNotification 的 APK 分支；
 * WebView 沒有 Web Notification）。網頁每則水球都送（WebView 切到背景不一定有 blur／
 * visibilitychange），**前景與否由原生判斷**：App 在前景就不跳（使用者正看著畫面），
 * 回到前景時把跳過的通知收掉（同網頁版 focus 時 stopTitleFlash 關通知）。
 * 頻道與連線常駐通知分開，使用者能在系統設定單獨關掉水球通知。
 */
internal data class MessageNotice(val title: String, val body: String, val tag: String)

/** 網頁給的內容只當顯示文字：去控制字元、截長度；標題空的就不跳。tag＝寄件人，同一人只留最新一則。 */
internal fun parseNotice(rawTitle: String, rawBody: String, rawTag: String): MessageNotice? {
    fun clean(s: String, max: Int) = s.replace(Regex("\\p{Cntrl}"), " ").trim().take(max)
    val title = clean(rawTitle, MAX_TITLE)
    if (title.isEmpty()) return null
    val body = clean(rawBody, MAX_BODY)
    val tag = clean(rawTag, MAX_TITLE).ifEmpty { title }
    return MessageNotice(title, body, tag)
}

internal fun parseNotice(request: JSONObject): MessageNotice? =
    parseNotice(request.optString("title"), request.optString("body"), request.optString("tag"))

internal object MessageNotifier {
    private const val CHANNEL = "ptt_messages"
    private const val NOTIFICATION_ID = 2

    fun post(context: Context, notice: MessageNotice) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.notif_messages_channel), NotificationManager.IMPORTANCE_HIGH)
        )
        val open = PendingIntent.getActivity(
            context, 2,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setStyle(Notification.BigTextStyle().bigText(notice.body))
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        // POST_NOTIFICATIONS 被拒時系統直接丟掉，不會 throw；保險起見仍包起來（通知失敗不能影響連線）。
        try {
            nm.notify(notice.tag, NOTIFICATION_ID, n)
        } catch (_: SecurityException) {
        }
    }

    /** 回到前景：跳過的水球通知都收掉（只收這個頻道的，連線常駐通知不動）。 */
    fun cancelAll(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.activeNotifications
            .filter { it.id == NOTIFICATION_ID && it.tag != null }
            .forEach { nm.cancel(it.tag, it.id) }
    }
}

private const val MAX_TITLE = 80
private const val MAX_BODY = 400
