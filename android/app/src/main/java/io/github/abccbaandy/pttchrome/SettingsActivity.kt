package io.github.abccbaandy.pttchrome

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * APK 自己的設定頁（跟網頁設定無關，存在 [AppSettings]）。入口：網頁設定頁的「App 設定」（bridge
 * `openAppSettings`）、長按 App 圖示的捷徑（網頁載不出來時也進得來）、載入失敗頁的連結。
 * 目前只有「開發者 → dev server 模式」（docs/android-app.md「debug 版並存與 dev server 模式」）。
 */
// 平台 Switch：刻意不為一個開關引入 appcompat／material 依賴。
@SuppressLint("UseSwitchCompatOrMaterialCode")
class SettingsActivity : ComponentActivity() {
    private lateinit var settings: AppSettings
    private lateinit var devSwitch: Switch
    private lateinit var urlInput: EditText
    private lateinit var urlError: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(20)
            setPadding(pad, pad, pad, pad)
        }
        content.addView(text(getString(R.string.settings_title), 22f, bold = true))

        content.addView(header(getString(R.string.settings_developer)))
        devSwitch = Switch(this).apply {
            text = getString(R.string.settings_dev_server)
            textSize = 16f
            isChecked = settings.devServerEnabled
            setOnCheckedChangeListener { _, _ -> validate() }
        }
        content.addView(devSwitch)
        urlInput = EditText(this).apply {
            setText(settings.devServerUrl)
            hint = PageSource.DEFAULT_DEV_URL
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { validate() }
            })
        }
        content.addView(urlInput)
        urlError = text("", 14f).apply {
            setTextColor(Color.rgb(0xF0, 0x6A, 0x6A))
            visibility = View.GONE
        }
        content.addView(urlError)
        content.addView(text(getString(if (settings.allowLan) R.string.settings_dev_help_lan else R.string.settings_dev_help), 14f, dim = true))

        content.addView(Button(this).apply {
            text = getString(R.string.settings_save)
            setOnClickListener { save() }
        })

        content.addView(header(getString(R.string.settings_about)))
        content.addView(text(getString(R.string.settings_password_note), 14f, dim = true))
        content.addView(text("${BuildConfig.APPLICATION_ID} ${BuildConfig.VERSION_NAME}", 13f, dim = true))

        val scroll = ScrollView(this).apply { addView(content) }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(scroll)
        validate()
    }

    /** 開啟 dev 模式時網址必須合格；關閉時不檢查（值照存，下次開啟再驗）。 */
    private fun validate(): PageSource? {
        val parsed = PageSource.parseDevServer(urlInput.text.toString(), settings.allowLan)
        val bad = devSwitch.isChecked && parsed == null
        urlError.text = getString(if (settings.allowLan) R.string.settings_dev_invalid_lan else R.string.settings_dev_invalid)
        urlError.visibility = if (bad) View.VISIBLE else View.GONE
        return parsed
    }

    private fun save() {
        val parsed = validate()
        if (devSwitch.isChecked && parsed == null) return
        settings.devServerUrl = parsed?.url ?: urlInput.text.toString().trim()
        settings.devServerEnabled = devSwitch.isChecked
        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
        // 回到主畫面：MainActivity（singleTask）在 onStart 比對頁面來源，變了就重建 WebView。
        // 從桌面捷徑進來、主畫面還沒開時則是直接啟動它。
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, size: Float, bold: Boolean = false, dim: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        if (dim) alpha = 0.75f
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun header(s: String) = text(s, 13f, bold = true).apply {
        setTextColor(Color.rgb(0x4A, 0x90, 0xD9))
        setPadding(0, dp(24), 0, dp(4))
    }

    companion object {
        private const val SHORTCUT_ID = "app_settings"

        /** 長按 App 圖示的「App 設定」。用動態捷徑：靜態 shortcuts.xml 要寫死 targetPackage，跟 debug 的 `.debug` 後綴衝突。 */
        fun publishShortcut(context: Context) {
            val shortcut = ShortcutInfoCompat.Builder(context, SHORTCUT_ID)
                .setShortLabel(context.getString(R.string.settings_title))
                .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                .setIntent(Intent(context, SettingsActivity::class.java).setAction(Intent.ACTION_VIEW))
                .build()
            try {
                ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
            } catch (_: Exception) {
                // 捷徑只是方便入口；啟動器不支援或被限流都不影響 App。
            }
        }
    }
}
