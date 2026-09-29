package io.github.abccbaandy.pttchrome

import android.app.Activity
import android.util.Log
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPasswordOption
import androidx.credentials.PasswordCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import org.json.JSONObject

/**
 * Google 密碼管理員（Android Credential Manager）→ 網頁的 bridge 後端。
 *
 * Android WebView 沒有 `PasswordCredential`／`navigator.credentials`，網頁版的自動登入在 WebView
 * 裡永遠拿不到密碼；所以改由原生取密碼再交給網頁（src/js/credential_store.js）。
 * 密碼字串原樣傳遞：2FA 密鑰的打包／解包在網頁的 credential_pack.js，Chrome 與 APK 讀寫同一筆。
 *
 * 訊息合約見 src/js/android_bridge.js 檔頭。
 */
class CredentialBridge(private val activity: Activity) {
    private val manager = CredentialManager.create(activity)

    /** 回傳要 postMessage 回網頁的 JSON 字串。 */
    suspend fun handle(request: JSONObject): String {
        val id = request.optInt("id")
        val reply = JSONObject().put("id", id)
        when (request.optString("op")) {
            "getPassword" -> try {
                val result = manager.getCredential(activity, GetCredentialRequest(listOf(GetPasswordOption())))
                val cred = result.credential
                if (cred is PasswordCredential) {
                    reply.put("ok", true).put("user", cred.id).put("password", cred.password)
                } else {
                    reply.put("ok", false)
                }
            } catch (e: NoCredentialException) {
                // 密碼管理員裡沒有這個網站／App 的密碼：網頁退回本機明文（legacy）路徑，
                // 登入成功後會再呼叫 storePassword 請使用者存起來。
                reply.put("ok", false)
            } catch (e: GetCredentialException) {
                // 使用者取消等：同上。
                Log.i(TAG, "getPassword: ${e.type}")
                reply.put("ok", false)
            }
            "storePassword" -> {
                val user = request.optString("user")
                val password = request.optString("password")
                if (user.isEmpty() || password.isEmpty()) {
                    reply.put("ok", false)
                } else try {
                    manager.createCredential(activity, CreatePasswordRequest(user, password))
                    reply.put("ok", true)
                } catch (e: CreateCredentialException) {
                    Log.i(TAG, "storePassword: ${e.type}")
                    reply.put("ok", false)
                }
            }
            else -> reply.put("ok", false).put("error", "unknown op")
        }
        return reply.toString()
    }

    private companion object {
        const val TAG = "PttCredentialBridge"
    }
}
