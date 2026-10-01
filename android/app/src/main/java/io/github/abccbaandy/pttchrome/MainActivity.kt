package io.github.abccbaandy.pttchrome

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.util.Log
import android.view.PixelCopy
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
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
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
        // savedInstanceState 非 null＝整個 App process 曾在背景被系統砍掉、這次是系統還原
        //（使用者自己從桌面冷啟動時是 null）。連線與頁面都是新的。見下方「背景回前景診斷」。
        if (savedInstanceState != null) {
            Log.w(TAG, "activity restored after process death")
            Toast.makeText(this, R.string.process_restored, Toast.LENGTH_LONG).show()
        }
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
            // 不在畫面上時也保留已畫好的 tiles：切背景再回來不必整頁重新 raster（回前景黑畫面）。
            offscreenPreRaster = true
            // target=_blank／window.open 要走 onCreateWindow 才接得住（見下方 openInExternalBrowser）。
            // 關掉多視窗時它們會改成「在本頁導航」：網頁的 beforeunload 先跑、跳出「離開這個網站？」，
            // 選離開就把 BBS 畫面換掉。
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
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
                openInExternalBrowser(url)
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
                Log.w(TAG, "renderer gone: didCrash=${detail.didCrash()} priority=${detail.rendererPriorityAtExit()}")
                if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                    Toast.makeText(this@MainActivity, R.string.renderer_recreated, Toast.LENGTH_LONG).show()
                } else {
                    rendererRecreated = true
                }
                recreateWebView()
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            // 網頁開新視窗（文章連結 target=_blank、右鍵選單搜尋的 window.open）：給一個不掛到畫面上的
            // 暫時 WebView 當新視窗，只為了拿到它要載入的網址，轉給外部瀏覽器後就丟掉。
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture) return false
                val popup = WebView(this@MainActivity)
                // 只用來拿網址，什麼都不需要；跟主 WebView 一樣關掉 content:// 與 file://（CodeQL）。
                popup.settings.apply {
                    javaScriptEnabled = false
                    allowContentAccess = false
                    allowFileAccess = false
                }
                popup.webViewClient = object : WebViewClient() {
                    private var handled = false
                    private fun forward(url: Uri?) {
                        if (handled || url == null || url.scheme == "about") return
                        handled = true
                        openInExternalBrowser(url)
                        popup.post { popup.destroy() }
                    }
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        forward(request.url)
                        return true
                    }
                    // 部分 WebView 版本新視窗的第一次導航不經 shouldOverrideUrlLoading。
                    override fun onPageStarted(v: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                        v.stopLoading()
                        forward(url?.toUri())
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }

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

    private fun openInExternalBrowser(url: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (_: Exception) {}
    }

    // ---- 回前景黑畫面（docs/android-app.md「回前景黑畫面」）----
    // 背景一段時間後 renderer 還活著（畫面、連線都是離開時那個），但系統已回收視窗的繪圖資源、
    // WebView 也丟了已畫好的 tiles ⇒ 回前景要等 renderer 重新出幀，期間只看得到黑色的視窗底色。
    // 對策：離開前用 PixelCopy 拍下 WebView，回來先蓋上這張快照，等 WebView 真的出幀再拿掉。
    // 快照不吃觸控（點擊照樣落到底下的 WebView）。
    // renderer／process 若真的被回收（重新載入＋自動登入）則跳 Toast；時間寫進 logcat
    //（adb logcat -s PttChromeApp：away＝離開多久、firstFrame＝回來到出幀）。
    private var rendererRecreated = false
    private var stoppedAt = 0L
    private var snapshot: Bitmap? = null
    private var snapshotView: ImageView? = null

    override fun onPause() {
        super.onPause()
        captureSnapshot()
    }

    override fun onStop() {
        super.onStop()
        stoppedAt = SystemClock.elapsedRealtime()
        Log.i(TAG, "onStop")
    }

    @SuppressLint("RequiresFeature") // VISUAL_STATE_CALLBACK 是 androidx.webkit 內建 fallback，WebView 23+ 都有
    override fun onStart() {
        super.onStart()
        if (rendererRecreated) {
            rendererRecreated = false
            Toast.makeText(this, R.string.renderer_recreated, Toast.LENGTH_LONG).show()
        }
        val wv = webView ?: return
        if (stoppedAt == 0L) return
        val start = SystemClock.elapsedRealtime()
        val away = start - stoppedAt
        val cover = showSnapshot(wv)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.VISUAL_STATE_CALLBACK)) {
            WebViewCompat.postVisualStateCallback(wv, start) {
                Log.i(TAG, "onStart: away=${away}ms firstFrame=${SystemClock.elapsedRealtime() - start}ms")
                // callback＝下一次 onDraw 就會畫出新內容；再等兩幀確定畫上去了才掀開。
                if (cover != null) root.postOnAnimation { root.postOnAnimation { hideSnapshot(cover) } }
            }
        } else {
            Log.i(TAG, "onStart: away=${away}ms")
        }
        if (cover != null) root.postDelayed({ hideSnapshot(cover) }, SNAPSHOT_MAX_MS)
    }

    private fun captureSnapshot() {
        val wv = webView ?: return
        if (wv.width == 0 || wv.height == 0 || snapshotView != null) return
        val loc = IntArray(2)
        wv.getLocationInWindow(loc)
        val rect = Rect(loc[0], loc[1], loc[0] + wv.width, loc[1] + wv.height)
        val bmp = createBitmap(wv.width, wv.height)
        try {
            PixelCopy.request(window, rect, bmp, { result ->
                snapshot = if (result == PixelCopy.SUCCESS) bmp else null
            }, Handler(Looper.getMainLooper()))
        } catch (_: IllegalArgumentException) {
            snapshot = null // 視窗 surface 已不在
        }
    }

    private fun showSnapshot(wv: WebView): ImageView? {
        val shot = snapshot ?: return null
        snapshot = null
        // 背景期間轉了方向／改了大小：舊快照對不上，寧可不蓋。
        if (shot.width != wv.width || shot.height != wv.height) return null
        snapshotView?.let { root.removeView(it) }
        val iv = ImageView(this).apply {
            setImageBitmap(shot)
            scaleType = ImageView.ScaleType.MATRIX
            isClickable = false
            isFocusable = false
            importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        root.addView(iv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        snapshotView = iv
        return iv
    }

    private fun hideSnapshot(iv: ImageView) {
        if (snapshotView !== iv) return
        snapshotView = null
        root.removeView(iv)
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

    private companion object {
        const val TAG = "PttChromeApp"
        /** 快照最多蓋這麼久：出幀回呼沒來也要掀開，不能讓使用者對著舊畫面操作。 */
        const val SNAPSHOT_MAX_MS = 5000L
    }
}
