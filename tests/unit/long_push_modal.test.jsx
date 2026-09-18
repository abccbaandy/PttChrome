// 長推文輸入框（src/components/ContextMenu/LongPushModal.jsx）。
//
// 守三件會直接害到使用者的事：
//   1. 即時則數：使用者要能在按下去之前知道「這會變成幾則推文」
//   2. 非 Big5 字元（emoji）要先講清楚會被略過，而且交出去的內容必須是**已過濾**的
//      —— u2b 對它們回 '\xFF\xFD'，0xFF 是 telnet IAC 而 telnet.js 不做跳脫
//   3. 超過 20 則要先問一次（PTT 有推文冷卻，整段可能跑好幾分鐘）
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import LongPushModal from "../../src/components/ContextMenu/LongPushModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import {
  readDraft,
  clearDraft,
  resetDraftCacheForTests,
} from "../../src/js/long_push_draft";

window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
window.scrollTo = window.scrollTo || (() => {});
// Mantine 的 Textarea autosize 會掛在 document.fonts 的 loadingdone 上（等字體
// 載完重算高度），jsdom 沒有 FontFaceSet ⇒ 不補會在 mount 就 throw。
if (!document.fonts)
  Object.defineProperty(document, "fonts", {
    value: { addEventListener() {}, removeEventListener() {} },
    configurable: true,
  });

beforeAll(() => {
  loadBig5Tables();
  setupI18n();
});

// 草稿會落地到 localStorage ⇒ 不清就會跨 case 污染（症狀：「空白時…」那幾支
// 會拿到上一支留下來的內容）。模組層還有一顆 lastWritten 快取要一起重置。
beforeEach(() => {
  localStorage.clear();
  resetDraftCacheForTests();
});

const renderModal = (props = {}) => {
  const onConfirm = props.onConfirm || vi.fn();
  const tree = (show) => (
    <MantineProvider>
      <LongPushModal
        show={show}
        maxBytes={props.maxBytes || 20}
        preflight={props.preflight}
        onHide={props.onHide || (() => {})}
        onConfirm={onConfirm}
        imageUpload={props.imageUpload}
      />
    </MantineProvider>
  );
  const utils = render(tree(props.show === undefined ? true : props.show));
  return { ...utils, onConfirm, show: (v) => utils.rerender(tree(v)) };
};

// 假的 ImageUploadController：只要 setInsertTarget／clearInsertTarget／enabled／
// tryClipboardImage／openFilePicker 這幾個 modal 真的會碰到的方法。
const fakeUpload = (over = {}) => ({
  enabled: () => true,
  setInsertTarget: vi.fn(),
  clearInsertTarget: vi.fn(),
  tryClipboardImage: vi.fn(() => false),
  openFilePicker: vi.fn(),
  ...over,
});

const textarea = () => document.querySelector('[name="longPushText"]');
const type = (value) => fireEvent.change(textarea(), { target: { value } });
const submit = () =>
  fireEvent.submit(textarea().closest("form"));
const segmentsText = () =>
  screen.getByTestId("longPushSegments").textContent;

// SegmentedControl 的每個選項＝一個同名 hidden radio ＋ 一個 <label>。色塊掛在
// label 裡面，用 data-push-type 取，不依賴 Mantine 的內部 class。
const swatch = (value) =>
  document.querySelector(`[data-push-type="${value}"]`);

