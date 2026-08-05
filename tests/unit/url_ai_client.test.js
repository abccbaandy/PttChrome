// 裸網域 AI 複核瀏覽器層（src/js/url_ai.js）的守護：假 window.LanguageModel 驗
// availability 對映、佇列、structured output 解析，以及**每一種失敗都保留連結**
// （link === null → 呼叫端不撤，見 url_ai_logic 的單向收縮契約）。
// 真實模型能力不在 CI 量。
import {
  classifyDomain,
  classifyDomains,
  destroyUrlAi,
  ensureUrlAiReady,
  urlAiAvailability
} from "../../src/js/url_ai";

const cand = (host, rowText, gray = true) => ({
  startCol: 0,
  endCol: host.length,
  host,
  href: "https://" + host,
  gray,
  rowText
});

const GRAY = cand("indiegametw.com", "介紹台灣獨立遊戲的 indiegametw.com");

// 可組態的假 Prompt API（同 caption_ai_client.test.js 的形狀）。
function installLM({ availability = "available", reply, createError } = {}) {
  const state = { prompts: [], created: 0, clones: 0, destroyed: 0 };
  const makeSession = () => ({
    prompt(text, opts) {
      state.prompts.push({ text, opts });
      return typeof reply === "function"
        ? reply(text, opts)
        : Promise.resolve(reply);
    },
    clone() {
      state.clones++;
      return Promise.resolve(makeSession());
    },
    destroy() {
      state.destroyed++;
    }
  });
  window.LanguageModel = {
    availability: () => Promise.resolve(availability),
    create: opts => {
      state.created++;
      state.createOpts = opts;
      return createError
        ? Promise.reject(new Error(createError))
        : Promise.resolve(makeSession());
    }
  };
  return state;
}

afterEach(() => {
  destroyUrlAi();
  delete window.LanguageModel;
});

describe("urlAiAvailability", () => {
  test("沒有 LanguageModel → unsupported（其他瀏覽器行為不變）", async () => {
    delete window.LanguageModel;
    expect(await urlAiAvailability()).toBe("unsupported");
  });

  test("原樣回傳平台狀態", async () => {
    for (const a of ["unavailable", "downloadable", "downloading", "available"]) {
      installLM({ availability: a });
      expect(await urlAiAvailability()).toBe(a);
      destroyUrlAi();
    }
  });
});

describe("classifyDomain", () => {
  test("structured output 解析成 boolean，並帶 responseConstraint", async () => {
    const state = installLM({ reply: '{"link": false}' });
    const r = await classifyDomain(GRAY);
    expect(r.link).toBe(false);
    expect(r.fallback).toBeFalsy();
    expect(state.prompts[0].opts.responseConstraint.properties.link).toEqual({
      type: "boolean"
    });
    // 每次用 clone 推論（base session 的 context 不被前一次污染）。
    expect(state.clones).toBe(1);
    expect(state.created).toBe(1);
  });

  test("模型回垃圾 → link null（保留連結）", async () => {
    installLM({ reply: "I cannot help with that." });
    const r = await classifyDomain(GRAY);
    expect(r.link).toBeNull();
    expect(r.fallback).toBe(true);
  });

  test("prompt() 丟例外 → link null 並記下 error", async () => {
    installLM({ reply: () => Promise.reject(new Error("NotSupportedError")) });
    const r = await classifyDomain(GRAY);
    expect(r.link).toBeNull();
    expect(r.error).toContain("NotSupportedError");
  });

  test("create() 失敗（模型沒下載）→ link null", async () => {
    installLM({ createError: "model unavailable" });
    const r = await classifyDomain(GRAY);
    expect(r.link).toBeNull();
    expect(r.error).toContain("model unavailable");
  });

  test("逾時 → abort 並 link null", async () => {
    installLM({ reply: () => new Promise(() => {}) }); // 永不 resolve
    const r = await classifyDomain(GRAY, { timeoutMs: 20 });
    expect(r.link).toBeNull();
    expect(r.error).toContain("timeout");
  });
});

describe("classifyDomains（佇列）", () => {
  test("逐一 onResult 回報；非 gray 候選直接跳過", async () => {
    installLM({ reply: '{"link": false}' });
    const strong = cand("a.b.example.com", "看 a.b.example.com", false);
    const seen = [];
    const out = await classifyDomains([GRAY, strong], {
      onResult: (c, r) => seen.push([c.host, r.link])
    });
    expect(seen).toEqual([["indiegametw.com", false]]);
    expect(out.length).toBe(1);
  });

  test("abort 後不再推論，已完成的結果不採計", async () => {
    const controller = new AbortController();
    let n = 0;
    installLM({
      reply: () => {
        if (++n === 1) controller.abort();
        return Promise.resolve('{"link": false}');
      }
    });
    const out = await classifyDomains(
      [GRAY, cand("second.com", "另一個 second.com")],
      { signal: controller.signal }
    );
    expect(out.length).toBe(0);
    expect(n).toBe(1); // 第二個完全沒送出
  });
});

describe("ensureUrlAiReady（設定頁按鈕）", () => {
  test("unsupported / unavailable 不觸發 create（不會偷下載模型）", async () => {
    const s1 = installLM({ availability: "unavailable" });
    expect(await ensureUrlAiReady()).toBe("unavailable");
    expect(s1.created).toBe(0);
    delete window.LanguageModel;
    expect(await ensureUrlAiReady()).toBe("unsupported");
  });

  test("downloadable → create（帶 monitor 回報進度）後回 available", async () => {
    const state = installLM({ availability: "downloadable" });
    expect(await ensureUrlAiReady(() => {})).toBe("available");
    expect(state.created).toBe(1);
    expect(typeof state.createOpts.monitor).toBe("function");
    expect(state.createOpts.initialPrompts[0].role).toBe("system");
  });
});
