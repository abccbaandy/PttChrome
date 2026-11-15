// @unit-env browser
// real-input: tests/e2e/offline/whats_new.offline.spec.js
// 更新後的新功能介紹（js/whats_new.js、components/WhatsNew、HomeDashboard 的 WhatsNewSection；P35、P71）。
//
// 鎖的症狀：
//   1. 清單的唯一來源是 README「功能特色」的條目；真的 README 解析得出來（改格式就紅）。
//   2. 第一次用（沒有紀錄）⇒ 默默記下、不顯示；之後只列名稱沒看過的條目。
//   3. **按「知道了」／✕ 才記成看過**：離開主功能表（首頁儀表板背景抓我的最愛那一下）只是暫時藏起來，
//      回來還在（P71 之前出現當下就記，實際上使用者根本看不到）。設定關掉 ⇒ 完全不比對、不記。
//   4. 卡片不搶焦點（不是 modal），✕ 算看過，「看全部」展開說明；首頁儀表板開著時卡片不畫（改畫在儀表板）。
//   5. 儀表板區塊：「知道了」算看過；每條「⚙ 設定」帶出設定頁的跳轉目標，沒有開關的條目不放按鈕。
import { render, fireEvent, act } from "@testing-library/react";
import readme from "../../README.md?raw";
import {
  parseReadmeFeatures,
  pendingFeatures,
  readSeen,
  WhatsNew,
  WHATS_NEW_SEEN_KEY,
  isWhatsNewTarget,
} from "../../src/js/whats_new";
import { WhatsNewCard } from "../../src/components/WhatsNew";
import { WhatsNewSection } from "../../src/components/HomeDashboard";
import { setupI18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());

const PREF_KEY = "pttchrome.pref.v1";
afterEach(() => {
  localStorage.removeItem(WHATS_NEW_SEEN_KEY);
  localStorage.removeItem(PREF_KEY);
});

const MD = [
  "# x",
  "## ✨ 功能特色",
  "",
  "### 📖 閱讀文章",
  "",
  "- **好讀模式** — 文章自動翻頁。",
  "- **新東西** — 這次才加的。",
  "",
  "### 🚫 黑名單與關注",
  "- **關注名單** — 標色條。",
  "",
  "## 🚀 其他",
  "- **不是功能** — 這段不算。",
].join("\n");

describe("parseReadmeFeatures", () => {
  test("只收「功能特色」底下的條目，帶分類名", () => {
    expect(parseReadmeFeatures(MD)).toEqual([
      { name: "好讀模式", desc: "文章自動翻頁。", section: "閱讀文章" },
      { name: "新東西", desc: "這次才加的。", section: "閱讀文章" },
      { name: "關注名單", desc: "標色條。", section: "黑名單與關注" },
    ]);
  });

  test("說明拿掉行內 markdown（卡片是純文字）", () => {
    const [f] = parseReadmeFeatures(
      "## ✨ 功能\n- **`F4` 面板** — 按 `End` 看 [Releases](../../releases)，**很快**。",
    );
    expect(f).toMatchObject({ name: "F4 面板", desc: "按 End 看 Releases，很快。" });
  });

  test("真的 README 解析得出來：條目夠多、名稱不重複", () => {
    const f = parseReadmeFeatures(readme);
    expect(f.length).toBeGreaterThan(30);
    expect(new Set(f.map((x) => x.name)).size).toBe(f.length);
    expect(f.every((x) => x.name && x.desc && x.section)).toBe(true);
  });
});

describe("pendingFeatures", () => {
  const f = parseReadmeFeatures(MD);
  test("沒有紀錄 ⇒ null（第一次用，不顯示）", () => {
    expect(pendingFeatures(f, null)).toBeNull();
  });
  test("只列沒看過的名稱", () => {
    expect(pendingFeatures(f, ["好讀模式", "關注名單"]).map((x) => x.name)).toEqual(["新東西"]);
    expect(pendingFeatures(f, f.map((x) => x.name))).toEqual([]);
  });
});

