package io.github.abccbaandy.pttchrome

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * 盯著系統的「預設網路」是不是行動數據／計費網路，給網頁決定要不要自動開圖
 *（bridge 'networkState'＋事件 'pttandroid:network'，網頁端 src/js/image_load_gate.js）。
 *
 * 判準見 [isMeteredNetwork]。回呼在主執行緒（建構時給的 Handler），[onChange] 只在值真的變了才叫。
 * 生命週期跟 Activity：onCreate [start]、onDestroy [stop]。
 */
class NetworkWatch(context: Context, private val onChange: (Boolean) -> Unit) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)

    /** 目前的判定；還沒拿到任何回報時同步問一次系統。 */
    @Volatile
    var metered: Boolean = currentMetered()
        private set

    private var registered = false

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            update(isMeteredNetwork(
                cellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                notMetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            ))
        }
        // onLost（完全沒網路）刻意不改值：沒網路本來就載不了圖，回來時 onCapabilitiesChanged 會再報。
    }

    fun start() {
        if (registered || cm == null) return
        try {
            cm.registerDefaultNetworkCallback(callback, Handler(Looper.getMainLooper()))
            registered = true
        } catch (e: Exception) {
            // 系統對每個 App 的 callback 數有上限（TooManyRequestsException）；拿不到就維持建構時的判定。
            Log.w(TAG, "registerDefaultNetworkCallback: $e")
        }
    }

    fun stop() {
        if (!registered || cm == null) return
        registered = false
        try { cm.unregisterNetworkCallback(callback) } catch (_: Exception) {}
    }

    private fun update(value: Boolean) {
        if (value == metered) return
        metered = value
        onChange(value)
    }

    private fun currentMetered(): Boolean {
        val c = cm ?: return false
        return try {
            val caps = c.getNetworkCapabilities(c.activeNetwork) ?: return false
            isMeteredNetwork(
                cellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                notMetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
            )
        } catch (e: Exception) {
            false
        }
    }

    private companion object {
        const val TAG = "PttNetworkWatch"
    }
}

/**
 * 「要省流量」的網路：行動數據，或系統認定計費的網路（手機熱點、使用者標成計費的 Wi-Fi）。
 * 看 NOT_METERED 而不只看 TRANSPORT_CELLULAR：開 VPN 時預設網路是 VPN，系統會把底層網路的
 * 計費狀態帶上來，transport 卻不一定是 cellular。
 */
fun isMeteredNetwork(cellular: Boolean, notMetered: Boolean): Boolean = cellular || !notMetered
