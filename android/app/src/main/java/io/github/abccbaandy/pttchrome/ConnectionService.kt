package io.github.abccbaandy.pttchrome

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.security.SecureRandom

/**
 * 前景服務：持有 [LocalWebSocketProxy]（也就是持有到 PTT 的連線本體）。
 * 有前景服務的 process 不會在切到背景幾秒後被系統凍結／砍連線，這是整個 APK 存在的理由。
 *
 * 生命週期：MainActivity 開啟時 start＋bind；使用者從通知按「中斷連線並關閉」或
 * Activity 真的結束（isFinishing）時停掉。
 */
class ConnectionService : Service() {
    inner class LocalBinder : Binder() {
        val service: ConnectionService get() = this@ConnectionService
    }

    private val binder = LocalBinder()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var proxy: LocalWebSocketProxy

    /** MainActivity 綁上時設定：通知的「中斷連線並關閉」要連畫面一起收掉。 */
    var onQuitRequested: (() -> Unit)? = null

    val site: String get() = proxy.site

    override fun onCreate() {
        super.onCreate()
        createChannel()
        proxy = LocalWebSocketProxy(
            token = randomToken(),
            onStateChanged = { n -> main.post { updateNotification(n > 0) } },
            onEvent = BootTrace::mark,
        )
        proxy.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_QUIT) {
            proxy.disconnectAll()
            onQuitRequested?.invoke()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val n = notification(proxy.activeSessions > 0)
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
        // 被系統砍掉後不要自己復活：WebView（網頁端狀態）已經不在，空有 proxy 沒有意義。
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        proxy.close()
        super.onDestroy()
    }

    private fun updateNotification(connected: Boolean) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, notification(connected))
    }

    private fun notification(connected: Boolean): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val quit = PendingIntent.getService(
            this, 1,
            Intent(this, ConnectionService::class.java).setAction(ACTION_QUIT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(if (connected) R.string.notif_connected else R.string.notif_idle))
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, getString(R.string.notif_disconnect), quit).build())
            .build()
    }

    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(ch)
    }

    private fun randomToken(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val ACTION_QUIT = "io.github.abccbaandy.pttchrome.QUIT"
        private const val CHANNEL = "ptt_connection"
        private const val NOTIFICATION_ID = 1
    }
}
