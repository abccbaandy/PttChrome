// 每幀（~30ms 一次）都會跑到的追蹤日誌開關。好讀長文一篇會產生上千筆
// 「page state: 3->3」/「view update」，字串組裝本身不貴，但開著 DevTools 時全部
// 留在記憶體，而長文的記憶體正是使用者回報的症狀之一。
// 用 `if (TRACE)` 包在**呼叫端**（而不是 no-op 函式）才能讓 bundler 在 prod
// 把整段 dead-code 消掉；dev（vite serve，含 Playwright 起的 e2e）照樣印，
// 失敗時的 console dump 不受影響。
export const TRACE = !!process.env.DEVELOPER_MODE;

export function setTimer(repeat, func, timelimit) {
  if(repeat) {
	  return {
		  timer: setInterval(func, timelimit),
		  cancel: function() {
			  clearInterval(this.timer);
		  }
	  };
  } else {
	  return {
		  timer: setTimeout(func, timelimit),
		  cancel: function() {
			  clearTimeout(this.timer);
		  }
	  };
  }
}

// 專案方提供的公用 relay。**空欄位就是用它**（UI 把它放在 placeholder），使用者想
// 自架時才填自己的位址，刪空即回到這個預設——不會出現「刪掉就永遠沒有位址」。
export const DEFAULT_PROXY_HOST = 'ptt-proxy.ptt-relay-8xquy.workers.dev';

// Build a connect() target from the proxy prefs, or '' when proxy is off.
// Accepts a bare host (ptt-proxy.example.dev) or a full ws(s)telnet:// URL:
//  - empty       -> DEFAULT_PROXY_HOST (the placeholder the user sees)
//  - no scheme   -> prepend wsstelnet:// (secure WebSocket)
//  - no path     -> append /bbs (where PTT relays serve the telnet stream)
export function proxySiteFromPrefs(prefs) {
  if (!prefs || !prefs.useProxy) return '';
  var s = (prefs.proxyUrl || '').trim() || DEFAULT_PROXY_HOST;
  if (!/:\/\//.test(s)) s = 'wsstelnet://' + s;
  var afterScheme = s.split('://')[1] || '';
  if (afterScheme.indexOf('/') === -1) s += '/bbs';
  return s;
}

// 觸發瀏覽器下載一段文字內容（Blob + a[download]）。
export function downloadAsFile(filename, text, mime) {
  var blob = new Blob([text], { type: mime || 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

export function getQueryVariable(variable) {
  var query = window.location.search.substring(1);
  var vars = query.split("&");
  for (var i=0;i<vars.length;i++) {
    var pair = vars[i].split("=");
    if (pair[0] == variable) {
      return decodeURIComponent(pair[1]);
    }
  }
  return null;
}
