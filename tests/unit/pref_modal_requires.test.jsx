// @unit-env browser
// 設定頁勾選列的「前置開關」：上層關掉 ⇒ 下層反灰；安全模式蓋掉上層 ⇒ 下層一起反灰。
//
// 架構 review A7 第九步把這些條件從 PrefModal 各列的 disabled={...} 搬進設定索引
// （src/js/pref_search.js 的 requires）。這支是搬家前後都要綠的行為表：每一列逐一
// 把它的前置開關關掉／打開安全模式，看它是不是反灰；其他列不受影響。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import {
  PrefModal,
  PREF_CATEGORIES,
} from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { prefItem } from "../../src/js/pref_search";

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

const PREF_KEY = "pttchrome.pref.v1";

// 前置開關都開著（各列可以改）的基準值。
const ALL_ON = {
  enableEasyReading: true,
  enableEasyReadingList: true,
  enableRecentArticles: true,
  enableNextArticleCard: true,
  enableLongPush: true,
  enableCommentBar: true,
  mobileAnyKeyContinue: true,
  useImgurProxy: true,
  enableFollowList: true,
  easyReadingEndSwitchNative: true,
  enableCommandPalette: true,
  useMouseBrowsing: true,
  mouseWheel: 1,
  useProxy: true,
  mergeSameAuthorComments: true,
  nativeSafeMode: false,
};

// [這一列, 關掉哪幾個值會讓它反灰（逐一試）, 安全模式會不會讓它反灰]
const TABLE = [
  ["enableHelpMenuPopup", ["enableEasyReading"], true],
  ["enableListFastScroll", ["enableEasyReadingList"], true],
  ["resumeRecentArticles", ["enableRecentArticles"], false],
  ["nextArticleSameSubject", ["enableNextArticleCard"], true],
  ["pushKeyOpensLongPush", ["enableLongPush"], true],
  ["enableCommentBar", ["enableLongPush"], true],
  ["commentReplyMenu", ["enableLongPush", "enableCommentBar"], true],
  ["mobileCommentBarFold", ["enableLongPush", "enableCommentBar"], true],
  ["commentBarCounter", ["enableLongPush", "enableCommentBar"], true],
  ["mobilePostInfoActions", ["mobileAnyKeyContinue"], false],
  ["imageProxyImgur", ["useImgurProxy"], false],
  ["imageProxyTwimg", ["useImgurProxy"], false],
  ["imageProxyCatbox", ["useImgurProxy"], false],
  ["imageProxyTenor", ["useImgurProxy"], false],
  ["enableFollowOnly", ["enableFollowList"], false],
  // 勾選列以外的欄位（熱鍵、下拉、文字、名單）。安全模式只管勾選列，這些照舊不反灰。
  ["easyReadingEndSwitchKey", ["easyReadingEndSwitchNative"], false],
  ["commandPaletteKey", ["enableCommandPalette"], false],
  ["paletteQuickBoards", ["enableCommandPalette"], false],
  ["mouseBrowsingHighlight", ["useMouseBrowsing"], false],
  ["mouseLeftClick", ["useMouseBrowsing"], false],
  ["mouseListClickStart", ["useMouseBrowsing"], false],
  ["mousePushClickStart", ["useMouseBrowsing"], false],
  ["mousePushClickEnd", ["useMouseBrowsing"], false],
  ["mouseEdgePaging", ["useMouseBrowsing"], false],
  ["mouseFunctionKeys", ["useMouseBrowsing"], false],
  ["mouseMiddleClick", ["useMouseBrowsing"], false],
  ["mouseWheel", ["useMouseBrowsing"], false],
  ["mouseWheelSmoothScroll", ["useMouseBrowsing", "mouseWheel"], false],
  ["mouseBackNav", ["useMouseBrowsing"], false],
  ["mouseServerReport", ["useMouseBrowsing"], false],
  ["proxyUrl", ["useProxy"], false],
  ["imgurProxyUrl", ["useImgurProxy"], false],
  ["mergedCommentEachTime", ["mergeSameAuthorComments"], false],
  ["followList", ["enableFollowList"], false],
  ["followTitleList", ["enableFollowList"], false],
];

// 「關掉」：勾選類是 false；mouseWheel 是數字下拉（0＝關）。
const OFF = { mouseWheel: 0 };

const openTabOf = (key, prefs) => {
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...ALL_ON, ...prefs } }),
  );
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
  const cat = PREF_CATEGORIES.find((c) => c.value === prefItem(key).tab);
  const tab = screen.getByRole("tab", { name: i18n(cat.labelKey) });
  fireEvent.click(tab);
  const panel = document.getElementById(tab.getAttribute("aria-controls"));
  return panel.querySelector(`[name="${key}"]`);
};

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

describe("設定頁勾選列的前置開關", () => {
  test.each(TABLE)("%s：前置都開著可以改", (key) => {
    expect(openTabOf(key, {})).toBeEnabled();
  });

  test.each(TABLE)("%s：前置關掉任一個就反灰", (key, parents) => {
    for (const p of parents) {
      document.body.innerHTML = "";
      const el = openTabOf(key, { [p]: p in OFF ? OFF[p] : false });
      expect(el, `${key} 在 ${p} 關掉時`).toBeDisabled();
    }
  });

  test.each(TABLE)("%s：安全模式", (key, _parents, bySafeMode) => {
    const el = openTabOf(key, { nativeSafeMode: true });
    if (bySafeMode) expect(el).toBeDisabled();
    else expect(el).toBeEnabled();
  });

  test("上層在設定頁裡當場關掉，下層馬上反灰（不用重開設定頁）", () => {
    const child = openTabOf("commentReplyMenu", {});
    expect(child).toBeEnabled();
    const parent = document.querySelector('[name="enableCommentBar"]');
    fireEvent.click(parent);
    expect(document.querySelector('[name="commentReplyMenu"]')).toBeDisabled();
  });
});
