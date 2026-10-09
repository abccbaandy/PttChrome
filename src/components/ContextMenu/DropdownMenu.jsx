import { Menu } from "@mantine/core";
import { buildContextMenuEntries } from "./context_menu_entries";
import "./DropdownMenu.css";

// 複製類選項：標題一行，下面一行淡色預覽「按下去實際會複製什麼」（四個複製項的
// 名稱彼此太像，光看名稱分不出誰是誰）。預覽字串由 index.jsx 用
// context_menu_items.copyPreviews 算好傳進來 —— 與 handler 真正複製的是同一個函式。
//
// 標題**必須自成一個元素**：e2e（article_link_menu.offline.spec.js）是用
// getByText(label, { exact: true }) 抓項目，把預覽併進同一個文字節點會整組紅。
// 沒有預覽（例如長文還沒捲到「※ 文章網址」那行）就退回單行，不畫空的第二行。
const CopyItem = ({ label, preview, onClick }) => (
  <Menu.Item
    className={preview ? "DropdownMenu__WithPreview" : undefined}
    onClick={onClick}
  >
    <span>{label}</span>
    {preview && <span className="DropdownMenu__preview">{preview}</span>}
  </Menu.Item>
);

// 右鍵 context menu。改用 Mantine Menu（受控 opened，由 index.js 的 open 狀態驅動）：
// Menu.Target 是定位於游標 (pageX,pageY) 的零尺寸元素，floating-ui 自動處理超出邊界
// 翻轉（取代舊的手算 top()/left()）。快速搜尋是**一層**平鋪（不用 Menu.Sub），項目
// 由 index.jsx 依偏好＋選取內容算好後傳進來。手機改畫成 bottom sheet（ContextSheet.jsx），
// 兩邊吃同一份 context_menu_entries.js。
export const DropdownMenu = (props) => {
  const { open, onHide, pageX, pageY } = props;
  const entries = buildContextMenuEntries(props);
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
        {/* 項目清單與出現條件：context_menu_entries.js（手機 bottom sheet 共用）。 */}
        {entries.map((it) => {
          if (it.type === "divider") return <Menu.Divider key={it.key} />;
          if (it.copy)
            return (
              <CopyItem
                key={it.key}
                label={it.label}
                preview={it.preview}
                onClick={it.onClick}
              />
            );
          return (
            <Menu.Item
              key={it.key}
              className={it.className}
              disabled={it.disabled}
              onClick={it.onClick}
              rightSection={it.right ? <span>{it.right}</span> : undefined}
            >
              {it.label}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
};

export default DropdownMenu;