// 型別選項比照 PTT 原生配色（bbs.c#recommend 的 ctype_attr：推 1;33 亮黃、
// 噓 1;31 亮紅、→ 1;37 亮白）。畫在黑底小色塊上，理由是 Mantine 的亮色主題
// （設定頁可切）底下亮黃與亮白等於看不見 —— 黑底同時讓它長得跟終端機一樣。
describe("型別選項的配色", () => {
  test("推／噓／→ 各自帶到 PTT 原生的那個顏色", () => {
    renderModal();
    expect(swatch("push").style.color).toBe("rgb(255, 255, 0)"); // 亮黃
    expect(swatch("boo").style.color).toBe("rgb(255, 0, 0)"); // 亮紅
    expect(swatch("arrow").style.color).toBe("rgb(255, 255, 255)"); // 亮白
  });

  test("色塊是黑底（亮色主題下也要讀得到）", () => {
    renderModal();
    for (const v of ["push", "boo", "arrow"])
      expect(swatch(v).style.backgroundColor).toBe("rgb(0, 0, 0)");
  });

  // 黑底色塊會蓋掉 SegmentedControl 的選中指示器（它只是換一階背景灰）⇒ 三格
  // 長得一模一樣，使用者看不出自己選了哪個。噓推錯了收不回來，這不是外觀問題。
  test("看得出選了哪一個（色塊蓋掉了 Mantine 的選中指示器）", () => {
    renderModal();
    expect(swatch("push").style.opacity).toBe("1");
    expect(Number(swatch("boo").style.opacity)).toBeLessThan(1);
    expect(Number(swatch("arrow").style.opacity)).toBeLessThan(1);

    fireEvent.click(
      document.querySelector('input[name="longPushType"][value="arrow"]'),
    );
    expect(swatch("arrow").style.opacity).toBe("1");
    expect(Number(swatch("push").style.opacity)).toBeLessThan(1);
  });

  test("禁噓板：噓那一項不上色（內聯顏色會蓋掉 Mantine 的 disabled 樣式）", () => {
    renderModal({ preflight: { blocked: false, booAllowed: false } });
    expect(swatch("boo")).toBeNull();
    // 其他兩項照樣上色
    expect(swatch("push").style.color).toBe("rgb(255, 255, 0)");
    // 文字本身不能不見
    expect(screen.getByText(i18n("longPushModal_typeBoo"))).toBeTruthy();
  });
});

describe("即時則數", () => {
  test("空白時是 0 則、送出鍵停用", () => {
    renderModal();
    expect(segmentsText()).toContain("0");
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirm") }),
    ).toBeDisabled();
  });

  test("依 Big5 byte 上限算出則數", () => {
    renderModal({ maxBytes: 20 });
    type("測".repeat(30)); // 60 bytes，20 bytes/則（段末全形讓 1 byte）
    expect(segmentsText()).toContain("4");
  });
});

describe("非 Big5 字元", () => {
  test("提示會被略過，而且交出去的內容已經濾掉了", () => {
    const { onConfirm } = renderModal();
    type("好耶🎉");
    expect(document.body.textContent).toContain("🎉");
    submit();
    expect(onConfirm).toHaveBeenCalledWith({ text: "好耶", type: "push" });
  });
});

describe("推文類型", () => {
  test("預設是「推」", () => {
    const { onConfirm } = renderModal();
    type("安安");
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("push");
  });

  test("可以改成噓", () => {
    const { onConfirm } = renderModal();
    type("安安");
    fireEvent.click(screen.getByText(i18n("longPushModal_typeBoo")));
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("boo");
  });
});

