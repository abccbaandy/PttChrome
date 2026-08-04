// 好讀「左圖右文」裝置端 AI 的**瀏覽器層**：包住 Chrome Prompt API
// （`window.LanguageModel`，Chrome 148 起 stable、桌機免 flag）。純函式全部在
// caption_ai_logic.js，這裡只管 session 生命週期、佇列與 fallback。
//
// 平台事實（developer.chrome.com/docs/ai/prompt-api，2026-08 查證）：
//   - 官方支援語言只有 en/ja/es/de/fr，**中文不在清單內**；`expectedInputs` 傳
//     不支援的語言可能丟 NotSupportedError → 這裡一律**不傳語言**，指令用英文、
//     內容維持原文中文。實際中文判斷能力用 tools/caption-ai-eval.html 實測。
//   - 模型 per-origin 首次使用才下載（數 GB）→ availability() 非 'available' 時
//     **絕不自動觸發**，下載只在設定頁按鈕（有 user activation）發生。
//   - 只有 Chrome 有。其他瀏覽器 captionAiAvailability() 回 'unsupported'，
//     呼叫端不顯示按鈕，行為與沒有這個功能時完全相同。
import {
  buildCaptionPrompt,
  captionKeepSchema,
  captionSystemPrompt,
  normalizeKeep,
  parseKeepReply,
  spanNeedsAi,
} from "./caption_ai_logic";

const DEFAULT_TIMEOUT_MS = 20000;

const api = () =>
  typeof window !== "undefined" && window.LanguageModel
    ? window.LanguageModel
    : null;

// 'unsupported'（無 API）| 'unavailable'（裝置不符）| 'downloadable' |
// 'downloading' | 'available'
export async function captionAiAvailability() {
  const lm = api();
  if (!lm || typeof lm.availability !== "function") return "unsupported";
  try {
    const v = await lm.availability();
    return typeof v === "string" ? v : "unsupported";
  } catch (e) {
    return "unsupported";
  }
}

let sessionPromise = null;

// 建（或取回）base session。只在 availability === 'available' 或呼叫端明確允許
// 下載（設定頁按鈕）時才會走到 create()。
function createSession(onProgress) {
  const lm = api();
  if (!lm) return Promise.reject(new Error("LanguageModel unavailable"));
  const opts = { initialPrompts: [{ role: "system", content: captionSystemPrompt() }] };
  if (onProgress) {
    opts.monitor = (m) => {
      m.addEventListener("downloadprogress", (e) => {
        onProgress(typeof e.loaded === "number" ? e.loaded : 0);
      });
    };
  }
  return lm.create(opts);
}

function baseSession() {
  if (!sessionPromise) {
    sessionPromise = createSession(null).catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

// 設定頁「啟用裝置端 AI」按鈕用：帶著 user activation 建 session（needed 時會
// 觸發模型下載並回報進度）。回傳最終 availability 字串。
export async function ensureCaptionAiReady(onProgress) {
  const before = await captionAiAvailability();
  if (before === "unsupported" || before === "unavailable") return before;
  try {
    const session = await createSession(onProgress);
    destroyCaptionAi();
    sessionPromise = Promise.resolve(session);
    return "available";
  } catch (e) {
    return await captionAiAvailability();
  }
}

export function destroyCaptionAi() {
  const p = sessionPromise;
  sessionPromise = null;
  if (p) {
    Promise.resolve(p)
      .then((s) => s && typeof s.destroy === "function" && s.destroy())
      .catch(() => {});
  }
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error("caption ai timeout"));
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

// 單塊推論。回傳 { keep, ms, raw, error }；失敗時 keep = span.ruleKeep（規則結果）。
export async function classifySpan(span, opts = {}) {
  const started = Date.now();
  let clone = null;
  let isClone = false;
  try {
    const session = await baseSession();
    // 每塊用 clone 推論：base session 的 context 不被前一塊的問答污染
    // （同一篇文章的相鄰圖塊內容相似，累積 context 會讓答案互相帶偏）。
    isClone = typeof session.clone === "function";
    clone = isClone ? await session.clone({ signal: opts.signal }) : session;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const promptOpts = { responseConstraint: captionKeepSchema(span) };
    if (controller) promptOpts.signal = controller.signal;
    const raw = await withTimeout(
      clone.prompt(buildCaptionPrompt(span), promptOpts),
      opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs,
      () => controller && controller.abort(),
    );
    const parsed = parseKeepReply(raw);
    return {
      keep: parsed === null ? span.ruleKeep : normalizeKeep(span, parsed),
      raw,
      ms: Date.now() - started,
      fallback: parsed === null,
    };
  } catch (e) {
    return {
      keep: span.ruleKeep,
      ms: Date.now() - started,
      error: (e && e.message) || String(e),
      fallback: true,
    };
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

// 逐塊序列化推論（裝置端一次只跑得動一個，且要能中途 abort）。每塊算完立刻
// onResult 回報 → 呼叫端漸進式更新畫面，不必等整篇跑完。
// aborted 回傳時已算完的結果仍然有效。
export async function classifySpans(spans, opts = {}) {
  const out = [];
  for (const span of spans) {
    if (opts.signal && opts.signal.aborted) break;
    if (!spanNeedsAi(span)) continue;
    const r = await classifySpan(span, opts);
    if (opts.signal && opts.signal.aborted) break;
    out.push({ span, ...r });
    if (opts.onResult) opts.onResult(span, r);
  }
  return out;
}
