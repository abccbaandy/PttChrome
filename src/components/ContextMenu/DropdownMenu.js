import { Fragment } from "react";
import { Menu } from "@mantine/core";
import { i18n } from "../../js/i18n";
import "./DropdownMenu.css";

const normalizeSelectedText = (selectedText) => {
  if (selectedText.length > 15) {
    return `${selectedText.substr(0, 15)} …`;
  }
  return selectedText;
};

const QUICK_SEARCH = {
  providers: [
    {
      name: "goo.gl",
      url: "https://goo.gl/%s",
    },
  ],
};

// 右鍵 context menu。改用 Mantine Menu（受控 opened，由 index.js 的 open 狀態驅動）：
// Menu.Target 是定位於游標 (pageX,pageY) 的零尺寸元素，floating-ui 自動處理超出邊界
// 翻轉（取代舊的手算 top()/left()）。QuickSearch 子選單用 Menu.Sub。
export const DropdownMenu = ({
  open,
  onHide,
  pageX,
  pageY,
  urlEnabled,
  normalEnabled,
  selEnabled,
  mouseBrowsingEnabled,
  selectedText,
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
      width={220}
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
        {selEnabled && (
          <Menu.Item onClick={(e) => onMenuSelect("searchGoogle", e)}>
            {i18n("cmenu_searchGoogle")} '{normalizeSelectedText(selectedText)}'
          </Menu.Item>
        )}
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
        {selEnabled && (
          <Fragment>
            <Menu.Sub>
              <Menu.Sub.Target>
                <Menu.Sub.Item>{i18n("cmenu_quickSearch")}</Menu.Sub.Item>
              </Menu.Sub.Target>
              <Menu.Sub.Dropdown>
                {QUICK_SEARCH.providers.map((p) => (
                  <Menu.Item
                    key={p.url}
                    onClick={(e) => onQuickSearchSelect(p.url, e)}
                  >
                    {p.name}
                  </Menu.Item>
                ))}
              </Menu.Sub.Dropdown>
            </Menu.Sub>
            <Menu.Divider />
          </Fragment>
        )}
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
