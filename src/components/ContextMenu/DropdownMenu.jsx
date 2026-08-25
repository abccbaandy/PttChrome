import { Fragment } from "react";
import { Menu } from "@mantine/core";
import { i18n } from "../../js/i18n";
import { quickSearchLabel } from "../../js/quick_search";
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
// 由 index.jsx 依偏好＋選取內容算好後傳進來。
export const DropdownMenu = ({
  open,
  onHide,
  pageX,
  pageY,
  urlEnabled,
  normalEnabled,
  selEnabled,
  quickSearchItems = [],
  quickSearchQuery = "",
  authorBlacklistId,
  authorBlacklistExists,
  titleBlacklistText,
  articleLinkEnabled,
  imageUploadEnabled,
  inputHelperEnabled,
  liveArticleHelperEnabled,
  longPushEnabled,
  contextArticle,
  previews = {},
  onTitleBlacklistClick,
  onLongPushClick,
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
            <CopyItem
              label={i18n("cmenu_copyLinkUrl")}
              preview={previews.copyLinkUrl}
              onClick={(e) => onMenuSelect("copyLinkUrl", e)}
            />
          </Fragment>
        )}
        {/* 游標下的連結指向某一篇文章時多給兩個選項。獨立成一塊而不是掛進上面的
            urlEnabled：ptt.cc 文章網址走 urlEnabled、好讀模式的文章代碼連結走
            normalEnabled（它的 href 是佔位符，不算 URL），兩邊共用同一塊才不必寫兩份。 */}
        {contextArticle && (
          <Fragment>
            <CopyItem
              label={i18n("cmenu_copyArticleAid")}
              preview={previews.copyArticleAid}
              onClick={(e) => onMenuSelect("copyArticleAid", e)}
            />
            <CopyItem
              label={i18n("cmenu_copyArticleDeepLink")}
              preview={previews.copyArticleDeepLink}
              onClick={(e) => onMenuSelect("copyArticleDeepLink", e)}
            />
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
            {/* 複製本篇文章的 deep link（外部程式貼上後點開即跳回這篇）。只在
                文章畫面出現：要靠 Q 資訊框才問得出本篇的 AID。 */}
            {articleLinkEnabled && (
              <CopyItem
                label={i18n("cmenu_copyArticleLink")}
                preview={previews.copyArticleLink}
                onClick={(e) => onMenuSelect("copyArticleLink", e)}
              />
            )}
            {/* 長推文一鍵發送：打一大段話，自動依 PTT 單則上限分段依序推出。
                只在文章畫面出現（要按得到 X），總開關 enableLongPush 預設開。 */}
            {longPushEnabled && (
              <Menu.Item onClick={onLongPushClick}>
                {i18n("cmenu_longPush")}
              </Menu.Item>
            )}
            {/* 兩個小幫手是小眾功能，**預設不顯示**（enableInputHelper /
                enableLiveArticleHelper，設定→一般→右鍵選單），手法同下面的圖片上傳。 */}
            {inputHelperEnabled && (
              <Menu.Item onClick={onInputHelperClick}>
                {i18n("cmenu_showInputHelper")}
              </Menu.Item>
            )}
            {liveArticleHelperEnabled && (
              <Menu.Item onClick={onLiveArticleHelperClick}>
                {i18n("cmenu_showLiveArticleHelper")}
              </Menu.Item>
            )}
            {/* 圖片上傳（urusai）。拖放與 Ctrl+V 是主要入口，這兩項給「不方便
                拖曳」與「想插入之前傳過的圖」的情況；跟著總開關 enableImageUpload。 */}
            {imageUploadEnabled && (
              <Fragment>
                <Menu.Item onClick={(e) => onMenuSelect("uploadImage", e)}>
                  {i18n("cmenu_uploadImage")}
                </Menu.Item>
                <Menu.Item onClick={(e) => onMenuSelect("uploadHistory", e)}>
                  {i18n("cmenu_uploadHistory")}
                </Menu.Item>
              </Fragment>
            )}
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
