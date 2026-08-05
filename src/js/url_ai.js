// 裸網域自動連結的裝置端 AI 複核**瀏覽器層**。session 生命週期／逾時／clone
// 推論的樣板在共用的 prompt_api.js；這裡只留本功能的語意：prompt 組裝、結果
// 解析、以及「任何失敗都保留規則結果（＝保留連結）」的單向收縮契約。
// 純函式全部在 url_ai_logic.js。
import {
  buildDomainPrompt,
  candNeedsAi,
  domainLinkSchema,
  parseLinkReply,
  urlAiSystemPrompt,
} from "./url_ai_logic";
import {
  destroyPromptApi,
  ensurePromptApiReady,
  promptApiAvailability,
  promptOnce,
} from "./prompt_api";

// prompt_api 的 session key：與 caption_ai 的任務框架完全不同，各自獨立。
const KEY = "url";

export function urlAiAvailability() {
  return promptApiAvailability();
}

export function ensureUrlAiReady(onProgress) {
  return ensurePromptApiReady(KEY, urlAiSystemPrompt(), onProgress);
}

export function destroyUrlAi() {
  destroyPromptApi(KEY);
}

// 單一候選的推論。回傳 { link, ms, raw, error }。
// link === null → 沒有明確判斷，呼叫端保留規則結果（連結留著）。
export async function classifyDomain(cand, opts = {}) {
  const started = Date.now();
  try {
    const raw = await promptOnce(
      KEY,
      urlAiSystemPrompt(),
      buildDomainPrompt(cand),
      {
        responseConstraint: domainLinkSchema(),
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      },
    );
    const parsed = parseLinkReply(raw);
    return {
      link: parsed,
      raw,
      ms: Date.now() - started,
      fallback: parsed === null,
    };
  } catch (e) {
    return {
      link: null,
      ms: Date.now() - started,
      error: (e && e.message) || String(e),
      fallback: true,
    };
  }
}

// 逐一序列化推論（裝置端一次只跑得動一個，且要能中途 abort）。每個算完立刻
// onResult 回報 → 呼叫端漸進式更新畫面。規則結果早就畫出來了，AI 只是逐步撤掉
// 誤判，不擋畫面。
export async function classifyDomains(cands, opts = {}) {
  const out = [];
  for (const cand of cands) {
    if (opts.signal && opts.signal.aborted) break;
    if (!candNeedsAi(cand)) continue;
    const r = await classifyDomain(cand, opts);
    if (opts.signal && opts.signal.aborted) break;
    out.push({ cand, ...r });
    if (opts.onResult) opts.onResult(cand, r);
  }
  return out;
}
