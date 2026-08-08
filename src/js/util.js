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
