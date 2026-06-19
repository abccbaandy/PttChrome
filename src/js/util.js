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

// Build a connect() target from the proxy prefs, or '' when proxy is off/empty.
// Accepts a bare host (ptt-proxy.example.dev) or a full ws(s)telnet:// URL:
//  - no scheme   -> prepend wsstelnet:// (secure WebSocket)
//  - no path     -> append /bbs (where PTT relays serve the telnet stream)
export function proxySiteFromPrefs(prefs) {
  if (!prefs || !prefs.useProxy) return '';
  var s = (prefs.proxyUrl || '').trim();
  if (!s) return '';
  if (!/:\/\//.test(s)) s = 'wsstelnet://' + s;
  var afterScheme = s.split('://')[1] || '';
  if (afterScheme.indexOf('/') === -1) s += '/bbs';
  return s;
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
