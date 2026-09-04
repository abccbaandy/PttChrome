// 圖片上傳的 DOM／流程層（決策純函式在 image_upload.js，歷史在 upload_history.js）。
//
// 三個入口，最後都匯進同一條 _runQueue：
//   拖放      window 的 drag* 事件（只認 dataTransfer 帶 Files 的拖曳）
//   貼上      App.onDOMPaste 先問 tryClipboardImage（截圖直接 Ctrl+V）
//   右鍵選單  openFilePicker()（動態 <input type=file>）
//
// 插入位置的判斷是**上傳結束當下**才做（decideInsertMode）：上傳要好幾秒，
// 使用者很可能已經離開推文列，用開始拖曳當下的畫面狀態會把網址打到別的地方。

import { createElement } from 'react';
import { renderInto, unmountFrom } from './react_root';
import { readValuesWithDefault } from './pref_storage';
import { decideInsertMode, formatInsertText, pickUploadFiles, uploadImage } from './image_upload';
import {
  addHistoryEntry,
  clearHistory,
  readHistory,
  removeHistoryEntry,
  writeHistory
} from './upload_history';
import { MantineRoot } from '../components/MantineRoot';
import { ImageUploadLayer } from '../components/ImageUploadLayer';

const CONTAINER_ID = 'imageUploadReact';
const NOTICE_MS = 6000;

// 滑鼠事件落在上傳浮層上時，終端機的滑鼠處理必須整條讓開（否則點「插入」會順便
// 送出一次終端機動作、在面板裡滾動會變成 PTT 翻頁——滾輪是註冊在 window 的
// capture listener，浮層自己 stopPropagation 攔不到）。pttchrome.jsx 的 mouse_*
// 入口都先問這個。
export function isUploadLayerTarget(el) {
  return !!(el && el.closest && el.closest('#' + CONTAINER_ID));
}

export function ImageUploadController(core) {
  this._core = core;
  this._dragDepth = 0;
  this._insertTarget = null;
  this._noticeTimer = null;
  this._busy = false;
  this._state = {
    dragging: false,
    uploading: null, // { index, total, filename, percent }
    notice: null,    // { type:'success'|'error', mode, urls, failures }
    panelOpen: false,
    history: readHistory()
  };

  const self = this;
  // dragover 不 preventDefault 就不會有 drop（瀏覽器預設是「不接受」），
  // 而 drop 的預設行為是「用這個分頁打開這張圖」——那會把整個 BBS session 沖掉。
  window.addEventListener('dragenter', function(e) { self._onDragEnter(e); });
  window.addEventListener('dragover', function(e) { self._onDragOver(e); });
  window.addEventListener('dragleave', function(e) { self._onDragLeave(e); });
  window.addEventListener('drop', function(e) { self._onDrop(e); });
}

// 頁面上的文字輸入框可以把自己註冊成插入目標（目前唯一的消費者是長推文輸入框
// LongPushModal）。刻意做成**通用**目標而不是 longPush 專屬：InputHelperModal 之類
// 的輸入框將來同題。但現在只有一個消費者，所以不做註冊表／堆疊。
//   target 形狀：{ insert(text) }
ImageUploadController.prototype.setInsertTarget = function(target) {
  this._insertTarget = target || null;
};

// 傳入自己才清：A 關閉時不可以把後開的 B 清掉。target 不在了（modal 中途被關掉）
// 就乾淨退回既有決策，絕不往一個已卸載的 React state 塞字。
ImageUploadController.prototype.clearInsertTarget = function(target) {
  if (!target || this._insertTarget === target) this._insertTarget = null;
};

ImageUploadController.prototype.enabled = function() {
  return !!readValuesWithDefault().enableImageUpload;
};

ImageUploadController.prototype._token = function() {
  return readValuesWithDefault().imageUploadToken || '';
};

// dataTransfer 只在真的拖「檔案」時才含 'Files'；終端機文字拖曳只有 text/plain，
// 不該亮出上傳遮罩。
function hasFiles(e) {
  const dt = e && e.dataTransfer;
  if (!dt || !dt.types) return false;
  return Array.prototype.indexOf.call(dt.types, 'Files') >= 0;
}

ImageUploadController.prototype._onDragEnter = function(e) {
  if (!this.enabled() || !hasFiles(e)) return;
  e.preventDefault();
  // 進出子元素會連發 dragleave/dragenter，用深度計數才不會讓遮罩閃爍。
  this._dragDepth++;
  if (!this._state.dragging) this._setState({ dragging: true });
};

