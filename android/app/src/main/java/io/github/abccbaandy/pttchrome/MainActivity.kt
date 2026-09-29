package io.github.abccbaandy.pttchrome

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * WebView 殼：載入線上網頁版，並注入兩樣東西（只給 [AppConfig.PAGE_ORIGIN]）：
 *  - `window.__PTT_ANDROID__`（document-start script）：本機 proxy 的連線位址
 *  - `window.PttAndroid`（WebMessageListener）：密碼管理員 bridge（[CredentialBridge]）
 * 網頁端對應 src/js/android_bridge.js。架構與限制見 docs/android-app.md。
 */
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private var webView: WebView? = null
    private var service: ConnectionService? = null
    private var bound = false
    private val credentials by lazy { CredentialBridge(this) }
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val s = (binder as ConnectionService.LocalBinder).service
            service = s
            s.onQuitRequested = { finishAndRemoveTask() }
            if (webView == null) createWebView(s.site)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        setContentView(root)
        // 系統列、瀏海讓出來；**軟鍵盤刻意不讓**：鍵盤把 WebView 縮小＝layout resize ⇒ 網頁重算
        // 列數、重送 NAWS（docs/mobile.md「軟鍵盤蓋住底列」）。改成鍵盤疊在上面，高度用事件告訴網頁，
        // 網頁走跟手機 Chrome 同一條 keyboardInset 路徑（android_bridge.js 'pttandroid:ime'）。
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            reportImeInset(((ime - bars.bottom).coerceAtLeast(0) / resources.displayMetrics.density).toInt())
            WindowInsetsCompat.CONSUMED
        }

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) {
            showMessage(getString(R.string.webview_unsupported))
            return
        }

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        val intent = Intent(this, ConnectionService::class.java)
        startForegroundService(intent)
        bound = bindService(intent, connection, Context.BIND_AUTO_CREATE)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val wv = webView
                // 網頁自己疊了 history sentinel 把「上一頁」轉成 PTT 的左鍵（history_back_guard.js），
                // 所以能 goBack 就交給網頁。退到底時只把 App 丟到背景，不結束——結束就斷線了。
                if (wv != null && wv.canGoBack()) wv.goBack() else moveTaskToBack(true)
            }
        })
    }

    // RequiresFeature：DOCUMENT_START_SCRIPT／WEB_MESSAGE_LISTENER 已在 onCreate 檢查，不支援就不會走到這裡。
    // MissingOnRenderProcessGone：下方匿名 WebViewClient 有實作，lint 認不出 Kotlin 匿名物件（誤報）。
    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature", "MissingOnRenderProcessGone")
    private fun createWebView(site: String) {
        val wv = WebView(this)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // 預設是 true：頁面（或文章裡的惡意連結）可以讀 content:// 與 file://。本 App 用不到
            //（上傳圖片走 onShowFileChooser，不受影響），關掉。CodeQL websettings-allow-content-access。
            allowContentAccess = false
            allowFileAccess = false
            setSupportMultipleWindows(false)
            // https 頁面連 ws://127.0.0.1 的本機 proxy。network_security_config 只放行 127.0.0.1 明文。
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString PttChromeAndroid/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        // 背景時 renderer 仍維持高優先度，降低被系統回收（回收＝網頁狀態全失、連線跟著斷）的機率。
        wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)

        val origins = setOf(AppConfig.PAGE_ORIGIN)
        val config = JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("site", site)
        WebViewCompat.addDocumentStartJavaScript(
            wv, "window.__PTT_ANDROID__ = Object.freeze($config);", origins
        )
        WebViewCompat.addWebMessageListener(wv, "PttAndroid", origins) { _, message, sourceOrigin, isMainFrame, reply ->
            if (!isMainFrame || sourceOrigin.toString() != AppConfig.PAGE_ORIGIN) return@addWebMessageListener
            val request = try { JSONObject(message.data ?: return@addWebMessageListener) } catch (_: Exception) { return@addWebMessageListener }
            lifecycleScope.launch { reply.postMessage(credentials.handle(request)) }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (isAppPage(url)) return false
                // 文章裡的網址、圖片原圖等：交給系統瀏覽器，不要把 BBS 畫面換掉。
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    view.loadDataWithBaseURL(
                        null,
                        "<body style='background:#000;color:#ccc;font:16px sans-serif;padding:24px'>" +
                            getString(R.string.page_error, error.description).replace("\n", "<br>") +
                            "<p><a style='color:#4a90d9' href='${AppConfig.PAGE_URL}'>重新載入</a></p></body>",
                        "text/html", "utf-8", null,
                    )
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // renderer 被回收：這個 WebView 物件已不能用，換一個新的重新載入（連線會重建）。
                recreateWebView()
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    fileChooser.launch(params.createIntent())
                    true
                } catch (_: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        root.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
        wv.loadUrl(AppConfig.PAGE_URL)
    }

    private var lastImeInset = -1

    private fun reportImeInset(cssPx: Int) {
        if (cssPx == lastImeInset) return
        lastImeInset = cssPx
        webView?.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('pttandroid:ime',{detail:{inset:$cssPx}}))", null,
        )
    }

    private fun recreateWebView() {
        val old = webView ?: return
        webView = null
        root.removeView(old)
        old.destroy()
        service?.let { createWebView(it.site) }
    }

    private fun isAppPage(url: Uri): Boolean =
        "${url.scheme}://${url.host}" == AppConfig.PAGE_ORIGIN &&
            (url.path ?: "").startsWith(AppConfig.PAGE_URL.toUri().path ?: "/")

    private fun showMessage(text: String) {
        root.addView(TextView(this).apply {
            this.text = text
            textSize = 16f
            setPadding(48, 48, 48, 48)
        })
    }

    // 刻意不呼叫 webView.onPause()／pauseTimers()：切到背景時網頁仍要處理連線資料（自動登入、
    // 保活、畫面更新），暫停 JS 等於讓連線在網頁那端卡住。

    override fun onDestroy() {
        service?.onQuitRequested = null
        if (bound) unbindService(connection)
        if (isFinishing) stopService(Intent(this, ConnectionService::class.java))
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
