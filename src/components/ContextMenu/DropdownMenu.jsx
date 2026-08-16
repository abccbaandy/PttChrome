import { Fragment } from "react";
import { Menu } from "@mantine/core";
import { i18n } from "../../js/i18n";
import { quickSearchLabel } from "../../js/quick_search";
import "./DropdownMenu.css";

// 右鍵 context menu。改用 Mantine Menu（受控 opened，由 index.js 的 open 狀態驅動）：
// Menu.Target 是定位於游標 (pageX,pageY) 的零尺寸元素，floating-ui 自動處理超出邊界
// 翻轉（取代舊的手算 top()/left()）。快速搜尋是**一層**平鋪（不用 Menu.Sub），項目
// 由 index.jsx 依偏好＋選取內容算好後傳進來。
export const DropdownMenu = ({
  open,
  onHide,
  pageX,
  pageY,
  urlEnabled,
  normalEnabled,
  selEnabled,
  mouseBrowsingEnabled,
  quickSearchItems = [],
  quickSearchQuery = "",
  authorBlacklistId,
  authorBlacklistExists,
  titleBlacklistText,
  articleLinkEnabled,
  onTitleBlacklistClick,
  onMenuSelect,
  onInputHelperClick,
  onLiveArticleHelperClick,
  onSettingsClick,
  onQuickSearchSelect,
}) => {
  return (
    <Menu
      opened={open}
      onChange={(opened) => {
        if (!opened) onHide();
      }}
      position="bottom-start"
      offset={0}
      shadow="md"
      // 不給 width：寬度交給 DropdownMenu.css 的 max-content + max-width（動態寬度，
      // 長關鍵字單行省略號），舊的固定 220px 會把「Google 搜尋 '…'」擠成兩行。
      trapFocus={false}
      classNames={{ dropdown: "DropdownMenu" }}
    >
      <Menu.Target>
        <div
          style={{
            position: "fixed",
            top: pageY,
            left: pageX,
            width: 0,
            height: 0,
          }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        {/* 黑名單快速新增：右鍵落在作者/標題區塊才出現（見 index.js onContextMenu 的
            區塊判定）。作者已在黑名單 → 反灰顯示「已在黑名單」不給點（不隱藏，避免
            看起來像選項壞掉）。 */}
        {normalEnabled && authorBlacklistId && (
          <Menu.Item
            disabled={authorBlacklistExists}
            onClick={(e) => onMenuSelect("addAuthorBlacklist", e)}
          >
            {authorBlacklistExists
              ? `'${authorBlacklistId}' ${i18n("cmenu_authorBlacklistExists")}`
              : `${i18n("cmenu_addAuthorBlacklist")} '${authorBlacklistId}'`}
          </Menu.Item>
        )}
        {normalEnabled && titleBlacklistText && (
          <Menu.Item onClick={onTitleBlacklistClick}>
            {i18n("cmenu_addTitleBlacklist")}
          </Menu.Item>
        )}
        {normalEnabled && (authorBlacklistId || titleBlacklistText) && (
          <Menu.Divider />
        )}
        {selEnabled && (
          <Fragment>
            <Menu.Item
              onClick={(e) => onMenuSelect("copy", e)}
              rightSection={<span>Ctrl+C</span>}
            >
              {i18n("cmenu_copy")}
            </Menu.Item>
            <Menu.Item onClick={(e) => onMenuSelect("copyAnsi", e)}>
              {i18n("cmenu_copyAnsi")}
            </Menu.Item>
          </Fragment>
        )}
        {normalEnabled && (
          <Menu.Item
            onClick={(e) => onMenuSelect("paste", e)}
            rightSection={<span>Shift+Insert</span>}
          >
            {i18n("cmenu_paste")}
          </Menu.Item>
        )}
        {/* 快速搜尋：一層平鋪，每項自帶關鍵字（像 Chrome 原生的右鍵搜尋）。清單與
            適用條件（任意文字／純數字）由 index.jsx 現讀偏好算出，這裡只負責畫。 */}
        {quickSearchItems.map((item) => (
          <Menu.Item
            key={item.id}
            className="DropdownMenu__QuickSearch"
            onClick={(e) => onQuickSearchSelect(item, e)}
          >
            {quickSearchLabel(item)} '{quickSearchQuery}'
          </Menu.Item>
        ))}
        {urlEnabled && (
          <Fragment>
            <Menu.Item onClick={(e) => onMenuSelect("openUrlNewTab", e)}>
              {i18n("cmenu_openUrlNewTab")}
            </Menu.Item>
            <Menu.Item onClick={(e) => onMenuSelect("copyLinkUrl", e)}>
              {i18n("cmenu_copyLinkUrl")}
            </Menu.Item>
          </Fragment>
        )}
        <Menu.Divider />
        {normalEnabled && (
          <Fragment>
            <Menu.Item
              onClick={(e) => onMenuSelect("selectAll", e)}
              rightSection={<span>Ctrl+A</span>}
            >
              {i18n("cmenu_selectAll")}
            </Menu.Item>
            <Menu.Item
              onClick={(e) => onMenuSelect("mouseBrowsing", e)}
              leftSection={<span>{mouseBrowsingEnabled ? "✓" : ""}</span>}
            >
              {i18n("cmenu_mouseBrowsing")}
            </Menu.Item>
            {/* 複製本篇文章的 deep link（外部程式貼上後點開即跳回這篇）。只在
                文章畫面出現：要靠 Q 資訊框才問得出本篇的 AID。 */}
            {articleLinkEnabled && (
              <Menu.Item onClick={(e) => onMenuSelect("copyArticleLink", e)}>
                {i18n("cmenu_copyArticleLink")}
              </Menu.Item>
            )}
            <Menu.Item onClick={onInputHelperClick}>
              {i18n("cmenu_showInputHelper")}
            </Menu.Item>
            <Menu.Item onClick={onLiveArticleHelperClick}>
              {i18n("cmenu_showLiveArticleHelper")}
            </Menu.Item>
            <Menu.Divider />
          </Fragment>
        )}
        <Menu.Item onClick={onSettingsClick}>
          {i18n("cmenu_settings")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};

export default DropdownMenu;
