package io.github.abccbaandy.pttchrome

import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import android.util.TypedValue
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.IntentCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.time.LocalDate
import kotlin.coroutines.coroutineContext

/**
 * App 內更新（docs/android-app.md「App 內更新」）：查 GitHub Release → 提示 → 下載 APK → 交給系統安裝。
 * 判斷邏輯在 [UpdateCheck]（JVM test）；這裡只有網路、對話框與 PackageInstaller。
 *
 * - [autoCheck]：每天第一次回到 App 查一次，有新版才出聲；查失敗不記日期，下次回來再查。
 * - [manualCheck]：App 設定的「檢查更新」，每個結果都回報。
 * - 安裝走 PackageInstaller session（不需要 FileProvider）。系統會驗簽章，簽章不同的 APK 裝不上去；
 *   另外先比對 Release 上的大小與 SHA-256，壞檔不送進系統。
 * - 更新會結束整個 App（PTT 連線跟著斷）：提示裡先講，裝完由 [UpdateReceiver] 跳通知帶使用者回來。
 */
internal class AppUpdater(private val activity: ComponentActivity) {
    private val settings = AppSettings(activity)

    fun autoCheck() {
        if (UpdateCheck.parseVersion(BuildConfig.VERSION_NAME) == null) return
        val today = LocalDate.now().toString()
        if (!UpdateCheck.shouldAutoCheck(settings.lastUpdateCheckDay, today) || active) return
        launchExclusive {
            val result = check()
            if (result != null) settings.lastUpdateCheckDay = today
            if (result is UpdateResult.Available) prompt(result.release)
        }
    }

    /** [onStatus]：給設定頁顯示的一行狀態字。 */
    fun manualCheck(onStatus: (String) -> Unit) {
        if (active) return
        onStatus(activity.getString(R.string.update_checking))
        launchExclusive {
            when (val result = check()) {
                null -> onStatus(activity.getString(R.string.update_check_failed))
                UpdateResult.Unsupported -> onStatus(activity.getString(R.string.update_unsupported))
                UpdateResult.UpToDate -> {
                    settings.lastUpdateCheckDay = LocalDate.now().toString()
                    onStatus(activity.getString(R.string.update_up_to_date))
                }
                is UpdateResult.Available -> {
                    onStatus(activity.getString(R.string.update_available_title, result.release.version))
                    prompt(result.release)
                }
            }
        }
    }

    /** 佔住 [active] 直到 block 結束（含被取消、Activity 已銷毀根本沒跑到）。 */
    private fun launchExclusive(block: suspend CoroutineScope.() -> Unit): Job {
        active = true
        return activity.lifecycleScope.launch(block = block).also { job -> job.invokeOnCompletion { active = false } }
    }

