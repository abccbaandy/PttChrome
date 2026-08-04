// 裝置端 AI 瀏覽器層（src/js/caption_ai.js）的守護：假 window.LanguageModel
// 驗 availability 對映、佇列、structured output 解析、以及**每一種失敗都退回規則**。
// 真實模型能力不在 CI 量（見 tools/caption-ai-eval.html）。
import {
  captionAiAvailability,
  classifySpan,
  classifySpans,
  destroyCaptionAi,
  ensureCaptionAiReady,
} from "../../src/js/caption_ai";
import { buildCaptionSpans } from "../../src/js/caption_ai_logic";

const IMG = "https://i.imgur.com/aaa111.jpg";
const ROWS = [
  IMG,
  "第一段翻譯",
  "",
  "第二段翻譯",
  "",
  "第三段翻譯",
  "",
  "--",
];
const spanOf = () => buildCaptionSpans(ROWS, "imageFirst")[0];

// 可組態的假 Prompt API。replies 可以是值或會 throw 的函式。
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
    },
  });
  window.LanguageModel = {
    availability: () => Promise.resolve(availability),
    create: (opts) => {
      state.created++;
      state.createOpts = opts;
      return createError
        ? Promise.reject(new Error(createError))
        : Promise.resolve(makeSession());
    },
  };
  return state;
}

afterEach(() => {
  destroyCaptionAi();
  delete window.LanguageModel;
});

describe("captionAiAvailability", () => {
  test("沒有 LanguageModel → unsupported（其他瀏覽器行為不變）", async () => {
    delete window.LanguageModel;
    expect(await captionAiAvailability()).toBe("unsupported");
  });

  test("原樣回傳平台狀態", async () => {
    for (const a of ["unavailable", "downloadable", "downloading", "available"]) {
      installLM({ availability: a });
      expect(await captionAiAvailability()).toBe(a);
      destroyCaptionAi();
    }
  });

  test("availability() 自己丟例外 → unsupported（不炸畫面）", async () => {
    window.LanguageModel = {
      availability: () => Promise.reject(new Error("boom")),
    };
    expect(await captionAiAvailability()).toBe("unsupported");
  });
});

describe("classifySpan", () => {
  test("structured output 解析成 keep，並帶 responseConstraint 上下界", async () => {
    const state = installLM({ reply: '{"keep": 3}' });
    const span = spanOf();
    const r = await classifySpan(span);
    expect(r.keep).toBe(3);
    expect(r.fallback).toBeFalsy();
    const schema = state.prompts[0].opts.responseConstraint;
    expect(schema.properties.keep).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 3,
    });
    // 每塊用 clone 推論（base session 的 context 不被前一塊污染）。
    expect(state.clones).toBe(1);
    expect(state.created).toBe(1);
  });

  test("模型回超界值 → 退回規則的 ruleKeep", async () => {
    installLM({ reply: '{"keep": 99}' });
    const span = spanOf();
    expect((await classifySpan(span)).keep).toBe(span.ruleKeep);
  });

  test("模型回垃圾 → fallback 回規則", async () => {
    installLM({ reply: "I cannot help with that." });
    const span = spanOf();
    const r = await classifySpan(span);
    expect(r.keep).toBe(span.ruleKeep);
    expect(r.fallback).toBe(true);
  });

  test("prompt() 丟例外 → fallback 回規則並記下 error", async () => {
    installLM({
      reply: () => Promise.reject(new Error("NotSupportedError")),
    });
    const span = spanOf();
    const r = await classifySpan(span);
    expect(r.keep).toBe(span.ruleKeep);
    expect(r.error).toContain("NotSupportedError");
  });

  test("create() 失敗（模型沒下載/裝置不符）→ fallback 回規則", async () => {
    installLM({ createError: "model unavailable" });
    const span = spanOf();
    const r = await classifySpan(span);
    expect(r.keep).toBe(span.ruleKeep);
    expect(r.error).toContain("model unavailable");
  });

  test("逾時 → abort 並 fallback 回規則", async () => {
    installLM({ reply: () => new Promise(() => {}) }); // 永不 resolve
    const span = spanOf();
    const r = await classifySpan(span, { timeoutMs: 20 });
    expect(r.keep).toBe(span.ruleKeep);
    expect(r.error).toContain("timeout");
  });
});

describe("classifySpans（佇列）", () => {
  test("逐塊 onResult 回報；不需要推論的塊直接跳過", async () => {
    installLM({ reply: '{"keep": 2}' });
    const spans = buildCaptionSpans(
      [...ROWS.slice(0, 7), IMG, "只有一段", "--"],
      "imageFirst",
    );
    const seen = [];
    const out = await classifySpans(spans, {
      onResult: (span, r) => seen.push([span.imageRow, r.keep]),
    });
    // 第二張圖只有 1 個候選段（規則已無可改空間）→ 不推論。
    expect(seen).toEqual([[0, 2]]);
    expect(out.length).toBe(1);
  });

  test("abort 後不再推論，已完成的結果仍有效", async () => {
    const controller = new AbortController();
    let n = 0;
    installLM({
      reply: () => {
        if (++n === 1) controller.abort();
        return Promise.resolve('{"keep": 2}');
      },
    });
    const rows = [
      IMG, "一", "", "二", "",
      "https://i.imgur.com/bbb222.jpg", "三", "", "四", "",
      "--",
    ];
    const spans = buildCaptionSpans(rows, "imageFirst");
    const out = await classifySpans(spans, { signal: controller.signal });
    expect(out.length).toBe(0); // 第一塊算完時已 aborted → 不採計
    expect(n).toBe(1); // 第二塊完全沒送出
  });
});

describe("ensureCaptionAiReady（設定頁按鈕）", () => {
  test("unsupported / unavailable 不觸發 create（不會偷下載模型）", async () => {
    const s1 = installLM({ availability: "unavailable" });
    expect(await ensureCaptionAiReady()).toBe("unavailable");
    expect(s1.created).toBe(0);
    delete window.LanguageModel;
    expect(await ensureCaptionAiReady()).toBe("unsupported");
  });

  test("downloadable → create（帶 monitor 回報進度）後回 available", async () => {
    const state = installLM({ availability: "downloadable" });
    expect(await ensureCaptionAiReady(() => {})).toBe("available");
    expect(state.created).toBe(1);
    expect(typeof state.createOpts.monitor).toBe("function");
    // system prompt 有帶上（en 指令，見 caption_ai_logic）。
    expect(state.createOpts.initialPrompts[0].role).toBe("system");
  });
});
