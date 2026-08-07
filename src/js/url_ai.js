// 網址類裝置端 AI 複核的**瀏覽器層**，兩個功能各一組（純函式全在
// url_ai_logic.js，session 生命週期／逾時／clone 推論的樣板在 prompt_api.js）：
//   classifyDomain(s)   ─ 裸網域該不該連（bare_domain.js）。失敗 ⇒ 保留連結。
//   classifyBrokenUrl(s)─ 帶空白的候選到底是不是網址（url_fix.js 的 gray）。
//                         失敗 ⇒ 不放行、不修。
// 兩者的「保守側」方向相反，改動時務必看清楚是哪一組。
import {
  buildBrokenUrlPrompt,
  buildDomainPrompt,
  candNeedsAi,
  domainLinkSchema,
  fixCandNeedsAi,
  parseLinkReply,
  urlAiSystemPrompt,
  urlFixSystemPrompt,
} from "./url_ai_logic";
import {
  destroyPromptApi,
  ensurePromptApiReady,
  promptApiAvailability,
  promptOnce,
} from "./prompt_api";

// prompt_api 的 session key：與 caption_ai 的任務框架完全不同，各自獨立。
const KEY = "url";
// URL 修復複核另開一把 key：session 以 key 快取正是因為 system prompt 定義了
// 任務框架（見 prompt_api.js），「該不該連」與「這到底是不是網址」是兩個框架，
// 共用一條 session 會互相污染。
const FIX_KEY = "urlfix";

export function urlAiAvailability() {
  return promptApiAvailability();
}

export function ensureUrlAiReady(onProgress) {
  return ensurePromptApiReady(KEY, urlAiSystemPrompt(), onProgress);
}

export function destroyUrlAi() {
  destroyPromptApi(KEY);
  destroyPromptApi(FIX_KEY);
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

// URL 修復的 gray 候選：「這串帶空白的東西真的是作者打斷的網址嗎」。
// **失敗語意與上面相反**：link === null（逾時／垃圾回覆／不支援）呼叫端不寫
// cache → applyAiFix 不放行 → **不修**。這邊的保守側是「不要生出假連結」。
export async function classifyBrokenUrl(cand, opts = {}) {
  const started = Date.now();
  try {
    const raw = await promptOnce(
      FIX_KEY,
      urlFixSystemPrompt(),
      buildBrokenUrlPrompt(cand),
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

// 同 classifyDomains 的序列化 + abort + 漸進回報。
export async function classifyBrokenUrls(cands, opts = {}) {
  const out = [];
  for (const cand of cands) {
    if (opts.signal && opts.signal.aborted) break;
    if (!fixCandNeedsAi(cand)) continue;
    const r = await classifyBrokenUrl(cand, opts);
    if (opts.signal && opts.signal.aborted) break;
    out.push({ cand, ...r });
    if (opts.onResult) opts.onResult(cand, r);
  }
  return out;
}
