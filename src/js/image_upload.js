// 圖片上傳到 urusai 圖床（PTT 本身沒有貼圖功能，只能貼圖床網址）。
//
// API 合約（https://urusai.cc/api，2026-08 實測）：
//   POST https://api-v1-t2-upload.urusai.cc   multipart/form-data
//     file   必填，單檔上限 50MB
//     token  選填，留空＝匿名上傳
//     r18    選填，1=NSFW，預設 0
//     sha256 選填，留空＝跳過校驗
//   → { status:"success", message:"uploaded",
//       data:{ id, r18, filename, url_preview, url_direct, url_delete, mime } }
//
// CORS：preflight 回 204 + Access-Control-Allow-Origin 回射 Origin
// （Allow-Headers: *、Allow-Methods: POST, OPTIONS）⇒ 瀏覽器可直傳，不需自架代理。
//
// **插入 PTT 的一律是 url_direct**（帶副檔名）：只有它命中 image_url_detect.js 的
// RE_IMAGE_EXT，好讀模式才會自動開圖；url_preview 是 urusai 的網頁，任何 PTT
// client 都不會展開。長度約 30 字元，推文列塞得下。
//
// 本檔的決策部分全是純函式（無 DOM、無網路），守護在 tests/unit/image_upload.test.js。

import { classifyPushScreen } from './push_screen';

export const URUSAI_UPLOAD_URL = 'https://api-v1-t2-upload.urusai.cc';
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 120000;

// 只收圖片：PTT 貼影片檔沒有 client 會播，而 50MB 的上傳成本卻是真的。
export function validateFile(file) {
  if (!file || typeof file.type !== 'string' || file.type.indexOf('image/') !== 0)
    return { ok: false, reason: 'type' };
  if (file.size > MAX_UPLOAD_BYTES)
    return { ok: false, reason: 'size' };
  return { ok: true };
}

// FileList / File[] → { accepted, rejected:[{name, reason}] }。
// 被擋下的不是靜默丟掉：呼叫端要逐筆說明理由，否則使用者只會看到「少傳了一張」。
export function pickUploadFiles(files) {
  const accepted = [];
  const rejected = [];
  const list = files ? Array.prototype.slice.call(files) : [];
  for (const file of list) {
    const v = validateFile(file);
    if (v.ok) accepted.push(file);
    else rejected.push({ name: (file && file.name) || '', reason: v.reason });
  }
  return { accepted, rejected };
}

// XHR 的 responseText（或已解析好的物件）→ 統一結果。
// message 刻意留「機器碼或 API 原文」，翻譯是 UI 層的事（純函式不碰 i18n）。
export function parseUploadResponse(raw, status) {
  let json = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch (e) {
      return { ok: false, message: status ? 'http_' + status : 'invalid_response' };
    }
  }
  if (!json || typeof json !== 'object')
    return { ok: false, message: status ? 'http_' + status : 'invalid_response' };
  const data = json.data;
  if (json.status !== 'success' || !data || !data.url_direct)
    return { ok: false, message: json.message || 'invalid_response' };
  return {
    ok: true,
    url: data.url_direct,
    previewUrl: data.url_preview || '',
    deleteUrl: data.url_delete || '',
    filename: data.filename || '',
    mime: data.mime || ''
  };
}

// 上傳完成後該把網址「送進終端機」還是「只複製到剪貼簿」。
//   pageState 6   編輯文章（term_buf.js#setPageState 認的原生編輯器底列）
//   inputPrompt   推文的**內容輸入列**（bbs.c#recommend 步驟 3）
//   其他（列表／選單／閱讀）→ 送字等於亂按指令，一律走剪貼簿
//
// 底列的分類一律走共用的 push_screen.js#classifyPushScreen（長推文送出序列用的
// 是同一支），**不要在這裡自己寫 regex**：這裡當年只認 '→ id:' 一種型別符，但 prompt 是
// bbs.c:3079 的 sprintf("%s%s%s %s:", ctype_attr[type], ctype[type], RESET, myid)，
// ctype = 推／噓／→ ⇒ 最常按的 1.推薦 一律判不到，症狀是「上傳完都說不在推文框」。
// 順帶擋掉三種「長得像但送字會壞事」的底列：
//   typeMenu 型別選單 vkey() 只吃 1 byte ⇒ 網址首字被當型別鍵吞掉；
//   confirm  確定[y/N] ans 只吃 1 字元 ⇒ 非 y ＝整則推文靜默取消；
//   angel／cooldown／fatal 橫幅同理都不是能打字的地方。
export function decideInsertMode({ pageState, lastRowText }) {
  if (pageState === 6) return 'send';
  if (lastRowText && classifyPushScreen([lastRowText], 1).kind === 'inputPrompt')
    return 'send';
  return 'clipboard';
}

// 多檔：一次插入、空白分隔（推文列一行、編輯器也讀得順）。
export function formatInsertText(urls) {
  return (urls || []).filter(Boolean).join(' ');
}

export function buildUploadFormData(file, { token = '' } = {}) {
  const form = new FormData();
  form.append('file', file);
  form.append('r18', '0');
  // token 留空＝匿名上傳；欄位照送，與官方 curl 範例一致。
  form.append('token', token || '');
  return form;
}

// 一律 resolve（不 reject）：多檔佇列要能「某一張失敗、其他照跑」，
// 呼叫端只看 result.ok，不必到處包 try/catch。
// 用 XMLHttpRequest 而非 fetch：只有它有 upload.onprogress（百分比）。
export function uploadImage(file, { token = '', onProgress, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let xhr;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('POST', URUSAI_UPLOAD_URL, true);
    } catch (e) {
      resolve({ ok: false, message: 'network' });
      return;
    }
    xhr.timeout = timeoutMs;
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = e => {
        if (e && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => resolve(parseUploadResponse(xhr.responseText, xhr.status));
    xhr.onerror = () => resolve({ ok: false, message: 'network' });
    xhr.ontimeout = () => resolve({ ok: false, message: 'timeout' });
    xhr.send(buildUploadFormData(file, { token }));
  });
}