describe("控制器", () => {
  const MENU = "【主功能表】                    批踢踢實業坊";
  const BOARD = "【板主:someone】     看板《Test》";
  const makeCore = (row0) => {
    const listeners = [];
    const core = {
      buf: {
        rows: 24,
        cols: 80,
        row0,
        getRowText: (r) => (r === 0 ? core.buf.row0 : ""),
        addEventListener: (type, fn) => listeners.push(fn),
      },
    };
    core.settle = () => Promise.all(listeners.map((fn) => fn()));
    return core;
  };
  const setup = (row0, md = MD) => {
    const core = makeCore(row0);
    const loads = [];
    const ctl = new WhatsNew(core, {
      loadReadme: () => {
        loads.push(1);
        return Promise.resolve(md);
      },
    });
    return { core, ctl, loads };
  };

  test("第一次用 ⇒ 記下整份、不顯示", async () => {
    const { core, ctl } = setup(MENU);
    await core.settle();
    expect(ctl.state.visible).toBe(false);
    expect(readSeen()).toEqual(["好讀模式", "新東西", "關注名單"]);
  });

  test("有新條目 ⇒ 主功能表上顯示；按看過之前不記", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(["好讀模式"]));
    const { core, ctl } = setup(MENU);
    await core.settle();
    expect(ctl.state.visible).toBe(true);
    expect(ctl.state.items.map((x) => x.name)).toEqual(["新東西", "關注名單"]);
    expect(readSeen()).toEqual(["好讀模式"]);
  });

  test("離開主功能表（背景抓我的最愛）只是暫時藏起來，回來還在；README 只載一次", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(["好讀模式"]));
    const { core, ctl, loads } = setup(MENU);
    await core.settle();
    core.buf.row0 = BOARD;
    await core.settle();
    expect(ctl.state.visible).toBe(false);
    expect(ctl.state.items.length).toBe(2);
    core.buf.row0 = MENU;
    await core.settle();
    expect(ctl.state.visible).toBe(true);
    expect(loads.length).toBe(1);
    expect(readSeen()).toEqual(["好讀模式"]);
  });

  test("README 還在載就離開主功能表 ⇒ 先藏著，回主功能表才出現", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(["好讀模式"]));
    const core = makeCore(MENU);
    let release;
    const ctl = new WhatsNew(core, {
      loadReadme: () => new Promise((r) => (release = () => r(MD))),
    });
    const pending = core.settle();
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    core.buf.row0 = BOARD;
    release();
    await pending;
    expect(ctl.state.visible).toBe(false);
    expect(ctl.state.items.length).toBe(2);
    core.buf.row0 = MENU;
    await core.settle();
    expect(ctl.state.visible).toBe(true);
  });

  test("acknowledge ⇒ 記下整份、收起，回主功能表不再出現", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(["好讀模式"]));
    const { core, ctl } = setup(MENU);
    await core.settle();
    ctl.acknowledge();
    expect(readSeen()).toEqual(["好讀模式", "新東西", "關注名單"]);
    expect(ctl.state).toMatchObject({ visible: false, items: [] });
    core.buf.row0 = BOARD;
    await core.settle();
    core.buf.row0 = MENU;
    await core.settle();
    expect(ctl.state.visible).toBe(false);
  });

  test("dismiss（設定關掉）⇒ 收起但不記成看過", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify(["好讀模式"]));
    const { core, ctl } = setup(MENU);
    await core.settle();
    ctl.dismiss();
    expect(ctl.state).toMatchObject({ visible: false, items: [] });
    expect(readSeen()).toEqual(["好讀模式"]);
  });

  test("不在主功能表 ⇒ 不載 README、不比對", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify([]));
    const { core, ctl, loads } = setup(BOARD);
    await core.settle();
    expect(loads.length).toBe(0);
    expect(ctl.state.visible).toBe(false);
  });

  test("設定關掉 ⇒ 不載 README、不記", async () => {
    localStorage.setItem(PREF_KEY, JSON.stringify({ values: { showWhatsNew: false } }));
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify([]));
    const { core, ctl, loads } = setup(MENU);
    await core.settle();
    expect(loads.length).toBe(0);
    expect(ctl.state.visible).toBe(false);
    expect(readSeen()).toEqual([]);
  });

  test("README 載不到 ⇒ 什麼都不做", async () => {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, JSON.stringify([]));
    const core = makeCore(MENU);
    const ctl = new WhatsNew(core, { loadReadme: () => Promise.reject(new Error("offline")) });
    await ctl.check();
    expect(ctl.state.visible).toBe(false);
    expect(readSeen()).toEqual([]);
  });
});

