package io.github.abccbaandy.pttchrome

import android.app.Activity
import android.util.Log
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPasswordOption
import androidx.credentials.PasswordCredential
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import org.json.JSONObject

/**
 * Android Credential Manager → 網頁的 bridge 後端：Google 密碼管理員（自動登入）與
 * 雲端同步的 Google 登入（ID token）。
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
            "googleSignIn" -> googleSignIn(request.optString("serverClientId"), reply)
            "googleSignOut" -> try {
                manager.clearCredentialState(ClearCredentialStateRequest())
                reply.put("ok", true)
            } catch (e: ClearCredentialException) {
                Log.i(TAG, "googleSignOut: ${e.type}")
                reply.put("ok", false)
            }
            else -> reply.put("ok", false).put("error", "unknown op")
        }
        return reply.toString()
    }

    /**
     * 雲端同步的 Google 登入：WebView 內不准做 OAuth（disallowed_useragent），由原生取 Google ID
     * token，網頁再 `signInWithCredential` 交給 Firebase（src/js/google_sign_in.js）。
     * serverClientId 必須是 Firebase Google provider 的 Web client，token 的 aud 才會被接受；
     * 另外 Google Cloud 同專案要有本 App（package＋簽章 SHA-1）的 Android OAuth client，
     * 否則 Credential Manager 回 developer error（docs/android-app.md「雲端同步 Google 登入」）。
     */
    private suspend fun googleSignIn(serverClientId: String, reply: JSONObject) {
        if (!isGoogleWebClientId(serverClientId)) {
            reply.put("ok", false).put("error", "badClientId")
            return
        }
        try {
            // 使用者按了「登入」才會走到這裡 ⇒ 用明確的「使用 Google 帳戶登入」流程（會列出裝置上所有帳號），
            // 不用 GetGoogleIdOption 的「只列授權過的帳號」靜默流程。
            val option = GetSignInWithGoogleOption.Builder(serverClientId).build()
            val cred = manager.getCredential(activity, GetCredentialRequest(listOf(option))).credential
            if (cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                reply.put("ok", true).put("idToken", GoogleIdTokenCredential.createFrom(cred.data).idToken)
            } else {
                Log.w(TAG, "googleSignIn: unexpected credential ${cred.type}")
                reply.put("ok", false).put("error", "failed")
            }
        } catch (e: GetCredentialCancellationException) {
            reply.put("ok", false).put("error", "cancelled")
        } catch (e: GetCredentialException) {
            // 含 Android OAuth client 沒註冊（訊息帶 "developer console is not set up correctly"）。
            Log.w(TAG, "googleSignIn: ${e.type} ${e.message}")
            reply.put("ok", false).put("error", "failed")
        } catch (e: GoogleIdTokenParsingException) {
            Log.w(TAG, "googleSignIn: token parse", e)
            reply.put("ok", false).put("error", "failed")
        }
    }

    private companion object {
        const val TAG = "PttCredentialBridge"
    }
}

private val GOOGLE_WEB_CLIENT_ID = Regex("""\d+-[a-z0-9]+\.apps\.googleusercontent\.com""")

/** bridge 只收 OAuth client id 形狀的 serverClientId（網頁端常數 firebase_config.js#GOOGLE_WEB_CLIENT_ID）。 */
internal fun isGoogleWebClientId(id: String): Boolean = GOOGLE_WEB_CLIENT_ID.matches(id)