ImageUploadController.prototype._onDragOver = function(e) {
  if (!this.enabled() || !hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
};

ImageUploadController.prototype._onDragLeave = function(e) {
  if (!this._state.dragging) return;
  e.preventDefault();
  this._dragDepth--;
  if (this._dragDepth <= 0) {
    this._dragDepth = 0;
    this._setState({ dragging: false });
  }
};

ImageUploadController.prototype._onDrop = function(e) {
  if (!this.enabled() || !hasFiles(e)) return;
  e.preventDefault();
  this._dragDepth = 0;
  this._setState({ dragging: false });
  this.uploadFiles(e.dataTransfer.files);
};

// 剪貼簿裡有圖就吃掉這次貼上（回 true 讓 App.onDOMPaste 不要再走文字路徑）。
ImageUploadController.prototype.tryClipboardImage = function(e) {
  if (!this.enabled()) return false;
  const data = e && e.clipboardData;
  if (!data) return false;
  const files = [];
  // clipboardData.files 對某些來源的截圖是空的，items 才拿得到 → 兩邊都看。
  if (data.files && data.files.length) {
    Array.prototype.push.apply(files, Array.prototype.slice.call(data.files));
  } else if (data.items) {
    for (const item of Array.prototype.slice.call(data.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  const images = files.filter(
    f => f && typeof f.type === 'string' && f.type.indexOf('image/') === 0
  );
  if (!images.length) return false;
  e.preventDefault();
  this.uploadFiles(images);
  return true;
};

ImageUploadController.prototype.openFilePicker = function() {
  if (!this.enabled()) return;
  const self = this;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  // 檔案對話框期間必須擋住終端機的焦點搶回（keyup/mouseover 會把焦點拉回隱藏
  // 的 #t）。**禁止直接寫 modalShown**，一律走具名來源集合。
  this._core.setModalOpen('imageUploadPicker', true);
  let settled = false;
  const done = function() {
    if (settled) return;
    settled = true;
    self._core.setModalOpen('imageUploadPicker', false);
    if (input.parentNode) input.parentNode.removeChild(input);
  };
  input.addEventListener('change', function() {
    const files = input.files;
    done();
    self.uploadFiles(files);
  });
  // 取消（Esc／關掉對話框）在支援的瀏覽器會發 cancel；沒發的話由回到視窗的
  // focus 兜底，否則 modal 旗標會永遠卡著（終端機再也收不到鍵盤）。
  input.addEventListener('cancel', done);
  window.addEventListener('focus', function onFocus() {
    window.removeEventListener('focus', onFocus);
    window.setTimeout(function() {
      if (!input.files || !input.files.length) done();
    }, 300);
  });
  document.body.appendChild(input);
  input.click();
};

ImageUploadController.prototype.openPanel = function() {
  this._setState({ panelOpen: true, history: readHistory() });
};

ImageUploadController.prototype.closePanel = function() {
  this._setState({ panelOpen: false });
};

// 一批檔案：依序上傳（不並行——50MB × N 併發會把上傳頻寬吃光、進度也讀不出來），
// 每成功一筆立刻進歷史，整批結束才插入一次。
ImageUploadController.prototype.uploadFiles = function(fileList) {
  if (!this.enabled()) return Promise.resolve();
  const picked = pickUploadFiles(fileList);
  if (!picked.accepted.length) {
    if (picked.rejected.length)
      this._notify({ type: 'error', urls: [], failures: picked.rejected });
    return Promise.resolve();
  }
  if (this._busy) {
    // 上一批還在跑：不排隊，直接說明（排隊會讓「插到哪裡」變得無法預期）。
    this._notify({ type: 'error', urls: [], failures: [{ name: '', reason: 'busy' }] });
    return Promise.resolve();
  }
  this._busy = true;
  const self = this;
  return this._runQueue(picked.accepted, picked.rejected).then(
    function() { self._busy = false; },
    function() { self._busy = false; }
  );
};

ImageUploadController.prototype._runQueue = async function(files, rejected) {
  const token = this._token();
  const urls = [];
  const failures = rejected.slice();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    this._setState({
      uploading: { index: i + 1, total: files.length, filename: file.name || '', percent: 0 }
    });
    const result = await uploadImage(file, {
      token,
      onProgress: ratio => {
        const cur = this._state.uploading;
        if (cur && cur.index === i + 1)
          this._setState({ uploading: { ...cur, percent: Math.round(ratio * 100) } });
      }
    });
    if (result.ok) {
      urls.push(result.url);
      // 每成功一筆立刻落地：後面的檔失敗不該把已經傳好的網址一起弄丟。
      this._pushHistory({
        url: result.url,
        previewUrl: result.previewUrl,
        deleteUrl: result.deleteUrl,
        filename: result.filename || file.name || '',
        mime: result.mime || file.type || '',
        at: Date.now()
      });
    } else {
      failures.push({ name: file.name || '', reason: result.message || 'invalid_response' });
    }
  }
  this._setState({ uploading: null });
  const mode = urls.length ? this.insertUrls(urls) : null;
  this._notify({ type: urls.length ? 'success' : 'error', mode, urls, failures });
};

// 插入的唯一入口（批次結束與面板的「插入」鈕共用）。回傳實際採用的模式。
ImageUploadController.prototype.insertUrls = function(urls) {
  const text = formatInsertText(urls);
  if (!text) return null;
  const buf = this._core.buf;
  const mode = decideInsertMode({
    pageState: buf.pageState,
    lastRowText: buf.getRowText(buf.rows - 1, 0, buf.cols),
    hasTextTarget: !!this._insertTarget
  });
  if (mode === 'target') {
    // 頁面上的輸入框（長推文）開著：插進它的游標處。此時底下的畫面是文章／文章
    // 列表，走 send 等於把網址當成列表快捷鍵一個一個按下去。
    this._insertTarget.insert(text);
  } else if (mode === 'send') {
    // 既有的貼上漏斗：列表好讀接管、文章好讀 functionMode 都在裡面處理過了，
    // 不可以繞過去直接 view.conn.send。**不補 Enter**，送不送由使用者決定。
    this._core.onPasteDone(text);
  } else {
    this._core.doCopy(text);
  }
  return mode;
};

// 面板的「插入」鈕：單筆，順便讓使用者知道結果落在哪裡。
ImageUploadController.prototype.insertOne = function(url) {
  const mode = this.insertUrls([url]);
  if (mode) this._notify({ type: 'success', mode, urls: [url], failures: [] });
};

ImageUploadController.prototype.copyUrl = function(url) {
  this._core.doCopy(url);
  this._notify({ type: 'success', mode: 'clipboard', urls: [url], failures: [] });
};

ImageUploadController.prototype._pushHistory = function(entry) {
  const next = addHistoryEntry(this._state.history, entry);
  writeHistory(next);
  this._setState({ history: next });
};

ImageUploadController.prototype.removeHistory = function(url) {
  const next = removeHistoryEntry(this._state.history, url);
  writeHistory(next);
  this._setState({ history: next });
};

ImageUploadController.prototype.clearHistoryAll = function() {
  clearHistory();
  this._setState({ history: [] });
};

ImageUploadController.prototype._notify = function(notice) {
  if (this._noticeTimer) window.clearTimeout(this._noticeTimer);
  this._setState({ notice });
  const self = this;
  this._noticeTimer = window.setTimeout(function() {
    self._noticeTimer = null;
    self._setState({ notice: null });
  }, NOTICE_MS);
};

ImageUploadController.prototype.dismissNotice = function() {
  if (this._noticeTimer) window.clearTimeout(this._noticeTimer);
  this._noticeTimer = null;
  this._setState({ notice: null });
};

ImageUploadController.prototype._setState = function(patch) {
  this._state = { ...this._state, ...patch };
  this._render();
};

// imperative render（與 App.showPasteUnimplemented 同一套）：這層不屬於任何既有的
// React 樹，且由非 React 的 DOM 事件驅動。容器獨立於 #reactAlert——那個被
// ConnectionAlert／PasteShortcutAlert／DeepLinkHandoffAlert 輪流獨占（同一個
// react root cache，互相覆蓋）。
ImageUploadController.prototype._render = function() {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) return;
  const s = this._state;
  if (!s.dragging && !s.uploading && !s.notice && !s.panelOpen) {
    unmountFrom(container);
    return;
  }
  renderInto(
    container,
    createElement(
      MantineRoot,
      null,
      createElement(ImageUploadLayer, { controller: this, state: s })
    )
  );
};
