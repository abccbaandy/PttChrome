// 裝置端 AI（Chrome Prompt API，`window.LanguageModel`）的**共用瀏覽器層**。
// 兩個功能建在它上面：
//   - caption_ai.js  好讀圖文並排的說明段配對（單向擴張）
//   - url_ai.js      裸網域自動連結的複核（單向收縮）
// 各功能自己的純函式（prompt 組裝／schema／解析／fallback 語意）留在各自的
// *_logic.js，這裡只管 session 生命週期、逾時與 clone 推論的樣板。
//
// 平台事實（developer.chrome.com/docs/ai/prompt-api，2026-08 查證）：
//   - 官方支援語言只有 en/ja/es/de/fr，**中文不在清單內**；`expectedInputs` 傳
//     不支援的語言可能丟 NotSupportedError → 這裡一律**不傳語言**，指令用英文、
//     內容維持原文中文。
//   - 模型 per-origin 首次使用才下載（數 GB）→ availability() 非 'available' 時
//     **絕不自動觸發**，下載只在設定頁按鈕（有 user activation）發生。
//   - 只有 Chrome 有。其他瀏覽器 promptApiAvailability() 回 'unsupported'，
//     呼叫端不顯示 UI，行為與沒有這個功能時完全相同。
//
// WHY 依 key 分別快取 session：system prompt 決定模型的任務框架，兩個功能的框架
// 完全不同，共用一個 base session 會互相帶偏。

const DEFAULT_TIMEOUT_MS = 20000;

const api = () =>
  typeof window !== "undefined" && window.LanguageModel
    ? window.LanguageModel
    : null;

// 'unsupported'（無 API）| 'unavailable'（裝置不符）| 'downloadable' |
// 'downloading' | 'available'
export async function promptApiAvailability() {
  const lm = api();
  if (!lm || typeof lm.availability !== "function") return "unsupported";
  try {
    const v = await lm.availability();
    return typeof v === "string" ? v : "unsupported";
  } catch (e) {
    return "unsupported";
  }
}

// key → Promise<session>
const sessions = new Map();

function createSession(systemPrompt, onProgress) {
  const lm = api();
  if (!lm) return Promise.reject(new Error("LanguageModel unavailable"));
  const opts = { initialPrompts: [{ role: "system", content: systemPrompt }] };
  if (onProgress) {
    opts.monitor = (m) => {
      m.addEventListener("downloadprogress", (e) => {
        onProgress(typeof e.loaded === "number" ? e.loaded : 0);
      });
    };
  }
  return lm.create(opts);
}

function baseSession(key, systemPrompt) {
  let p = sessions.get(key);
  if (!p) {
    p = createSession(systemPrompt, null).catch((e) => {
      sessions.delete(key);
      throw e;
    });
    sessions.set(key, p);
  }
  return p;
}

// 設定頁「啟用裝置端 AI」按鈕用：帶著 user activation 建 session（needed 時會
// 觸發模型下載並回報進度）。回傳最終 availability 字串。
export async function ensurePromptApiReady(key, systemPrompt, onProgress) {
  const before = await promptApiAvailability();
  if (before === "unsupported" || before === "unavailable") return before;
  try {
    const session = await createSession(systemPrompt, onProgress);
    destroyPromptApi(key);
    sessions.set(key, Promise.resolve(session));
    return "available";
  } catch (e) {
    return await promptApiAvailability();
  }
}

// key 省略 → 全部關掉（模型常駐佔記憶體）。
export function destroyPromptApi(key) {
  const keys = key === undefined ? [...sessions.keys()] : [key];
  for (const k of keys) {
    const p = sessions.get(k);
    sessions.delete(k);
    if (p) {
      Promise.resolve(p)
        .then((s) => s && typeof s.destroy === "function" && s.destroy())
        .catch(() => {});
    }
  }
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error("prompt api timeout"));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// 單次推論，回傳模型的原始回覆字串；任何失敗（session 建不起來／逾時／例外）
// 一律 throw，由呼叫端決定 fallback。
//
// 每次都用 clone 推論：base session 的 context 不被前一次的問答污染（同一篇文章
// 的相鄰候選內容相似，累積 context 會讓答案互相帶偏）。
export async function promptOnce(key, systemPrompt, text, opts = {}) {
  let clone = null;
  let isClone = false;
  try {
    const session = await baseSession(key, systemPrompt);
    isClone = typeof session.clone === "function";
    clone = isClone ? await session.clone({ signal: opts.signal }) : session;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const promptOpts = {};
    if (opts.responseConstraint)
      promptOpts.responseConstraint = opts.responseConstraint;
    if (controller) promptOpts.signal = controller.signal;
    return await withTimeout(
      clone.prompt(text, promptOpts),
      opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs,
      () => controller && controller.abort(),
    );
  } finally {
    if (isClone && clone && typeof clone.destroy === "function") {
      try {
        clone.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  }
}