describe("卡片", () => {
  const items = [
    { name: "甲", desc: "甲的說明" },
    { name: "乙", desc: "乙的說明" },
    { name: "丙", desc: "丙的說明" },
    { name: "丁", desc: "丁的說明" },
  ];
  const fakeCtl = () => {
    let fn = null;
    const ctl = {
      state: { visible: true, items },
      onChange: (f) => {
        fn = f;
        f(ctl.state);
        return () => {};
      },
      acknowledge: vi.fn(() => fn({ visible: false, items: [] })),
    };
    return ctl;
  };
  const fakeHome = (visible) => ({
    state: { visible },
    onChange: (f) => {
      f({ visible });
      return () => {};
    },
  });

  test("收起時列前 3 個名稱＋「等 N 項」，看全部展開說明", () => {
    const { container } = render(<WhatsNewCard pttchrome={{ whatsNew: fakeCtl() }} />);
    const card = container.querySelector("#whatsNewCard");
    expect(card.textContent).toContain("甲");
    expect(card.textContent).toContain("丙");
    expect(card.textContent).not.toContain("丁");
    expect(card.textContent).not.toContain("甲的說明");
    fireEvent.click(card.querySelector(".whatsNewAll"));
    expect(card.textContent).toContain("丁的說明");
    expect(isWhatsNewTarget(card.querySelector("li"))).toBe(true);
  });

  test("首頁儀表板開著 ⇒ 小卡不畫（改畫在儀表板）；儀表板收起 ⇒ 小卡出現", () => {
    const on = render(
      <WhatsNewCard pttchrome={{ whatsNew: fakeCtl(), homeDashboard: fakeHome(true) }} />,
    );
    expect(on.container.querySelector("#whatsNewCard")).toBeNull();
    const off = render(
      <WhatsNewCard pttchrome={{ whatsNew: fakeCtl(), homeDashboard: fakeHome(false) }} />,
    );
    expect(off.container.querySelector("#whatsNewCard")).not.toBeNull();
  });

  test("不搶焦點（mousedown 被擋下預設動作），✕ 算看過", () => {
    const ctl = fakeCtl();
    const { container } = render(<WhatsNewCard pttchrome={{ whatsNew: ctl }} />);
    const close = container.querySelector(".whatsNewClose");
    expect(fireEvent.mouseDown(close)).toBe(false);
    act(() => {
      fireEvent.click(close);
    });
    expect(ctl.acknowledge).toHaveBeenCalled();
    expect(container.querySelector("#whatsNewCard")).toBeNull();
  });
});

describe("首頁儀表板的「這次更新」區塊", () => {
  // 名稱取真的 README 條目：「⚙ 設定」靠 whats_new_settings 的對應表。
  const items = [
    { name: "好讀模式", desc: "好讀的說明" },
    { name: "設為全部已讀", desc: "沒有開關的條目" },
    { name: "關注名單", desc: "關注的說明" },
    { name: "看板分頁", desc: "第四條" },
  ];
  const fakeCtl = () => {
    let fn = null;
    const ctl = {
      state: { visible: false, items },
      onChange: (f) => {
        fn = f;
        f(ctl.state);
        return () => {};
      },
      acknowledge: vi.fn(() => fn({ visible: false, items: [] })),
    };
    return ctl;
  };

  test("不在主功能表（visible:false）也照畫：背景抓我的最愛時儀表板還在，區塊不能跟著消失", () => {
    const { container } = render(<WhatsNewSection whatsNew={fakeCtl()} onOpenSetting={() => {}} />);
    expect(container.querySelector("[data-home-whats-new]")).not.toBeNull();
  });

  test("先列 3 條，看全部展開；「知道了」算看過並收起", () => {
    const ctl = fakeCtl();
    const { container } = render(<WhatsNewSection whatsNew={ctl} onOpenSetting={() => {}} />);
    const sec = container.querySelector("[data-home-whats-new]");
    expect(sec.textContent).toContain("4 個新功能");
    expect(sec.textContent).not.toContain("第四條");
    fireEvent.click(sec.querySelector("[data-home-whats-new-all]"));
    expect(sec.textContent).toContain("第四條");
    const ack = sec.querySelector("[data-home-whats-new-ack]");
    expect(fireEvent.mouseDown(ack)).toBe(false);
    act(() => {
      fireEvent.click(ack);
    });
    expect(ctl.acknowledge).toHaveBeenCalled();
    expect(container.querySelector("[data-home-whats-new]")).toBeNull();
  });

  test("「⚙ 設定」帶出設定項的 key；沒有開關的條目不放按鈕", () => {
    const open = vi.fn();
    const { container } = render(<WhatsNewSection whatsNew={fakeCtl()} onOpenSetting={open} />);
    const buttons = [...container.querySelectorAll("[data-home-whats-new-setting]")];
    expect(buttons.map((b) => b.getAttribute("data-home-whats-new-setting"))).toEqual([
      "enableEasyReading",
      "enableFollowList",
    ]);
    fireEvent.click(buttons[1]);
    expect(open).toHaveBeenCalledWith("enableFollowList");
  });
});
