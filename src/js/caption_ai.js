// 好讀「左圖右文」裝置端 AI 的**瀏覽器層**。session 生命週期／逾時／clone 推論
// 的樣板已抽到共用的 prompt_api.js（url_ai.js 也建在它上面）；這裡只留本功能的
// 語意：prompt 組裝、結果解析、以及「任何失敗都退回規則 ruleKeep」。
// 純函式全部在 caption_ai_logic.js。
import {
  buildCaptionPrompt,
  captionKeepSchema,
  captionSystemPrompt,
  normalizeKeep,
  parseKeepReply,
  spanNeedsAi,
} from "./caption_ai_logic";
import {
  destroyPromptApi,
  ensurePromptApiReady,
  promptApiAvailability,
  promptOnce,
} from "./prompt_api";

// prompt_api 的 session key：與 url_ai 的 system prompt 任務框架完全不同，
// 兩者必須是各自獨立的 base session。
const KEY = "caption";

// 'unsupported'（無 API）| 'unavailable'（裝置不符）| 'downloadable' |
// 'downloading' | 'available'
export function captionAiAvailability() {
  return promptApiAvailability();
}

// 設定頁「啟用裝置端 AI」按鈕用：帶著 user activation 建 session（needed 時會
// 觸發模型下載並回報進度）。回傳最終 availability 字串。
export function ensureCaptionAiReady(onProgress) {
  return ensurePromptApiReady(KEY, captionSystemPrompt(), onProgress);
}

export function destroyCaptionAi() {
  destroyPromptApi(KEY);
}

// 單塊推論。回傳 { keep, ms, raw, error }；失敗時 keep = span.ruleKeep（規則結果）。
export async function classifySpan(span, opts = {}) {
  const started = Date.now();
  try {
    const raw = await promptOnce(
      KEY,
      captionSystemPrompt(),
      buildCaptionPrompt(span),
      {
        responseConstraint: captionKeepSchema(span),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
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
