// 右鍵選單的快速搜尋區塊：**一層平鋪**（不再是「快速搜尋 →」子選單），每項自帶
// 關鍵字，點擊把整個 item 交回上層（上層再用 buildQuickSearchUrl 組網址）。
//
// 回歸守護：舊版寫死一筆 goo.gl 在元件裡、Google 搜尋另外走 onMenuSelect("searchGoogle")，
// 兩個入口都被收編到這條清單，元件不得再自己持有任何 provider。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import DropdownMenu from "../../src/components/ContextMenu/DropdownMenu";
import { setupI18n, i18n } from "../../src/js/i18n";
import { visibleQuickSearchItems } from "../../src/js/quick_search";

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

const renderMenu = (props = {}) => {
  const onQuickSearchSelect = vi.fn();
  render(
    <MantineProvider>
      <DropdownMenu
        open
        onHide={() => {}}
        pageX={10}
        pageY={10}
        urlEnabled={false}
        normalEnabled={false}
        selEnabled
        mouseBrowsingEnabled={false}
        quickSearchItems={[]}
        quickSearchQuery=""
        authorBlacklistId={null}
        authorBlacklistExists={false}
        titleBlacklistText={null}
        onTitleBlacklistClick={() => {}}
        onMenuSelect={() => {}}
        onInputHelperClick={() => {}}
        onLiveArticleHelperClick={() => {}}
        onSettingsClick={() => {}}
        onQuickSearchSelect={onQuickSearchSelect}
        {...props}
      />
    </MantineProvider>,
  );
  return { onQuickSearchSelect };
};

beforeAll(() => setupI18n());

describe("右鍵選單：快速搜尋是一層", () => {
  test("純數字選取 → 三個內建項目全部平鋪在同一層，各自帶關鍵字", () => {
    const query = "126291399";
    renderMenu({
      quickSearchItems: visibleQuickSearchItems({}, query),
      quickSearchQuery: query,
    });

    const items = document.querySelectorAll(".DropdownMenu__QuickSearch");
    expect(items).toHaveLength(3);
    for (const el of items) {
      expect(el.textContent).toContain(query);
    }
    expect(items[0].textContent).toContain(i18n("quicksearch_builtin_google"));
    expect(items[1].textContent).toContain(
      i18n("quicksearch_builtin_pixivUser"),
    );
  });

  test("沒有子選單觸發項（舊版的「快速搜尋 →」已移除）", () => {
    renderMenu({
      quickSearchItems: visibleQuickSearchItems({}, "台北"),
      quickSearchQuery: "台北",
    });
    expect(document.querySelector(".mantine-Menu-sub")).toBeNull();
    // 舊 i18n key 也一併移除 → i18n() 回 undefined，不該有元素叫這名字
    expect(screen.queryByText(/在 Google 上搜尋/)).toBeNull();
    expect(screen.queryByText("goo.gl")).toBeNull();
  });

  test("點擊把整個 item 交回上層（含 urlTemplate，不是 label）", () => {
    const items = visibleQuickSearchItems({}, "42");
    const { onQuickSearchSelect } = renderMenu({
      quickSearchItems: items,
      quickSearchQuery: "42",
    });

    fireEvent.click(document.querySelectorAll(".DropdownMenu__QuickSearch")[1]);
    expect(onQuickSearchSelect).toHaveBeenCalledTimes(1);
    expect(onQuickSearchSelect.mock.calls[0][0]).toMatchObject({
      id: "pixiv-user",
      urlTemplate: "https://www.pixiv.net/users/%s",
    });
  });

  test("沒有選取（normalEnabled）時完全不畫快速搜尋", () => {
    renderMenu({
      selEnabled: false,
      normalEnabled: true,
      quickSearchItems: [],
      quickSearchQuery: "",
    });
    expect(document.querySelectorAll(".DropdownMenu__QuickSearch")).toHaveLength(
      0,
    );
  });
});
