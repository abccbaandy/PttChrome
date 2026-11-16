// @unit-env browser
// 設定頁改一格只重畫那一格（A7 第一步，docs/build-modernization.md「設定頁重畫」）。
//
// PrefModal 的 values 是一整個 state：改任何一個值整份元件重畫。勾選列（PrefCheckbox）、
// 數字欄（PrefNumber）、下拉選單（PrefSelect）與灰字說明（PrefHint）包了 React.memo，
// props 沒變就跳過；這支測試數 Mantine Checkbox／NumberInput／Select 的 render 次數，
// 鎖住「改一格 ⇒ 只有那格重畫」。PrefSelect 的 options 必須是元件外的常數。
// 會讓它紅的改法：拿掉 memo、把 onCheckboxChange／onNumberChange 改成每次 render 都換
// 一個新函式、在 <PrefCheckbox>／<PrefNumber> 上傳 inline 物件／函式 prop。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";

const counter = vi.hoisted(() => ({
  renders: new Map(),
  numbers: new Map(),
  selects: new Map(),
  texts: new Map(),
}));

vi.mock("@mantine/core", async (importOriginal) => {
  const mod = await importOriginal();
  const counting = (Real, map) =>
    Object.assign((props) => {
      // 沒有 name 的（快速搜尋自訂列、設定搜尋框）以 label／aria-label 計。
      const key = props.name ?? (props["aria-label"] || props.label);
      map.set(key, (map.get(key) || 0) + 1);
      return <Real {...props} />;
    }, Real);
  return {
    ...mod,
    Checkbox: counting(mod.Checkbox, counter.renders),
    NumberInput: counting(mod.NumberInput, counter.numbers),
    Select: counting(mod.Select, counter.selects),
    TextInput: counting(mod.TextInput, counter.texts),
    Textarea: counting(mod.Textarea, counter.texts),
  };
});

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

vi.mock("../../src/js/prompt_api", () => ({
  promptApiAvailability: () => Promise.resolve("available"),
  ensurePromptApiModel: vi.fn(() => Promise.resolve("available")),
  destroyPromptApi: vi.fn(),
}));

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

// 已收成 PrefSelect 的下拉選單。不在這裡的只剩快速搜尋自訂列的「比對」（一列一個、
// 沒有 name，下一步跟自訂列一起收）。
const MEMO_SELECTS = new Set([
  "termSizeMode",
  "mobileLayout",
  "mobileFontSize",
  "mouseListClickStart",
  "mousePushClickStart",
  "mousePushClickEnd",
  "mouseMiddleClick",
  "mouseWheel",
  "mouseBackNav",
  "connectionProtocol",
  "connectionEncoding",
  "autoLoginDupConn",
]);
// 一定會畫出來的那些（連線方式只在支援 SSH 的瀏覽器、自動登入只在該分頁打開時才畫）。
const ALWAYS_SELECTS = [
  "connectionEncoding",
  "mobileFontSize",
  "mobileLayout",
  "mouseBackNav",
  "mouseListClickStart",
  "mouseMiddleClick",
  "mousePushClickEnd",
  "mousePushClickStart",
  "mouseWheel",
  "termSizeMode",
];
const memoSelects = () =>
  [...counter.selects.keys()].filter((name) => MEMO_SELECTS.has(name));

