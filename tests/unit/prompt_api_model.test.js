// 設定頁 AI **總開關**用的模型暖機入口（src/js/prompt_api.js#ensurePromptApiModel）。
// 它與各功能的 ensure*Ready 差在：功能中性、且成功後立刻 destroy 不進 session 快取
// ——總開關不知道使用者接下來要用哪個功能，預先常駐某個功能的 base session 只是
// 白佔記憶體。守三件事：不偷下載、建完即毀、進度回呼透傳。
import {
  destroyPromptApi,
  ensurePromptApiModel,
  promptOnce,
} from "../../src/js/prompt_api";

// 可組態的假 Prompt API（比照 caption_ai_client.test.js）。
function installLM({ availability = "available", createError } = {}) {
  const state = { created: 0, destroyed: 0, prompts: 0, createOpts: null };
  const makeSession = () => ({
    prompt() {
      state.prompts++;
      return Promise.resolve("ok");
    },
    clone() {
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
  destroyPromptApi();
  delete window.LanguageModel;
});

describe("ensurePromptApiModel（AI 總開關）", () => {
  test("unsupported / unavailable 不觸發 create（不會偷下載數 GB 模型）", async () => {
    const s1 = installLM({ availability: "unavailable" });
    expect(await ensurePromptApiModel()).toBe("unavailable");
    expect(s1.created).toBe(0);

    delete window.LanguageModel;
    expect(await ensurePromptApiModel()).toBe("unsupported");
  });

  test("downloadable → create（帶 monitor）後回 available", async () => {
    const state = installLM({ availability: "downloadable" });
    expect(await ensurePromptApiModel(() => {})).toBe("available");
    expect(state.created).toBe(1);
    expect(typeof state.createOpts.monitor).toBe("function");
    expect(state.createOpts.initialPrompts[0].role).toBe("system");
  });

  test("進度回呼透傳 downloadprogress 的 loaded", async () => {
    const seen = [];
    window.LanguageModel = {
      availability: () => Promise.resolve("downloadable"),
      create: (opts) => {
        opts.monitor({
          addEventListener: (name, fn) => {
            if (name === "downloadprogress") fn({ loaded: 0.5 });
          },
        });
        return Promise.resolve({ destroy: () => {} });
      },
    };
    await ensurePromptApiModel((loaded) => seen.push(loaded));
    expect(seen).toEqual([0.5]);
  });

  test("暖機用的 session 建完即 destroy，且不落進任何功能的快取", async () => {
    const state = installLM({ availability: "downloadable" });
    await ensurePromptApiModel();
    expect(state.destroyed).toBe(1);

    // 之後功能真的要推論時，仍要自己 create 一個 base session（暖機那顆沒被留下）。
    await promptOnce("caption", "sys", "hi", { timeoutMs: 0 });
    expect(state.created).toBe(2);
  });

  test("create 失敗 → 回報當下的 availability，不 throw", async () => {
    installLM({ availability: "downloadable", createError: "boom" });
    expect(await ensurePromptApiModel()).toBe("downloadable");
  });
});
