// 長推文草稿（src/js/long_push_draft.js）。
//
// 守三件事：
//   1. round-trip：打到一半關掉，下次開回來內容還在
//   2. localStorage 壞掉／被關掉不可以炸掉輸入框（隱私視窗、封鎖 site data）
//   3. **不可以跟 pref 共用 key** —— 草稿是使用者打的推文內容，混進
//      pttchrome.pref.v1 就會被雲端同步與設定匯出一起帶走
import {
  readDraft,
  writeDraft,
  clearDraft,
  resetDraftCacheForTests,
} from "../../src/js/long_push_draft";

const KEY = "pttchrome.longPush.draft.v1";

beforeEach(() => {
  localStorage.clear();
  resetDraftCacheForTests();
});

describe("round-trip", () => {
  test("寫進去讀得回來", () => {
    writeDraft("打到一半的推文");
    expect(readDraft()).toBe("打到一半的推文");
  });

  test("沒寫過就是空字串（不是 null，呼叫端直接丟給 setValue）", () => {
    expect(readDraft()).toBe("");
  });

  test("清空之後讀回空字串，而且 key 整個移掉不留垃圾", () => {
    writeDraft("安安");
    clearDraft();
    expect(readDraft()).toBe("");
    expect(localStorage.getItem(KEY)).toBe(null);
  });

  test("寫空字串等於清空", () => {
    writeDraft("安安");
    writeDraft("");
    expect(localStorage.getItem(KEY)).toBe(null);
  });

  test("非字串當成空的處理，不會存進 'undefined' 這種字面值", () => {
    writeDraft(undefined);
    expect(readDraft()).toBe("");
    resetDraftCacheForTests();
    writeDraft({ a: 1 });
    expect(readDraft()).toBe("");
  });
});

describe("key 不可以跟 pref 共用", () => {
  test("用自己的 key，且不等於 pttchrome.pref.v1", () => {
    writeDraft("秘密");
    expect(localStorage.getItem(KEY)).toBe("秘密");
    expect(KEY).not.toBe("pttchrome.pref.v1");
    expect(localStorage.getItem("pttchrome.pref.v1")).toBe(null);
  });

  test("清草稿不會動到 pref", () => {
    localStorage.setItem("pttchrome.pref.v1", '{"values":{}}');
    writeDraft("安安");
    clearDraft();
    expect(localStorage.getItem("pttchrome.pref.v1")).toBe('{"values":{}}');
  });
});

describe("localStorage 不可用時只能降級，不可以炸", () => {
  const withBroken = (fn, run) => {
    const orig = Object.getOwnPropertyDescriptor(
      window,
      "localStorage",
    );
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        return fn;
      },
    });
    try {
      run();
    } finally {
      Object.defineProperty(window, "localStorage", orig);
    }
  };

  test("setItem throw（配額滿／私密模式）不會往上冒", () => {
    withBroken(
      {
        getItem: () => null,
        setItem() {
          throw new Error("QuotaExceededError");
        },
        removeItem() {},
      },
      () => {
        expect(() => writeDraft("安安")).not.toThrow();
      },
    );
  });

  test("getItem throw 時回空字串", () => {
    withBroken(
      {
        getItem() {
          throw new Error("SecurityError");
        },
        setItem() {},
        removeItem() {},
      },
      () => {
        expect(readDraft()).toBe("");
      },
    );
  });

  test("存到非字串（外部寫壞）回空字串", () => {
    withBroken(
      {
        getItem: () => 42,
        setItem() {},
        removeItem() {},
      },
      () => {
        expect(readDraft()).toBe("");
      },
    );
  });
});

describe("重複寫同一個值只寫一次", () => {
  test("每打一個字就寫是可接受的，但一模一樣的值不該重複 setItem", () => {
    let writes = 0;
    const real = localStorage.setItem.bind(localStorage);
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((k, v) => {
        writes++;
        real(k, v);
      });
    writeDraft("安安");
    writeDraft("安安");
    writeDraft("安安你好");
    expect(writes).toBe(2);
    spy.mockRestore();
  });
});