function openGeneralTab() {
  render(
    <MantineProvider>
      <PrefModal
        show
        onSave={() => {}}
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_general") }));
}

test("勾一格：只有那一格的 Checkbox 重畫，其他勾選列不動", () => {
  openGeneralTab();
  const box = document.querySelector('input[name="enablePicPreview"]');
  expect(box).not.toBeNull();
  const rowsBefore = counter.renders.size;
  // 一般分頁有八十幾個勾選列；這個數字太小代表計數包裝沒接上，測試會假綠。
  expect(rowsBefore).toBeGreaterThan(50);

  counter.renders.clear();
  counter.numbers.clear();
  counter.selects.clear();
  fireEvent.click(box);
  expect(box).not.toBeChecked();

  // 快速搜尋分頁的內建項目（children 是名稱＋灰字網址樣板的 JSX）也算在內：標題在
  // PrefModal 裡只建一次，memo 照樣擋得住。
  const rerendered = [...counter.renders.keys()];
  // enablePicPreview 沒有子開關 ⇒ 除了它自己，一格都不該重畫。
  expect(rerendered).toEqual(["enablePicPreview"]);
  // 數字欄、PrefSelect 管的下拉選單一格都不動。
  expect([...counter.numbers.keys()]).toEqual([]);
  expect(memoSelects()).toEqual([]);
});

test("改一個數字欄：只有那一欄重畫，勾選列與其他數字欄不動", () => {
  openGeneralTab();
  const field = document.querySelector('input[name="antiIdleTime"]');
  expect(field).not.toBeNull();
  // 一般分頁的數字欄（防閒置、自動換行、邊界…）；太少代表計數包裝沒接上。
  expect(counter.numbers.size).toBeGreaterThan(3);

  counter.renders.clear();
  counter.numbers.clear();
  counter.selects.clear();
  fireEvent.change(field, { target: { value: "123" } });
  expect(field).toHaveValue("123");

  expect([...counter.numbers.keys()]).toEqual(["antiIdleTime"]);
  expect(memoSelects()).toEqual([]);
  expect([...counter.renders.keys()]).toEqual([]);
});

test("PrefSelect 有被計數（不然上面「不動」會假綠）", () => {
  openGeneralTab();
  expect(memoSelects().sort()).toEqual(expect.arrayContaining(ALWAYS_SELECTS));
});

test("改一個數字型下拉選單（滑鼠滾輪）：只有那一顆重畫", () => {
  openGeneralTab();
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_mouse") }));
  counter.selects.clear();
  counter.renders.clear();
  // 點開選單選「無」（同 pref_modal_mouse_tab 的 pick）。
  const input = [
    ...document.querySelectorAll("input[aria-haspopup='listbox']"),
  ].find((el) => el.getAttribute("aria-label") === i18n("options_mouseWheel"));
  fireEvent.click(input);
  fireEvent.click(
    [
      ...document
        .getElementById(input.getAttribute("aria-controls"))
        .querySelectorAll("[role='option']"),
    ].find((el) => el.textContent === i18n("options_none")),
  );
  expect(input).toHaveValue(i18n("options_none"));
  expect(memoSelects()).toEqual(["mouseWheel"]);
  // 平滑捲動掛在滾輪底下（disabled={!mouseWheel}）⇒ 它本來就該跟著重畫，其他勾選列不動。
  expect([...counter.renders.keys()]).toEqual(["mouseWheelSmoothScroll"]);
});

// 已收成 PrefHotkey／PrefText／PrefTextarea 的欄位（其餘 TextInput 帶額外屬性，還沒做）。
const MEMO_TEXTS = new Set([
  "easyReadingEndSwitchKey",
  "aidNavBackKey",
  "deepLinkCopyKey",
  "unreadJumpKey",
  "commandPaletteKey",
  "fontFace",
  "proxyUrl",
  "sshRelayUrl",
  "imgurProxyUrl",
  "blacklist",
  "titleBlacklist",
  "followList",
  "followTitleList",
  "imageUploadToken",
  "autoLoginUser",
  "autoLoginPassword",
  "autoLoginOtpSecret",
]);
const memoTexts = () =>
  [...counter.texts.keys()].filter((name) => MEMO_TEXTS.has(name));

test("勾一格：熱鍵欄、文字欄、名單欄一格都不重畫", () => {
  openGeneralTab();
  // 一般分頁的熱鍵欄與字型欄；太少代表計數包裝沒接上，下面的「不動」會假綠。
  expect(memoTexts().length).toBeGreaterThanOrEqual(6);

  counter.texts.clear();
  fireEvent.click(document.querySelector('input[name="enablePicPreview"]'));
  expect(memoTexts()).toEqual([]);
});

test("在黑名單打字：只有黑名單那一格重畫", () => {
  openGeneralTab();
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_enhance") }));
  const area = document.querySelector('textarea[name="blacklist"]');
  expect(area).not.toBeNull();
  // 增強分頁的四個名單欄都有被計數（不然「不動」會假綠）。
  expect(
    ["blacklist", "titleBlacklist", "followList", "followTitleList"].every(
      (n) => counter.texts.has(n),
    ),
  ).toBe(true);

  counter.texts.clear();
  counter.renders.clear();
  fireEvent.change(area, { target: { value: "someone" } });
  expect(area).toHaveValue("someone");
  expect(memoTexts()).toEqual(["blacklist"]);
  expect([...counter.renders.keys()]).toEqual([]);
});

test("自動登入分頁打帳號：只有帳號欄重畫，密碼／2FA 欄與下拉選單不動", () => {
  openGeneralTab();
  fireEvent.click(
    screen.getByRole("tab", { name: i18n("options_autoLoginTab") }),
  );
  const user = document.querySelector('input[name="autoLoginUser"]');
  expect(user).not.toBeNull();
  // 三個憑證欄＋重複連線下拉都有被計數（不然「不動」會假綠）。
  expect(
    ["autoLoginUser", "autoLoginPassword", "autoLoginOtpSecret"].every((n) =>
      counter.texts.has(n),
    ),
  ).toBe(true);
  expect(counter.selects.has("autoLoginDupConn")).toBe(true);

  counter.texts.clear();
  counter.selects.clear();
  fireEvent.change(user, { target: { value: "someone" } });
  expect(user).toHaveValue("someone");
  expect(memoTexts()).toEqual(["autoLoginUser"]);
  expect(memoSelects()).toEqual([]);
});

test("快速搜尋自訂項目：改一列的名稱只重畫那一列，其他列與內建項目不動", () => {
  window.localStorage.setItem(
    "pttchrome.pref.v1",
    JSON.stringify({
      values: {
        quickSearchCustom: [
          {
            id: "c1",
            name: "甲",
            urlTemplate: "https://a.test/?q=%s",
            match: "any",
            enabled: true,
          },
          {
            id: "c2",
            name: "乙",
            urlTemplate: "https://b.test/?q=%s",
            match: "any",
            enabled: true,
          },
          {
            id: "c3",
            name: "丙",
            urlTemplate: "https://c.test/?q=%s",
            match: "any",
            enabled: true,
          },
        ],
      },
    }),
  );
  openGeneralTab();
  fireEvent.click(
    screen.getByRole("tab", { name: i18n("options_quickSearch") }),
  );
  const names = screen.getAllByLabelText(i18n("options_quickSearchName"));
  expect(names).toHaveLength(3);
  // 三列都有被計數（不然下面的「只重畫一列」會假綠）。
  expect(counter.texts.get(i18n("options_quickSearchName"))).toBe(3);
  expect(counter.texts.get(i18n("options_quickSearchUrl"))).toBe(3);

  counter.texts.clear();
  counter.renders.clear();
  counter.selects.clear();
  fireEvent.change(names[1], { target: { value: "乙改" } });
  expect(names[1]).toHaveValue("乙改");
  // 只有第二列重畫：名稱＋網址兩個 TextInput、一個比對 Select、一個啟用勾勾。
  expect(counter.texts.get(i18n("options_quickSearchName"))).toBe(1);
  expect(counter.texts.get(i18n("options_quickSearchUrl"))).toBe(1);
  expect(counter.selects.get(i18n("options_quickSearchMatch"))).toBe(1);
  // 勾選列只有這一列的啟用勾勾（內建項目三列不動）。
  expect([...counter.renders.entries()]).toEqual([
    [i18n("options_quickSearchEnabled"), 1],
  ]);
});