    private suspend fun check(): UpdateResult? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder().url(UpdateCheck.RELEASES_API)
                .header("Accept", "application/vnd.github+json")
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "check: HTTP ${response.code}")
                    null
                } else {
                    UpdateCheck.evaluate(BuildConfig.VERSION_NAME, response.body.string())
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // 不只 IOException：這條每天開 App 都會跑，任何意外都只能當「這次沒查到」，不能讓 App 開不起來。
            Log.w(TAG, "check: $e")
            null
        }
    }

    private fun prompt(release: AppRelease) {
        if (activity.isFinishing || activity.isDestroyed) return
        val message = listOf(release.notes, activity.getString(R.string.update_available_hint))
            .filter { it.isNotEmpty() }.joinToString("\n\n")
        AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.update_available_title, release.version))
            .setMessage(message)
            .setPositiveButton(R.string.update_now) { _, _ -> downloadAndInstall(release) }
            .setNegativeButton(R.string.update_later, null)
            .show()
    }

    private fun downloadAndInstall(release: AppRelease) {
        if (active || activity.isFinishing || activity.isDestroyed) return
        val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, activity.resources.displayMetrics).toInt()
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            isIndeterminate = true
        }
        val label = TextView(activity).apply { text = activity.getString(R.string.update_downloading_start) }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(bar)
            addView(label)
        }
        launchExclusive {
            var dialog: AlertDialog? = null
            try {
                dialog = AlertDialog.Builder(activity)
                    .setTitle(activity.getString(R.string.update_downloading_title, release.version))
                    .setView(body)
                    .setCancelable(false)
                    .setNegativeButton(android.R.string.cancel) { _, _ -> cancel() }
                    .show()
                val file = withContext(Dispatchers.IO) {
                    download(release) { percent ->
                        activity.runOnUiThread {
                            bar.isIndeterminate = false
                            bar.progress = percent
                            label.text = activity.getString(R.string.update_downloading_percent, percent)
                        }
                    }
                }
                if (file == null) {
                    toast(R.string.update_download_failed)
                    return@launchExclusive
                }
                bar.isIndeterminate = true
                label.text = activity.getString(R.string.update_installing)
                val committed = withContext(Dispatchers.IO) { install(file) }
                if (!committed) toast(R.string.update_install_failed)
            } finally {
                dialog?.dismiss()
            }
        }
    }

    private fun toast(resId: Int) = Toast.makeText(activity, resId, Toast.LENGTH_LONG).show()

    /** 下載到 App 私有快取並驗證；失敗（網路、大小或 SHA-256 不符）回 null。取消時往外丟 CancellationException。 */
    private suspend fun download(release: AppRelease, onPercent: (Int) -> Unit): File? {
        val dir = File(activity.cacheDir, DOWNLOAD_DIR)
        val file = File(dir, UpdateCheck.APK_NAME)
        try {
            dir.mkdirs()
            file.delete()
            http.newCall(Request.Builder().url(release.apkUrl).build()).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "download: HTTP ${response.code}")
                    return null
                }
                val total = response.body.contentLength().takeIf { it > 0 } ?: release.size
                var done = 0L
                var shown = -1
                response.body.byteStream().use { input ->
                    file.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            done += n
                            if (total > 0) {
                                val percent = (done * 100 / total).toInt().coerceIn(0, 100)
                                if (percent != shown) {
                                    shown = percent
                                    onPercent(percent)
                                }
                            }
                        }
                    }
                }
            }
            if (UpdateCheck.verifyDownload(file, release)) return file
            Log.w(TAG, "download: size or sha256 mismatch")
            file.delete()
            return null
        } catch (e: CancellationException) {
            file.delete()
            throw e
        } catch (e: IOException) {
            Log.w(TAG, "download: $e")
            file.delete()
            return null
        }
    }

    /** APK 寫進 PackageInstaller session 並送出；之後的結果（要使用者確認／成功／失敗）由 [UpdateReceiver] 接。 */
    private fun install(file: File): Boolean {
        val installer = activity.packageManager.packageInstaller
        return try {
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(activity.packageName)
                setSize(file.length())
                // 自己更新自己＋UPDATE_PACKAGES_WITHOUT_USER_ACTION ⇒ 系統可以不再問一次；條件不符時照樣跳系統確認。
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite(UpdateCheck.APK_NAME, 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                // 系統要往這個 intent 塞結果 ⇒ 必須 MUTABLE；指名元件（explicit），別的 App 攔不到。
                val status = PendingIntent.getBroadcast(
                    activity, sessionId,
                    Intent(activity, UpdateReceiver::class.java).setAction(UpdateReceiver.ACTION_INSTALL_STATUS),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(status.intentSender)
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "install: $e")
            false
        } finally {
            file.delete()
        }
    }

    companion object {
        private const val TAG = "PttChromeUpdate"
        private const val DOWNLOAD_DIR = "update"

        /** 同一時間只跑一個檢查／下載（主畫面與設定頁共用）。 */
        @Volatile
        private var active = false

        private val http by lazy { OkHttpClient() }
    }
}

/**
 * 安裝結果與「更新完成」。
 * - [ACTION_INSTALL_STATUS]：PackageInstaller 的回報。要使用者確認（第一次要先允許「安裝不明應用程式」）
 *   就把系統的確認畫面開起來；失敗跳 Toast。成功時 process 已被系統換掉，收不到。
 * - `MY_PACKAGE_REPLACED`：新版裝好了。更新會把 App 關掉，背景不能自己開畫面 ⇒ 跳一則通知讓使用者點回來。
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_INSTALL_STATUS -> onInstallStatus(context, intent)
            Intent.ACTION_MY_PACKAGE_REPLACED -> UpdateNotifier.postUpdated(context)
        }
    }

    private fun onInstallStatus(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
                try {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    Log.w(TAG, "confirm: $e")
                    Toast.makeText(context, R.string.update_install_failed, Toast.LENGTH_LONG).show()
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            // 使用者在系統確認畫面按取消：不是錯誤，不吵。
            PackageInstaller.STATUS_FAILURE_ABORTED -> Unit
            else -> {
                Log.w(TAG, "install status=$status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                Toast.makeText(context, R.string.update_install_failed, Toast.LENGTH_LONG).show()
            }
        }
    }

    companion object {
        private const val TAG = "PttChromeUpdate"
        const val ACTION_INSTALL_STATUS = "io.github.abccbaandy.pttchrome.UPDATE_INSTALL_STATUS"
    }
}

internal object UpdateNotifier {
    private const val CHANNEL = "app_update"
    private const val NOTIFICATION_ID = 3

    fun postUpdated(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.notif_update_channel), NotificationManager.IMPORTANCE_DEFAULT)
        )
        val open = PendingIntent.getActivity(
            context, NOTIFICATION_ID,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setContentTitle(context.getString(R.string.notif_updated_title, BuildConfig.VERSION_NAME))
            .setContentText(context.getString(R.string.notif_updated_text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        // POST_NOTIFICATIONS 被拒時系統直接丟掉；通知只是帶路，失敗不影響更新本身。
        try {
            nm.notify(NOTIFICATION_ID, n)
        } catch (_: SecurityException) {
        }
    }

    /** 使用者已經回到 App（自己開的，或裝完按「開啟」）：通知收掉。 */
    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }
}
