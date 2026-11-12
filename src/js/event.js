// 輕量事件 mixin（TermBuf、連線層共用）。
//
// **監聽者故障隔離**（架構 review A1，docs/feature-isolation.md）：mixin 時帶 `{ isolate: true }`
// 的物件（TermBuf：screenSettled／pageStateSettled 等，二十幾個功能掛在同一條鏈上），派發時
// 每個監聽者各自包起來：一個功能丟例外，排在它後面的照跑，不會讓整條鏈這一幀停擺。
//   - 正式版：例外交給 setListenerErrorPolicy 的 onError（App 記進 debug 錄製）。註冊時帶了
//     `{ feature, disable }` 的監聽者，這次連線停用（呼叫它自己的 disable 收乾淨，之後派發
//     跳過它），enableAllListeners（新連線）恢復；沒帶的照舊每幀再試（不知道怎麼收的功能，
//     半套停用只會更糟）。
//   - dev build、e2e 打包版（DEVELOPER_MODE）與測試（strict）：照樣往外丟 —— 測試不能因為隔離而變鈍。
//   - 範圍是 TermBuf 的所有事件：settle 之外，change／viewUpdate（好讀的重畫）也包在內。
// 連線層（telnet／websocket／ssh）不隔離：那裡的例外要照原樣冒出去。
var errorPolicy = {
  // CI 的 offline／adverse e2e 跑的是 vite build＋PTTCHROME_E2E_BUNDLE（DEV=false、DEVELOPER_MODE=true）：
  // 只看 DEV 會讓 e2e 走正式版路徑，例外被吞、pageerror 斷言靜默失效。
  strict: !!((import.meta.env && import.meta.env.DEV) || process.env.DEVELOPER_MODE),
  onError: null,
};

// 回傳舊的 policy（測試還原用）。
export function setListenerErrorPolicy(next) {
  var prev = errorPolicy;
  errorPolicy = Object.assign({}, errorPolicy, next);
  return prev;
}

export function Event() {}

Event.mixin = function(obj, opts) {
  for (var key in Event.prototype) {
    obj[key] = Event.prototype[key];
  }
  if (opts && opts.isolate) obj._isolateListeners = true;
};

// opts（只對 isolate 的物件有意義）：{ feature: 設定鍵（提示用名稱）, disable: 出錯時把功能收乾淨 }。
Event.prototype.addEventListener = function(type, listener, opts) {
  this._listeners = this._listeners || {};
  (this._listeners[type] = this._listeners[type] || []).push(listener);
  if (opts && (opts.feature || opts.disable)) {
    this._listenerMeta = this._listenerMeta || new Map();
    this._listenerMeta.set(listener, { feature: opts.feature || null, disable: opts.disable || null });
  }
};

Event.prototype.dispatchEvent = function(e) {
  this._listeners = this._listeners || {};
  var fns = this._listeners[e.type];
  if (fns) {
    fns = fns.slice(0);
    for (var i in fns) {
      if (!this._isolateListeners) {
        fns[i](e);
        continue;
      }
      if (this._disabledListeners && this._disabledListeners.has(fns[i])) continue;
      try {
        fns[i](e);
      } catch (err) {
        this._onListenerError(e.type, fns[i], err);
      }
    }
  }
};

Event.prototype._onListenerError = function(type, fn, err) {
  if (errorPolicy.strict) throw err;
  var meta = (this._listenerMeta && this._listenerMeta.get(fn)) || null;
  var disabled = false;
  if (meta && meta.disable) {
    this._disabledListeners = this._disabledListeners || new Set();
    this._disabledListeners.add(fn);
    disabled = true;
    try {
      meta.disable();
    } catch (e2) {
      // 收不乾淨也已經不再派發給它；不能讓收尾的例外再打斷這一幀。
    }
  }
  if (typeof errorPolicy.onError === 'function') {
    try {
      errorPolicy.onError({ type: type, feature: meta ? meta.feature : null, disabled: disabled, error: err });
    } catch (e3) {}
  }
};

// 功能的其他入口（resize、推文列…）用它判斷自己是否已被停用，免得停用後又被叫回來。
Event.prototype.isListenerDisabled = function(listener) {
  return !!(this._disabledListeners && this._disabledListeners.has(listener));
};

// 新連線：出錯停用的功能恢復（下一次派發照常收到）。
Event.prototype.enableAllListeners = function() {
  this._disabledListeners = null;
};

Event.prototype.removeEventListener = function(type, listener) {
  this._listeners = this._listeners || {};
  var fns = this._listeners[type];
  if (fns) {
    for (var i in fns) {
      if (fns[i] === listener) {
        fns.splice(i, 1);
        break;
      }
    }
  }
  if (this._listenerMeta) this._listenerMeta.delete(listener);
};
