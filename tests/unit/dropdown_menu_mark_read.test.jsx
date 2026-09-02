// 右鍵選單的「前已讀後未讀」項：有目標才畫、點下去要走 markReadUnread handler。
//
// gating 刻意**全部**收在 list_session.markReadTargetAtRow（狀態／置底文／header
// 列），選單只認 markReadTarget 這一個 prop —— 兩邊各判一次遲早會漂移。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import DropdownMenu from "../../src/components/ContextMenu/DropdownMenu";
import { setupI18n, i18n } from "../../src/js/i18n";
import { zh_TW } from "../../src/js/zh_TW_messages";
import { en_US } from "../../src/js/en_US_messages";

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

const renderMenu = (props = {}) =>
  render(
    <MantineProvider>
      <DropdownMenu
        open
        onHide={() => {}}
        pageX={10}
        pageY={10}
        urlEnabled={false}
        normalEnabled={true}
        selEnabled={false}
        quickSearchItems={[]}
        quickSearchQuery=""
        authorBlacklistId={null}
        authorBlacklistExists={false}
        titleBlacklistText={null}
        markReadTarget={null}
        articleLinkEnabled={false}
        imageUploadEnabled={false}
        inputHelperEnabled={false}
        liveArticleHelperEnabled={false}
        longPushEnabled={false}
        contextArticle={null}
        previews={{}}
        onTitleBlacklistClick={() => {}}
        onLongPushClick={() => {}}
        onMenuSelect={() => {}}
        onInputHelperClick={() => {}}
        onLiveArticleHelperClick={() => {}}
        onSettingsClick={() => {}}
        onQuickSearchSelect={() => {}}
        {...props}
      />
    </MantineProvider>,
  );

beforeAll(() => setupI18n());

const label = () => i18n("cmenu_markReadUnread");

describe("右鍵選單：前已讀後未讀", () => {
  test("沒有目標（非列表好讀、header 列、置底文）→ 不畫", () => {
    renderMenu();
    expect(screen.queryByText(label(), { exact: true })).toBeNull();
  });

  test("有目標 → 畫出來，點下去帶著 markReadUnread 進 handler", () => {
    const onMenuSelect = vi.fn();
    renderMenu({ markReadTarget: { num: 4213 }, onMenuSelect });
    const item = screen.getByText(label(), { exact: true });
    expect(item).toBeTruthy();
    fireEvent.click(item);
    expect(onMenuSelect).toHaveBeenCalledWith(
      "markReadUnread",
      expect.anything(),
    );
  });

  test("在連結上（normalEnabled false）→ 不畫", () => {
    renderMenu({
      normalEnabled: false,
      urlEnabled: true,
      markReadTarget: { num: 4213 },
    });
    expect(screen.queryByText(label(), { exact: true })).toBeNull();
  });

  // D1：不加確認 modal ⇒ 選單文字就是使用者唯一的事前說明，兩語系都要把
  // 「哪一邊變已讀、哪一邊變未讀」講出來，不能縮成「前已讀後未讀」五個字。
  test("兩語系的文案都要講清楚後果", () => {
    expect(zh_TW.cmenu_markReadUnread.message).toContain("以前");
    expect(zh_TW.cmenu_markReadUnread.message).toContain("已讀");
    expect(zh_TW.cmenu_markReadUnread.message).toContain("未讀");
    expect(en_US.cmenu_markReadUnread.message).toMatch(/read/i);
    expect(en_US.cmenu_markReadUnread.message).toMatch(/unread/i);
  });
});
