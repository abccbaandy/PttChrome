// 更新後的新功能小卡（pref showWhatsNew，預設開；docs/whats-new.md）。
//
// 換新版後第一次看到主功能表時，右下角一張小卡列出「這次更新多了哪些功能」。
// 清單的唯一來源是 README「## ✨ 功能特色」的條目（`- **名稱** — 說明`）：README 本來就
// 規定每個新功能都要寫一條（tests/unit/readme_features.test.js），所以不另維護一份清單。
// README 用 `?raw` 動態 import ⇒ 拆成獨立 chunk，只在主功能表第一次出現時才載。
//
// 「新」＝名稱沒出現在上次記下的清單裡（localStorage，不上雲）。同一功能的延伸改進照
// README 規範是改寫原條目、名稱不變 ⇒ 不會被當成新功能。
// 第一次用（沒有紀錄：新使用者、清過資料、換裝置）⇒ 默默記下整份清單、不顯示——
// 對他們來說每個功能都是「新」的，一次列幾十條沒有意義。
// 卡片出現當下就記下（不必按 ✕ 才算看過），所以同一批新功能只出現一次；離開主功能表就收起。
// 只改顯示，一個 byte 都不送給 PTT；卡片不是 modal，鍵盤照常送 PTT。
import { rowHasTitle, MAIN_MENU } from './screen_titles';
import { readEffectivePrefs } from './pref_storage';

export const WHATS_NEW_SEEN_KEY = 'pttchrome.whatsNew.seen.v1';
export const WHATS_NEW_ID = 'whatsNewCard';
// 卡片收起時最多列幾條名稱，其餘收在「看全部」。
export const WHATS_NEW_PREVIEW = 3;

const FEATURE_HEADING = /^##\s+✨/;
const FEATURE_LINE = /^- \*\*(.+?)\*\* — (.+)$/;

// 卡片是純文字：拿掉 README 的行內 markdown（`code`、[文字](網址)、**粗體**）。
export function plainText(md) {
  return String(md)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .trim();
}

// README → [{ name, desc, section }]，照出現順序。section ＝所在的 ### 標題（去掉 emoji）。
export function parseReadmeFeatures(md) {
  const out = [];
  let inside = false;
  let section = '';
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^## /.test(line)) {
      inside = FEATURE_HEADING.test(line);
      continue;
    }
    if (!inside) continue;
    if (/^### /.test(line)) {
      section = line.replace(/^###\s+/, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
      continue;
    }
    const m = FEATURE_LINE.exec(line);
    if (m) out.push({ name: plainText(m[1]), desc: plainText(m[2]), section });
  }
  return out;
}

// seen：上次記下的名稱陣列，沒有紀錄是 null。回傳 null ＝第一次用（呼叫端默默記下、不顯示），
// 否則回傳不在 seen 裡的條目（可能是空陣列）。
export function pendingFeatures(features, seen) {
  if (!Array.isArray(seen)) return null;
  const known = new Set(seen);
  return features.filter((f) => !known.has(f.name));
}

export function readSeen() {
  try {
    const v = JSON.parse(window.localStorage.getItem(WHATS_NEW_SEEN_KEY));
    return Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

export function writeSeen(features) {
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(features.map((f) => f.name)));
  } catch (e) {
    // 無痕視窗／被擋：下次開站又是「沒有紀錄」⇒ 默默記、不顯示，不會每次都跳。
  }
}

const loadBundledReadme = () => import('../../README.md?raw').then((m) => m.default);

function enabled() {
  return !!readEffectivePrefs().showWhatsNew;
}

// 控制器：每次 screenSettled 看一眼標題列；主功能表第一次出現時（每頁一次）比對清單。
// opts.loadReadme：測試注入（回傳 Promise<string>）。
export function WhatsNew(core, opts) {
  this._core = core;
  this._loadReadme = (opts && opts.loadReadme) || loadBundledReadme;
  this._listeners = new Set();
  this._checked = false;
  this._state = { visible: false, items: [] };
  const self = this;
  if (core && core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      return self._onSettled();
    });
}

WhatsNew.prototype = {
  get state() {
    return this._state;
  },

  onChange: function(fn) {
    this._listeners.add(fn);
    fn(this._state);
    const set = this._listeners;
    return function() {
      set.delete(fn);
    };
  },

  _set: function(patch) {
    const next = Object.assign({}, this._state, patch);
    if (Object.keys(patch).every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _onSettled: function() {
    const buf = this._core.buf;
    if (!buf || typeof buf.getRowText !== 'function') return;
    const atMenu = rowHasTitle(buf.getRowText(0, 0, buf.cols), MAIN_MENU);
    if (!atMenu) {
      if (this._state.visible) this._set({ visible: false });
      return;
    }
    if (this._checked || !enabled()) return;
    this._checked = true;
    return this.check();
  },

  // 比對一次（回傳 Promise，測試等它）。載不到 README（離線、chunk 被清）就什麼都不做。
  check: function() {
    const self = this;
    return Promise.resolve()
      .then(function() {
        return self._loadReadme();
      })
      .then(function(md) {
        const features = parseReadmeFeatures(md);
        if (!features.length) return;
        const pending = pendingFeatures(features, readSeen());
        writeSeen(features);
        if (!pending || !pending.length) return;
        // 載入途中已經離開主功能表 ⇒ 這次不顯示（已記下，不會再出現：寧可漏看也不蓋到別的畫面）。
        const buf = self._core.buf;
        if (!rowHasTitle(buf.getRowText(0, 0, buf.cols), MAIN_MENU)) return;
        self._set({ visible: true, items: pending });
      })
      .catch(function() {});
  },

  dismiss: function() {
    this._set({ visible: false });
  },
};

export function isWhatsNewTarget(el) {
  return !!(el && el.closest && el.closest('#' + WHATS_NEW_ID));
}

export default WhatsNew;