describe("超過 20 則的二次確認", () => {
  test("第一次送出只跳警示、不真的送；再按一次才送", () => {
    const { onConfirm } = renderModal({ maxBytes: 4 });
    type("測".repeat(30)); // 4 bytes/則 ⇒ 遠超過 20 則
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirmAnyway") }),
    ).toBeTruthy();

    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("確認後又改內容 → 確認重新算數（不會一路送出去）", () => {
    const { onConfirm } = renderModal({ maxBytes: 4 });
    type("測".repeat(30));
    submit(); // 進入確認狀態
    type("測".repeat(40)); // 則數變了
    submit();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("20 則以內直接送", () => {
    const { onConfirm } = renderModal({ maxBytes: 20 });
    type("測".repeat(30));
    submit();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

// 圖片上傳：上傳完的網址要插進**這個 Textarea**，不是複製到剪貼簿、更不是送給
// PTT（此時底下的畫面是文章列表，每個字元都會變成快捷鍵）。
describe("圖片上傳插入目標", () => {
  test("開著時註冊目標、關掉時清掉同一個目標", () => {
    const imageUpload = fakeUpload();
    const { show } = renderModal({ imageUpload });
    expect(imageUpload.setInsertTarget).toHaveBeenCalledTimes(1);
    const target = imageUpload.setInsertTarget.mock.calls[0][0];
    expect(typeof target.insert).toBe("function");

    show(false);
    expect(imageUpload.clearInsertTarget).toHaveBeenCalledTimes(1);
    // 傳自己回去：避免「A 關閉時把後開的 B 清掉」。
    expect(imageUpload.clearInsertTarget.mock.calls[0][0]).toBe(target);
  });

  test("enableImageUpload 關閉時不註冊（否則判成 target 卻沒東西可插）", () => {
    const imageUpload = fakeUpload({ enabled: () => false });
    renderModal({ imageUpload });
    expect(imageUpload.setInsertTarget).not.toHaveBeenCalled();
  });

  test("插在游標處，不是尾端", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload });
    type("前面後面");
    const el = textarea();
    el.selectionStart = 2;
    el.selectionEnd = 2;
    const target = imageUpload.setInsertTarget.mock.calls[0][0];
    act(() => target.insert("https://i.urusai.cc/ab.png"));
    expect(textarea().value).toBe("前面 https://i.urusai.cc/ab.png 後面");
  });

  test("插入後即時則數重算", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload, maxBytes: 20 });
    type("安安");
    const before = segmentsText();
    const target = imageUpload.setInsertTarget.mock.calls[0][0];
    act(() => target.insert("https://i.urusai.cc/ab.png"));
    // 網址 26 bytes 比上限（20）長 ⇒ 一定會多切出好幾則。
    expect(segmentsText()).not.toBe(before);
    expect(textarea().value).toContain("https://i.urusai.cc/ab.png");
  });

  test("Textarea 的貼上轉給 tryClipboardImage（截圖直接 Ctrl+V）", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload });
    fireEvent.paste(textarea(), { clipboardData: { files: [], items: [] } });
    expect(imageUpload.tryClipboardImage).toHaveBeenCalled();
  });

  test("「插入圖片」按鈕開檔案選擇器", () => {
    const imageUpload = fakeUpload();
    renderModal({ imageUpload });
    fireEvent.click(
      screen.getByRole("button", { name: i18n("longPushModal_uploadImage") }),
    );
    expect(imageUpload.openFilePicker).toHaveBeenCalled();
  });

  test("關閉上傳功能時不出現「插入圖片」按鈕", () => {
    renderModal({ imageUpload: fakeUpload({ enabled: () => false }) });
    expect(
      screen.queryByRole("button", { name: i18n("longPushModal_uploadImage") }),
    ).toBeNull();
  });
});

// URL 比單則上限還長時只能硬切（PTT 沒有「不切」這個選項）⇒ 事先告知，但
// **不擋送出**：二次確認是給「會跑好幾分鐘」用的，這裡攔下來反而礙事。
describe("網址過長警告", () => {
  const LONG_URL = "https://i.urusai.cc/abcdefgh.png"; // 32 bytes

  test("網址比上限長 → 出警告，但送出鍵仍可按", () => {
    renderModal({ maxBytes: 20 });
    type("看這個 " + LONG_URL);
    expect(document.body.textContent).toContain(
      i18n("longPushModal_urlTooLong"),
    );
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirm") }),
    ).not.toBeDisabled();
  });

  test("網址塞得下就不出警告", () => {
    renderModal({ maxBytes: 40 });
    type("看這個 " + LONG_URL);
    expect(document.body.textContent).not.toContain(
      i18n("longPushModal_urlTooLong"),
    );
  });

  test("沒有網址時不出警告", () => {
    renderModal({ maxBytes: 4 });
    type("測".repeat(30));
    expect(document.body.textContent).not.toContain(
      i18n("longPushModal_urlTooLong"),
    );
  });
});

