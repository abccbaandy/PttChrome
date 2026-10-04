package io.github.abccbaandy.pttchrome

import android.os.Process
import android.os.SystemClock
import android.util.Log

/**
 * 冷啟動時間軸（`adb logcat -s PttChromeApp` 看 `boot:`）。t＝距 process 啟動的毫秒數，
 * 用來分辨開啟時的黑畫面卡在哪一段：頁面載入（GitHub Pages）還是連 PTT（proxy 上游）。
 * 見 docs/android-app.md 狀態表「開啟時黑畫面」。
 */
object BootTrace {
    /** 頁面自己的 Navigation／Resource Timing（ms，相對 navigationStart）：哪個資源慢、是不是走快取。 */
    const val RESOURCE_TIMING_JS = """(function(){
      var r=function(n){return Math.round(n)};
      var nav=performance.getEntriesByType('navigation')[0]||{};
      var out=['nav ttfb='+r(nav.responseStart)+' dcl='+r(nav.domContentLoadedEventEnd)+' load='+r(nav.loadEventEnd)+' size='+nav.transferSize];
      performance.getEntriesByType('resource').forEach(function(e){
        out.push(e.name.split('/').pop().slice(0,40)+' start='+r(e.startTime)+' dns='+r(e.domainLookupEnd-e.domainLookupStart)+' conn='+r(e.connectEnd-e.connectStart)+' ttfb='+r(e.responseStart-e.requestStart)+' dl='+r(e.responseEnd-e.responseStart)+' end='+r(e.responseEnd)+' size='+e.transferSize+' '+e.nextHopProtocol);
      });
      performance.getEntriesByType('mark').concat(performance.getEntriesByType('paint')).forEach(function(e){out.push(e.name+'='+r(e.startTime))});
      return out.join(' | ');
    })()"""

    fun mark(stage: String) {
        Log.i("PttChromeApp","boot: $stage t=${SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()}ms")
    }
}
