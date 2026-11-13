package io.github.abccbaandy.pttchrome

import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkWatchTest {
    @Test
    fun cellularIsMetered() {
        assertEquals(true, isMeteredNetwork(cellular = true, notMetered = false))
        // 少數電信吃到飽方案會標 NOT_METERED，仍是行動數據：照樣省流量。
        assertEquals(true, isMeteredNetwork(cellular = true, notMetered = true))
    }

    @Test
    fun unmeteredWifiIsNot() {
        assertEquals(false, isMeteredNetwork(cellular = false, notMetered = true))
    }

    @Test
    fun meteredWifiOrVpnOverCellularIsMetered() {
        // 手機熱點／使用者標成計費的 Wi-Fi／VPN 底層是行動數據：transport 不是 cellular，但沒有 NOT_METERED。
        assertEquals(true, isMeteredNetwork(cellular = false, notMetered = false))
    }
}