// ---------------------------------------------------------------------------
// 探路帶回來的事實（LongPushSession.startPreflight 從 PTT 畫面讀到的，不是猜的）
// ---------------------------------------------------------------------------
describe("探路的事實", () => {
  test("沒探過路 → 維持原本那句推測語氣的提示，什麼都不多畫", () => {
    renderModal();
    expect(screen.getByText(i18n("longPushModal_typeNote"))).toBeTruthy();
    expect(screen.queryByTestId("longPushArrowNote")).toBeNull();
    expect(screen.queryByTestId("longPushCooldownNote")).toBeNull();
    expect(screen.queryByTestId("longPushNoBooNote")).toBeNull();
  });

  test("PTT 已判定會降級成 → ：用肯定句取代那句推測", () => {
    renderModal({ preflight: { blocked: false, degraded: true } });
    expect(screen.getByTestId("longPushArrowNote")).toBeTruthy();
    expect(screen.queryByText(i18n("longPushModal_typeNote"))).toBeNull();
  });

  test("禁噓板：噓不可選，已選的會被改回推", () => {
    renderModal({ preflight: { blocked: false, booAllowed: false } });
    expect(screen.getByTestId("longPushNoBooNote")).toBeTruthy();
    // Mantine 的 SegmentedControl 是一組同名 radio。
    const boo = document.querySelector('input[name="longPushType"][value="boo"]');
    expect(boo.disabled).toBe(true);
    expect(
      document.querySelector('input[name="longPushType"]:checked').value,
    ).toBe("push");
  });

  test("冷卻中：提示秒數與 PTT 原文，但**不擋送出**", () => {
    const { onConfirm } = renderModal({
      preflight: {
        blocked: false,
        cooldownSec: 30,
        cooldownMessage: "本板禁止快速連續推文，請再等 30 秒",
      },
    });
    const note = screen.getByTestId("longPushCooldownNote");
    expect(note.textContent).toContain("30");
    // PTT 的原文照錄（改版了也照樣轉達）。
    expect(note.textContent).toContain("本板禁止快速連續推文，請再等 30 秒");

    fireEvent.change(document.querySelector('[name="longPushText"]'), {
      target: { value: "等一下就好" },
    });
    fireEvent.click(screen.getByText(i18n("longPushModal_confirm")));
    expect(onConfirm).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 鍵盤送出：打完一大段話不必把手移到滑鼠。
//
// 行為端**不分平台**——Mac 的 ⌘ 與其他平台的 Ctrl 一律都收（同 long_push_gate 的
// 慣例）；只有按鈕上那行提示文字會依平台變（src/js/platform.js）。
// ---------------------------------------------------------------------------
describe("鍵盤送出", () => {
  // 回傳值 false ＝ 有 preventDefault（Chrome 的 textarea 會為 Ctrl+Enter 插一個
  // 換行，不擋掉的話送出的內容會多一段）。
  const pressEnter = (init) =>
    fireEvent.keyDown(textarea(), { key: "Enter", ...init });

  test("Ctrl+Enter 直接送出，交出去的內容一樣是過濾過的", () => {
    const { onConfirm } = renderModal();
    type("好耶🎉");
    expect(pressEnter({ ctrlKey: true })).toBe(false); // 換行被擋掉
    expect(onConfirm).toHaveBeenCalledWith({ text: "好耶", type: "push" });
  });

  test("Mac 的 ⌘+Enter 一樣送得出去", () => {
    const { onConfirm } = renderModal();
    type("安安");
    pressEnter({ metaKey: true });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("單獨 Enter 不送出（要留給換行）", () => {
    const { onConfirm } = renderModal();
    type("安安");
    expect(pressEnter()).toBe(true); // 沒有 preventDefault ⇒ 照樣換行
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("中文組字中的 Enter 不送出（IME 用它上字）", () => {
    const { onConfirm } = renderModal();
    type("安安");
    expect(pressEnter({ ctrlKey: true, isComposing: true })).toBe(true);
    expect(pressEnter({ ctrlKey: true, keyCode: 229 })).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("空白時按 Ctrl+Enter 什麼都不會發生（同送出鍵停用）", () => {
    const { onConfirm } = renderModal();
    pressEnter({ ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("超過 20 則時 Ctrl+Enter 也要先問一次（與按鈕同一條路）", () => {
    const { onConfirm } = renderModal({ maxBytes: 4 });
    type("測".repeat(30));
    pressEnter({ ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: i18n("longPushModal_confirmAnyway") }),
    ).toBeTruthy();
    pressEnter({ ctrlKey: true });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("按鈕上看得到快捷鍵提示", () => {
    renderModal();
    expect(screen.getByTestId("longPushSubmitHint").textContent).toMatch(
      /Enter$/,
    );
  });

  test("提示不能混進送出鍵的 accessible name（aria-hidden）", () => {
    renderModal();
    // 少了 aria-hidden，name 會變成「開始送出 Ctrl+Enter」⇒ 所有用按鈕名稱抓元素
    // 的測試（含 e2e）一起靜默失效。
    const button = screen.getByRole("button", {
      name: i18n("longPushModal_confirm"),
    });
    expect(button.getAttribute("aria-keyshortcuts")).toContain("Enter");
    expect(screen.getByTestId("longPushSubmitHint").closest("[aria-hidden]"))
      .toBeTruthy();
  });
});

// ── 型別每次開框重設為「推」────────────────────────────────────────────────
//
// 元件跨開關保持掛載，type 以前刻意不重置 ⇒ 上次選的噓會沿用到下一次開框，
// 而使用者按 X 的預期一律是「推」。噓推錯是收不回來的（PTT 沒有撤回 API）。
describe("推文類型每次開框都回到「推」", () => {
  test("上次選了噓，關掉再開回到推", () => {
    const { onConfirm, show } = renderModal();
    fireEvent.click(screen.getByText(i18n("longPushModal_typeBoo")));
    show(false);
    show(true);
    type("安安");
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("push");
  });

  test("上次選了 →（箭頭）同理", () => {
    const { onConfirm, show } = renderModal();
    fireEvent.click(screen.getByText(i18n("longPushModal_typeArrow")));
    show(false);
    show(true);
    type("安安");
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("push");
  });

  test("同一次開框內選了噓還是送噓（不是每次 render 都重置）", () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByText(i18n("longPushModal_typeBoo")));
    type("安安");
    submit();
    expect(onConfirm.mock.calls[0][0].type).toBe("boo");
  });
});

// ── 草稿暫存 ──────────────────────────────────────────────────────────────
//
// 打到一半誤關輸入框（或整個分頁）不可以白打。單一份、不綁文章 ⇒ 還原時一定要
// 講一聲並給清除鍵，不可以默默塞進去（在 A 文章打的會出現在 B 文章）。
describe("草稿暫存", () => {
  test("打一半關掉，再開回來內容還在", () => {
    const { show } = renderModal();
    type("打到一半的推文");
    show(false);
    show(true);
    expect(textarea().value).toBe("打到一半的推文");
    expect(readDraft()).toBe("打到一半的推文");
  });

  // 重置 effect（setValue(readDraft())）與草稿寫入的執行順序陷阱：show false→true
  // 那一次 commit 裡 value 還是**舊值**。只要寫入沾到 show，就會拿它蓋掉剛讀回來
  // 的草稿 —— 最惡劣的情況就是這一支：上次已經送成功、session 的 onSent 清過草稿，
  // 元件裡的 value 卻還留著整段文字 ⇒ 一開框就把已經送出去的內容復活成草稿。
  test("送成功清過草稿之後再開框，不會把已送出的內容復活", () => {
    const { show } = renderModal();
    type("已經送出去的內容");
    show(false);
    clearDraft(); // ＝ LongPushSession._finish({kind:'done'}) → onSent
    show(true);
    expect(readDraft()).toBe("");
    expect(textarea().value).toBe("");
    expect(screen.queryByTestId("longPushDraftNote")).toBeNull();
  });

  test("草稿是空的時候開框就是空的", () => {
    renderModal();
    expect(textarea().value).toBe("");
  });

  test("帶回草稿時會講一聲（單一份不綁文章，可能是別篇留下來的）", () => {
    const { show } = renderModal();
    type("上次留下來的");
    expect(screen.queryByTestId("longPushDraftNote")).toBeNull();
    show(false);
    show(true);
    expect(screen.queryByTestId("longPushDraftNote")).toBeTruthy();
  });

  test("按「清除」把草稿與輸入框一起清掉，提示也消失", () => {
    const { show } = renderModal();
    type("上次留下來的");
    show(false);
    show(true);
    fireEvent.click(
      screen.getByRole("button", { name: i18n("longPushModal_draftClear") }),
    );
    expect(textarea().value).toBe("");
    expect(readDraft()).toBe("");
    expect(screen.queryByTestId("longPushDraftNote")).toBeNull();
  });

  test("自己打字打出來的內容不算「還原」，不跳提示", () => {
    renderModal();
    type("現在才打的");
    expect(screen.queryByTestId("longPushDraftNote")).toBeNull();
  });

  test("插入圖片網址也會寫進草稿", () => {
    const upload = fakeUpload();
    renderModal({ imageUpload: upload });
    type("看這張");
    act(() =>
      upload.setInsertTarget.mock.calls[0][0].insert(
        "https://i.urusai.cc/a.png",
      ),
    );
    expect(readDraft()).toContain("https://i.urusai.cc/a.png");
  });

  test("送出不清草稿（可能送到一半失敗，清空的責任在 session 的 onSent）", () => {
    const { onConfirm } = renderModal();
    type("安安");
    submit();
    expect(onConfirm).toHaveBeenCalled();
    expect(readDraft()).toBe("安安");
  });
});
