import {
  Fragment,
  cloneElement,
  createContext,
  memo,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  Modal,
  Tabs,
  Button,
  Checkbox,
  TextInput,
  NumberInput,
  Select,
  Textarea,
  SegmentedControl,
  Switch,
  Title,
  Text,
  Anchor,
  ActionIcon,
  useMantineColorScheme,
} from "@mantine/core";
import { i18n } from "../../js/i18n";
import { GENERAL_GROUPS } from "../../js/pref_groups";
import {
  DEFAULT_PREFS,
  NATIVE_SAFE_MODE_KEYS,
  readValuesWithDefault,
  writeValues,
} from "../../js/pref_storage";
import { mergeEditedPrefs } from "../../js/pref_merge";
import * as prefSync from "../../js/pref_sync";
import {
  promptApiAvailability,
  ensurePromptApiModel,
  destroyPromptApi,
} from "../../js/prompt_api";
import { deepEqual } from "../../js/pref_sync_logic";
import {
  exportSavedArticles,
  importSavedArticles,
} from "../../js/saved_articles";
import { isSignInCancelled } from "../../js/google_sign_in";
import { ensureNotifyPermission } from "../../js/notification_gate";
import {
  buildExportPayload,
  parseImportPayload,
  mergeImportedPrefs,
  backupFileName,
} from "../../js/pref_backup";
import {
  buildHistoryExport,
  historyFileName,
  importHistory,
} from "../../js/history_backup";
import { isValidOtpSecret } from "../../js/totp";
import {
  normalizeAutoLoginValues,
  credentialToStore,
  localCredentialStatus,
} from "./pref_credential";
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_SSH_RELAY_HOST,
  downloadAsFile,
} from "../../js/util";
import { SSH_SELF_HOST_URL, sshSupported } from "../../js/transport";
import {
  credentialStoreAvailable,
  storeCredential as storeCredentialInManager,
} from "../../js/credential_store";
import { isAndroidApp, openAppSettings } from "../../js/android_bridge";
import { DEFAULT_IMGUR_PROXY_BASE } from "../../js/image_proxy";
import {
  BUILTIN_QUICK_SEARCH,
  MATCH_ANY,
  MATCH_DIGITS,
  makeQuickSearchId,
  pruneQuickSearchEntries,
  validateQuickSearchEntry,
} from "../../js/quick_search";
import {
  MOBILE_FONT_PX_MAX,
  MOBILE_FONT_PX_MIN,
  MOBILE_FONT_PX_STEP,
  normalizeMobileFontPx,
} from "../../js/mobile_layout";
import { PrefSearchBox } from "./PrefSearchBox";
import {
  prefItem,
  prefRequiresChain,
  prefRequiresOff,
  prefSectionRows,
  prefShown,
  PREF_SHOWN_IF,
  mobileTextKey,
} from "../../js/pref_search";
import { shortcutList, isMacPlatform } from "../../js/shortcut_list";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import "./PrefModal.css";

const MOBILE_FONT_PX_CHOICES = [];
for (
  let px = MOBILE_FONT_PX_MIN;
  px <= MOBILE_FONT_PX_MAX;
  px += MOBILE_FONT_PX_STEP
) {
  MOBILE_FONT_PX_CHOICES.push({ value: String(px), label: px + " px" });
}

// 設定搜尋跳轉後「哪一項正在閃」。
//
// **刻意用 module-level 的 external store，而不是 React Context**：Context 要在整棵
// 樹外面多包一層 Provider，而這個檔案的 JSX 有一千六百行 —— 多縮排兩格等於整份
// 重寫，一次小改動噴出兩千行 diff、blame 全毀。設定頁是單例對話框，單例 store
// 在語意上也對；useSyncExternalStore 是 React 官方的訂閱方式，concurrent 安全。
let flashKeyValue = null;
const flashListeners = new Set();
const subscribeFlash = (cb) => {
  flashListeners.add(cb);
  return () => flashListeners.delete(cb);
};
const getFlashKey = () => flashKeyValue;
const setFlashKey = (key) => {
  if (flashKeyValue === key) return;
  flashKeyValue = key;
  flashListeners.forEach((cb) => cb());
};
const useFlashKey = () => useSyncExternalStore(subscribeFlash, getFlashKey);

// 窄螢幕（手機直向）版型：全螢幕＋頂端橫向分頁（PrefModal.css `.PrefModal--narrow`）。
// 寬版的 160px 左欄在 ~400px 寬的手機上會把內容擠到只剩一半。看視窗寬而不是
// App 的 mobile 旗標：桌機把視窗拉窄同樣需要。
export const PREF_NARROW_QUERY = "(max-width: 640px)";
const subscribeNarrow = (cb) => {
  const mq = window.matchMedia(PREF_NARROW_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getNarrow = () => window.matchMedia(PREF_NARROW_QUERY).matches;
const useNarrow = () => useSyncExternalStore(subscribeNarrow, getNarrow);

// 設定分類（＝分頁）。寬版是左欄分頁；窄版（手機）先列分類清單（各附一行說明），
// 點進去才是該分類的設定，返回鍵／上方「‹」回清單（像 Android 系統設定）。
export const PREF_CATEGORIES = [
  { value: "general", labelKey: "options_general" },
  { value: "mouse", labelKey: "options_mouse" },
  { value: "connection", labelKey: "options_connection" },
  { value: "enhance", labelKey: "options_enhance" },
  { value: "quicksearch", labelKey: "options_quickSearch" },
  { value: "autologin", labelKey: "options_autoLoginTab" },
  { value: "ai", labelKey: "options_ai" },
  { value: "local", labelKey: "options_local" },
  { value: "backup", labelKey: "options_backup" },
  { value: "shortcuts", labelKey: "options_shortcuts" },
  { value: "about", labelKey: "options_about" },
].map((c) => ({ ...c, descKey: "optionsDesc_" + c.value }));

export const PREF_FLASH_CLASS = "PrefModal__Anchor--flash";
// 略長於 PrefModal.css 的 animation duration，讓動畫跑完才移除 class。
export const PREF_FLASH_MS = 1700;

// 產生「整列外框」的錨點 marker 與高亮 class。
//
// **錨點放 wrapperProps 而不是直接寫 data-\*\*：Mantine 的 rest props 落在
// <input> 本身（Checkbox.mjs 把 ...rest 給 input），而我們要捲到／高亮的是含
// label 與說明文字的整列，也就是 root wrapper。
//
// **高亮走 classNames={{root}} 而不是 wrapperProps.className**：wrapperProps 是
// 在 ...getStyles("root") **之後**展開的（Checkbox.mjs:91 vs 111），從那裡塞
// className 會把 mantine-Checkbox-root 整個換掉 ⇒ 版面爆掉。Styles API 的
// classNames 則是 concat，安全。
const anchorFor = (key, flashKey) => ({
  wrapperProps: { "data-pref-anchor": key },
  classNames: flashKey === key ? { root: PREF_FLASH_CLASS } : undefined,
});

// Checkbox adapter：保留 id={`pref-check-${name}`}（label[for=...] e2e marker，且
// 點 label 文字才能切換）、name（input[name=...] marker）、event.target.checked 契約。
const PrefCheckbox = memo(
  ({ name, checked, disabled, onChange, description, children }) => (
    <Checkbox
      id={`pref-check-${name}`}
      name={name}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      label={children}
      description={description}
      mb="xs"
      {...anchorFor(name, useFlashKey())}
    />
  ),
);

// 數字欄 adapter。onChange 傳穩定的 onNumberChange(name, value)，name 由這裡帶 ⇒
// 呼叫端不必寫 inline arrow（inline 每次都是新函式，memo 就失效）。
// 保留 name（input[name=...] e2e marker）與錨點。
const PrefNumber = memo(
  ({ name, value, onChange, label, description, min }) => (
    <NumberInput
      label={label}
      description={description}
      name={name}
      min={min}
      value={value}
      onChange={(val) => onChange(name, val)}
      mb="xs"
      {...anchorFor(name, useFlashKey())}
    />
  ),
);

// 下拉選單 adapter（同 PrefNumber：吃 name＋共用 onSelectStr／onSelectNum(name, value)）。
// options 是元件外的常數 [value, i18n key]，data 在這裡 useMemo 組 ⇒ props 穩定、memo 生效；
// 選項文字不走 i18n 的（手機字級「14 px」）改傳元件外的常數 data。
// 存成數字的設定（滑鼠中鍵／滾輪／返回）由呼叫端傳 String(value)＋onSelectNum。
// ariaLabel：掛在 input 上的 aria-label（e2e 靠它抓）。只有 legend 沒有 label 的那幾顆
// 只傳 ariaLabel 不傳 label。
const PrefSelect = memo(
  ({
    name,
    value,
    onChange,
    label,
    ariaLabel,
    description,
    disabled,
    options,
    data: fixedData,
    autoComplete,
  }) => {
    const data = useMemo(
      () =>
        fixedData || options.map(([v, k]) => ({ value: v, label: i18n(k) })),
      [options, fixedData],
    );
    return (
      <Select
        label={label}
        aria-label={ariaLabel}
        description={description}
        name={name}
        autoComplete={autoComplete}
        value={value}
        allowDeselect={false}
        disabled={disabled}
        onChange={(val) => onChange(name, val)}
        data={data}
        mb="xs"
        {...anchorFor(name, useFlashKey())}
      />
    );
  },
);

// 熱鍵欄 adapter：唯讀 TextInput，按下的鍵由 onKeyDown（穩定的 onHotkeyCapture）寫回。
const PrefHotkey = memo(
  ({ name, value, disabled, onKeyDown, label, placeholder }) => (
    <TextInput
      label={label}
      name={name}
      readOnly
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      mb="xs"
      {...anchorFor(name, useFlashKey())}
    />
  ),
);

// 文字欄 adapter：onChange 是穩定的 onTextInputChange（讀 event.target.name）。
// 憑證欄（自動登入帳密／2FA、上傳 token）多帶 type／autoComplete／maxLength／error／onBlur：
// 都是字串或穩定的 callback，memo 照樣擋得住。error 由呼叫端算好傳字串（或 null）。
// mt：原本間距在上方的那一欄（上傳 token）照舊放上方，不加 mb。
const PrefText = memo(
  ({
    name,
    value,
    disabled,
    onChange,
    onBlur,
    label,
    description,
    placeholder,
    type,
    autoComplete,
    maxLength,
    error,
    mt,
  }) => (
    <TextInput
      label={label}
      description={description}
      name={name}
      type={type}
      autoComplete={autoComplete}
      maxLength={maxLength}
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      error={error}
      onChange={onChange}
      onBlur={onBlur}
      mt={mt}
      mb={mt ? undefined : "xs"}
      {...anchorFor(name, useFlashKey())}
    />
  ),
);

// 多行清單（黑名單、追蹤名單）adapter。每打一個字整份 PrefModal 重畫，
// 其他三個 autosize Textarea 不必跟著量高度。
const PrefTextarea = memo(
  ({ name, value, disabled, onChange, label, placeholder, minRows }) => (
    <Textarea
      label={label}
      name={name}
      autosize
      minRows={minRows}
      disabled={disabled}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      mb="xs"
      {...anchorFor(name, useFlashKey())}
    />
  ),
);

// PrefSelect 的選項（[value, i18n key]）。放元件外 ⇒ 每次 render 同一個陣列，memo 才擋得住。
const TERM_SIZE_MODE_OPTIONS = [
  ["fixed-term-size", "options_fixedTermSize"],
  ["fixed-font-size", "options_fixedFontSize"],
];
const MOBILE_LAYOUT_OPTIONS = [
  ["auto", "options_mobileLayoutAuto"],
  ["on", "options_mobileLayoutOn"],
  ["off", "options_mobileLayoutOff"],
];
// 「外觀」分區由索引畫出時，各下拉選單的選項（PrefIndexRows 的 selectOptions）。
const APPEARANCE_SELECT_OPTIONS = {
  termSizeMode: TERM_SIZE_MODE_OPTIONS,
  mobileLayout: MOBILE_LAYOUT_OPTIONS,
};
const MOUSE_LIST_CLICK_START_OPTIONS = [
  ["push", "options_clickFromPush"],
  ["date", "options_clickFromDate"],
  ["author", "options_clickFromAuthor"],
  ["title", "options_clickFromTitle"],
];
const MOUSE_PUSH_CLICK_START_OPTIONS = [
  ["author", "options_clickFromPusher"],
  ["content", "options_clickFromContent"],
];
const MOUSE_PUSH_CLICK_END_OPTIONS = [
  ["content", "options_clickToContent"],
  ["date", "options_clickToDate"],
  ["time", "options_clickToTime"],
];
// 存成數字（index）的滑鼠設定：value 是 index 字串（PrefSelect＋onSelectNum 存回數字）。
const MOUSE_MIDDLE_CLICK_OPTIONS = [
  ["0", "options_none"],
  ["1", "options_doPaste"],
  ["2", "options_leftKey"],
];
const MOUSE_WHEEL_OPTIONS = [
  ["0", "options_none"],
  ["1", "options_pageUpDown"],
];
const MOUSE_BACK_NAV_OPTIONS = [
  ["0", "options_none"],
  ["1", "options_leftKey"],
];
// 「滑鼠」分頁由索引畫出時的下拉選項（架構 review A7 第二十步）。
const MOUSE_SELECT_OPTIONS = {
  mouseListClickStart: MOUSE_LIST_CLICK_START_OPTIONS,
  mousePushClickStart: MOUSE_PUSH_CLICK_START_OPTIONS,
  mousePushClickEnd: MOUSE_PUSH_CLICK_END_OPTIONS,
  mouseMiddleClick: MOUSE_MIDDLE_CLICK_OPTIONS,
  mouseWheel: MOUSE_WHEEL_OPTIONS,
  mouseBackNav: MOUSE_BACK_NAV_OPTIONS,
};
const CONNECTION_PROTOCOL_OPTIONS = [
  ["websocket", "options_protocolWebsocket"],
  ["ssh", "options_protocolSsh"],
];
const CONNECTION_ENCODING_OPTIONS = [
  ["big5", "options_encodingBig5"],
  ["utf8", "options_encodingUtf8"],
];
// 「連線」分頁由索引畫出的幾區：下拉選項與文字欄的 placeholder（留空時實際生效的預設值）。
const CONNECTION_SELECT_OPTIONS = {
  connectionEncoding: CONNECTION_ENCODING_OPTIONS,
  connectionProtocol: CONNECTION_PROTOCOL_OPTIONS,
};
// 位址欄的 placeholder 放**實際生效的預設位址**（不是說明文字）：欄位留空就是用它，
// 使用者把自訂位址刪光也回得到預設。說明文字是 description（索引的 tooltipKey）。
const CONNECTION_PLACEHOLDERS = {
  imgurProxyUrl: DEFAULT_IMGUR_PROXY_BASE,
  proxyUrl: DEFAULT_PROXY_HOST,
};
// 「自動登入」分區由索引畫出時的下拉選項（PrefIndexRows 的 selectOptions）。
const AUTO_LOGIN_SELECT_OPTIONS = {
  autoLoginDupConn: [
    ["N", "options_autoLoginDupConnNo"],
    ["Y", "options_autoLoginDupConnYes"],
  ],
};

// 設定項下方的灰字說明。跟 PrefCheckbox 一樣包 memo：設定頁每改一個值整份
// PrefModal 重畫，props 沒變的列直接跳過（改一格的重畫時間約減半，量測見
// docs/build-modernization.md「設定頁重畫」）。
const PrefHint = memo(({ textKey }) => {
  // 手機版面換手機用語（MOBILE_TEXT_KEYS 有對照的才換，P96）。
  const mk = useMobileKey();
  return (
    <Text size="xs" c="dimmed" mb="xs">
      {i18n(mk(textKey))}
    </Text>
  );
});

// 勾選列＝勾選框＋（有的話）灰字說明，標題與說明的文字鍵取自設定搜尋索引
// （pref_search.js#prefItem）⇒ 設定頁上的字與搜尋結果同一份來源。只給「標題＋說明」
// 剛好就是索引那兩個鍵的列用；帶額外內容（警告字、description、說明不同字）的照舊手寫。
// 不在索引裡就直接炸：那是寫錯 name，靜態守護 pref_search_index.test.js 也會先紅。
//
// 反灰也由這裡自己判斷，呼叫端只給 name＋values（架構 review A7 第九步）：
//   - 前置開關（索引的 requires，pref_search.js#prefRequiresChain）：鏈上任一格關掉就反灰；
//   - 安全模式要蓋掉的項目（pref_storage.js#NATIVE_SAFE_MODE_KEYS）：自己或前置鏈上有一格在名單裡
//     就反灰（上層被安全模式蓋掉，下層也沒作用）。
// 呼叫端的 disabled 只留索引表達不了的條件（AI 模型不能用之類）。名單或索引改一項，設定頁就跟著
// 反灰，不必回來改 JSX。安全模式的值走 context：切換時只有用到它的列重畫。
// memo 只比這一格與它前置鏈的值 ⇒ 改別格時這一列不重畫（tests/unit/pref_modal_rerender.test.jsx）。
const SAFE_MODE_KEYS = new Set(NATIVE_SAFE_MODE_KEYS);
const SafeModeContext = createContext(false);
// 手機版面（App.mobile，且設定頁裡「手機版面」還沒改成關）：desktopOnly 的格子不畫、
// 換成手機用語（pref_search.js#MOBILE_TEXT_KEYS，P96）。勾選列、分區 legend、索引列都從這裡讀。
const MobileUiContext = createContext(false);
const useMobileKey = () => {
  const mobileUi = useContext(MobileUiContext);
  return (key) => mobileTextKey(key, mobileUi);
};
// Modal 外面包一層 Provider（context 穿得過 portal）。寫成元件而不是在 JSX 裡多包一層，
// 是為了不讓整段設定頁多縮排一層。
const SafeModeModal = ({ safeMode, mobileUi, ...props }) => (
  <SafeModeContext.Provider value={safeMode}>
    <MobileUiContext.Provider value={mobileUi}>
      <Modal {...props} />
    </MobileUiContext.Provider>
  </SafeModeContext.Provider>
);
const samePrefCheckRow = (a, b) =>
  a.name === b.name &&
  a.disabled === b.disabled &&
  a.onChange === b.onChange &&
  a.values[a.name] === b.values[b.name] &&
  prefRequiresChain(a.name).every((k) => a.values[k] === b.values[k]);

const PrefCheckRow = memo(({ name, values, disabled, onChange }) => {
  const it = prefItem(name);
  if (!it) throw new Error(`PrefCheckRow: ${name} 不在設定搜尋索引裡`);
  const chain = prefRequiresChain(name);
  const safeMode =
    useContext(SafeModeContext) &&
    (SAFE_MODE_KEYS.has(name) || chain.some((k) => SAFE_MODE_KEYS.has(k)));
  const parentOff = chain.some((k) => !values[k]);
  const mk = useMobileKey();
  return (
    <>
      <PrefCheckbox
        name={name}
        checked={values[name]}
        disabled={safeMode || parentOff || disabled}
        onChange={onChange}
        description={
          it.hintInBox && it.tooltipKey ? i18n(mk(it.tooltipKey)) : undefined
        }
      >
        {i18n(mk(it.titleKey))}
      </PrefCheckbox>
      {it.tooltipKey && !it.hintInBox && (
        <PrefHint textKey={mk(it.tooltipKey)} />
      )}
    </>
  );
}, samePrefCheckRow);

// 分區 adapter：<fieldset> + <legend>，順帶掛上 section:<legendKey> 錨點。
// legendKey 同時是索引裡的 sectionKey（src/js/pref_search.js），靜態守護測試
// tests/unit/pref_search_index.test.js 直接掃這個 prop。
// 窄版（手機）點進某個分類後，上方返回列已經寫著分類名；第一個分區跟分類同名時
// （一般、增強功能、AI…）legend 再寫一次就重複了 ⇒ 只在窄版視覺隱藏（仍留給讀屏與錨點）。
const CATEGORY_LABEL_KEYS = new Set(PREF_CATEGORIES.map((c) => c.labelKey));

const PrefSection = ({ legendKey, children, ...rest }) => {
  const flashKey = useFlashKey();
  const narrow = useNarrow();
  const mobileUi = useContext(MobileUiContext);
  const key = `section:${legendKey}`;
  if (mobileUi) {
    const rows = prefSectionRows(legendKey);
    if (rows.length > 0 && rows.every((it) => it.desktopOnly)) return null;
  }
  return (
    <fieldset
      className={
        "PrefModal__Grid__Col--right__Fieldset" +
        (flashKey === key ? " " + PREF_FLASH_CLASS : "")
      }
      data-pref-anchor={key}
      {...rest}
    >
      <legend
        className={
          narrow && CATEGORY_LABEL_KEYS.has(legendKey)
            ? "PrefModal__legend--dup"
            : undefined
        }
      >
        {i18n(mobileTextKey(legendKey, mobileUi))}
      </legend>
      {children}
    </fieldset>
  );
};

// 快速搜尋自訂項目的一列（A7）。entry 是 values.quickSearchCustom 裡的那個物件：
// onQuickSearchCustomChange 只替換被改的那一列（其他列物件不變）⇒ memo 擋得住，
// 改一列只重畫那一列。onChange／onDelete 是 PrefModal 的穩定 callback（帶 id）。
const QUICK_SEARCH_MATCH_OPTIONS = [
  [MATCH_ANY, "options_quickSearchMatchAny"],
  [MATCH_DIGITS, "options_quickSearchMatchDigits"],
];
const QuickSearchCustomRow = memo(({ entry: c, onChange, onDelete }) => {
  const matchData = useMemo(
    () =>
      QUICK_SEARCH_MATCH_OPTIONS.map(([v, k]) => ({
        value: v,
        label: i18n(k),
      })),
    [],
  );
  // 整列空白＝剛按下「新增」還沒填，不要馬上噴紅字（關閉時會被
  // pruneQuickSearchEntries 丟掉）。
  const touched = !!(
    String(c.name || "").trim() || String(c.urlTemplate || "").trim()
  );
  const err = touched ? validateQuickSearchEntry(c) : null;
  return (
    <div className="PrefModal__QuickSearchRow">
      <Checkbox
        checked={c.enabled !== false}
        aria-label={i18n("options_quickSearchEnabled")}
        onChange={(e) => onChange(c.id, { enabled: !!e.target.checked })}
      />
      <TextInput
        label={i18n("options_quickSearchName")}
        value={c.name}
        error={err === "quicksearch_err_name" ? i18n(err) : null}
        onChange={(e) => onChange(c.id, { name: e.target.value })}
        className="PrefModal__QuickSearchRow__Name"
      />
      <TextInput
        label={i18n("options_quickSearchUrl")}
        value={c.urlTemplate}
        placeholder="https://example.com/search?q=%s"
        error={err === "quicksearch_err_url" ? i18n(err) : null}
        onChange={(e) => onChange(c.id, { urlTemplate: e.target.value })}
        className="PrefModal__QuickSearchRow__Url"
      />
      <Select
        label={i18n("options_quickSearchMatch")}
        value={c.match === MATCH_DIGITS ? MATCH_DIGITS : MATCH_ANY}
        allowDeselect={false}
        onChange={(val) => onChange(c.id, { match: val })}
        data={matchData}
        className="PrefModal__QuickSearchRow__Match"
      />
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label={i18n("options_quickSearchDelete")}
        onClick={() => onDelete(c.id)}
      >
        ✕
      </ActionIcon>
    </div>
  );
});

// 「一般」分區裡的段落小標（P94，段落定義在 js/pref_groups.js）。必須緊接在該段
// first 那一項前面（守護 tests/unit/pref_groups.test.jsx）。
const PrefGroupHeading = ({ id }) => {
  const g = GENERAL_GROUPS.find((x) => x.id === id);
  return (
    <h3 className="PrefModal__GroupTitle" data-pref-group={id}>
      {i18n(g.titleKey)}
    </h3>
  );
};

// 由索引畫出的分區（架構 review A7 第十三步）：照 pref_search.js 索引裡這個分區的順序，
// 依每項的 type 畫欄位，不再逐格手寫 JSX ⇒ 新增一格只要在索引放對位置。
//   - check  → PrefCheckRow（標題／說明／反灰都取自索引）；
//   - hotkey → PrefHotkey（說明當 placeholder，前置鏈關掉就反灰）；
//   - number → PrefNumber（說明當 description，下限取索引的 min）；
//   - text   → PrefText（說明當 description；placeholder 由呼叫端以 placeholders[key] 給，
//              放的是「留空時實際生效的預設值」；索引標 credential 的關掉自動填入）；
//   - select → PrefSelect（選項由呼叫端以 selectOptions[key] 給，[value, i18n key] 常數；說明當
//              description；標題跟分區 legend 同字時不另畫 label，只掛 aria-label；索引標
//              noAutofill 的關掉自動填入）；
//   - textarea → PrefTextarea（說明當 placeholder，最少列數取索引的 rows）；
//   - sub: true 的連續幾格包進同一個 .PrefModal__SubOptions（縮排子選項）；
//   - shownIf 條件不成立的整格不畫；條件表標 wrap 的，連續幾格包進一個 <div>（第十六步）；
//   - desktopOnly 的格子在手機版面（mobile）不畫，第一格的位置改畫一行說明（P100）；
//   - 段落第一項（pref_groups.js 的 first）前面畫小標；
//   - disabled：整區勾選列跟著反灰（AI 細部設定看總閘門＋機器能不能用，不是設定值能表達的）。
// 長得跟上面不一樣的格子（帶警告字、另有 onChange、值要轉換）與沒有 name 的可操作項（ui:…）
// 由呼叫端放進 custom（key → 那一格的 JSX），位置仍照索引。索引有、這裡畫不出的直接炸：
// 寫錯比靜默少一格好。
// 守護：tests/unit/pref_groups.test.jsx「由索引畫出」（畫面順序＝索引順序）。
const GROUP_ID_BY_FIRST = new Map(GENERAL_GROUPS.map((g) => [g.first, g.id]));

const PrefIndexRows = ({
  sectionKey,
  values,
  disabled,
  custom,
  selectOptions,
  placeholders,
  onCheckboxChange,
  onHotkeyCapture,
  onNumberChange,
  onTextInputChange,
  onSelectStr,
  onSelectNum,
}) => {
  // termSize.cols 這種點號鍵存在巢狀物件裡。
  const valueOf = (key) =>
    key.includes(".")
      ? key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), values)
      : values[key];
  const disabledOf = (it) =>
    it.requires ? prefRequiresOff(it.key, values) : undefined;
  const hideDesktopOnly = useContext(MobileUiContext);
  const mk = (key) => mobileTextKey(key, hideDesktopOnly);
  const field = (it) => {
    if (custom && Object.prototype.hasOwnProperty.call(custom, it.key))
      return custom[it.key];
    if (it.kind === "ui")
      throw new Error(`PrefIndexRows: ${it.key} 沒有 name，要放進 custom 手寫`);
    switch (it.type) {
      case "check":
        return (
          <PrefCheckRow
            name={it.key}
            values={values}
            disabled={disabled}
            onChange={onCheckboxChange}
          />
        );
      case "hotkey":
        return (
          <PrefHotkey
            name={it.key}
            value={values[it.key]}
            disabled={disabledOf(it)}
            onKeyDown={onHotkeyCapture}
            label={i18n(mk(it.titleKey))}
            placeholder={it.tooltipKey && i18n(mk(it.tooltipKey))}
          />
        );
      case "number":
        return (
          <PrefNumber
            name={it.key}
            value={valueOf(it.key)}
            onChange={onNumberChange}
            label={i18n(mk(it.titleKey))}
            description={it.tooltipKey && i18n(mk(it.tooltipKey))}
            min={it.min}
          />
        );
      case "text":
        return (
          <PrefText
            name={it.key}
            value={valueOf(it.key)}
            disabled={disabledOf(it)}
            onChange={onTextInputChange}
            label={i18n(mk(it.titleKey))}
            description={it.tooltipKey && i18n(mk(it.tooltipKey))}
            placeholder={placeholders && placeholders[it.key]}
            autoComplete={it.credential ? "off" : undefined}
          />
        );
      case "select": {
        if (!selectOptions || !selectOptions[it.key])
          throw new Error(`PrefIndexRows: ${it.key} 要在 selectOptions 給選項`);
        // 存成數字的設定（預設值是數字，例如滑鼠中鍵／滾輪／返回）：選項值是數字字串，
        // 選了經 onSelectNum 存回數字。
        const numeric = typeof DEFAULT_PREFS[it.key] === "number";
        if (numeric && !onSelectNum)
          throw new Error(
            `PrefIndexRows: ${it.key} 存成數字，要給 onSelectNum`,
          );
        return (
          <PrefSelect
            name={it.key}
            value={numeric ? String(valueOf(it.key)) : valueOf(it.key)}
            disabled={disabledOf(it)}
            onChange={numeric ? onSelectNum : onSelectStr}
            label={
              it.titleKey === it.sectionKey ? undefined : i18n(mk(it.titleKey))
            }
            ariaLabel={
              it.titleKey === it.sectionKey ? i18n(mk(it.titleKey)) : undefined
            }
            description={it.tooltipKey && i18n(mk(it.tooltipKey))}
            options={selectOptions[it.key]}
            autoComplete={it.noAutofill ? "off" : undefined}
          />
        );
      }
      case "textarea":
        return (
          <PrefTextarea
            name={it.key}
            value={valueOf(it.key)}
            disabled={disabledOf(it)}
            onChange={onTextInputChange}
            label={i18n(mk(it.titleKey))}
            placeholder={it.tooltipKey && i18n(mk(it.tooltipKey))}
            minRows={it.rows}
          />
        );
      default:
        throw new Error(
          `PrefIndexRows: ${it.key} 的 type ${it.type} 要放進 custom 手寫`,
        );
    }
  };
  const out = [];
  let subRun = null;
  let wrapRun = null; // { id, list }：shownIf 條件標 wrap 的連續幾格
  let desktopNoted = false;
  for (const it of prefSectionRows(sectionKey)) {
    if (hideDesktopOnly && it.desktopOnly) {
      // 手機版面不看的那幾格：帶 mobileNoteKey 的整組換成一行說明，指向手機自己的那一格；
      // 沒帶的（滑鼠滾輪那類手機根本沒有的操作）靜靜收起。
      if (!desktopNoted && it.mobileNoteKey) {
        desktopNoted = true;
        wrapRun = null;
        subRun = null;
        out.push(
          <PrefAnchor key={`desktopOnly:${it.key}`} anchorKey={it.key}>
            <PrefHint textKey={it.mobileNoteKey} />
          </PrefAnchor>,
        );
      }
      continue;
    }
    if (!prefShown(it.key, values)) continue;
    const cond = it.shownIf ? PREF_SHOWN_IF[it.shownIf] : null;
    let target = out;
    if (cond && cond.wrap) {
      if (!wrapRun || wrapRun.id !== it.shownIf) {
        wrapRun = { id: it.shownIf, list: [] };
        subRun = null;
        out.push(<div key={`shown:${it.key}`}>{wrapRun.list}</div>);
      }
      target = wrapRun.list;
    } else if (wrapRun) {
      wrapRun = null;
      subRun = null;
    }
    const group = GROUP_ID_BY_FIRST.get(it.key);
    if (group)
      target.push(<PrefGroupHeading key={`group:${group}`} id={group} />);
    const node = <Fragment key={it.key}>{field(it)}</Fragment>;
    if (it.sub && subRun) {
      subRun.push(node);
      continue;
    }
    if (it.sub) {
      subRun = [node];
      target.push(
        <div key={`sub:${it.key}`} className="PrefModal__SubOptions">
          {subRun}
        </div>,
      );
      continue;
    }
    subRun = null;
    target.push(node);
  }
  return out;
};

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 「一般」分區頂端的跳轉列（P94）：黏在捲動區上緣，點了捲到那一段，捲動時亮目前那段。
// scrollRef＝右欄捲動容器。其他分頁也共用這個容器，跳轉列不在畫面上（分頁被
// display:none）時 offsetParent 是 null，直接不算。
const PrefGroupNav = ({ scrollRef }) => {
  const [active, setActive] = useState(GENERAL_GROUPS[0].id);
  const barRef = useRef(null);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      const bar = barRef.current;
      if (!bar || !bar.offsetParent) return;
      // 小標的上緣過了「黏住的跳轉列底下」那條線，就算進到那一段。
      const line =
        box.getBoundingClientRect().top + bar.offsetHeight + GROUP_LINE_SLACK;
      let cur = GENERAL_GROUPS[0].id;
      for (const g of GENERAL_GROUPS) {
        const h = box.querySelector(`[data-pref-group="${g.id}"]`);
        if (h && h.getBoundingClientRect().top <= line) cur = g.id;
      }
      setActive(cur);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      box.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);
  // 跳轉列比畫面寬時（手機、英文介面）亮起的那顆可能在列外：橫向捲到看得到。
  // 只動跳轉列自己的 scrollLeft，不用 scrollIntoView（會連右欄一起上下捲）。
  useEffect(() => {
    const nav = barRef.current;
    const btn = nav && nav.querySelector(`[data-pref-group-jump="${active}"]`);
    if (!btn) return;
    const left = btn.offsetLeft;
    const right = left + btn.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = left;
    else if (right > nav.scrollLeft + nav.clientWidth)
      nav.scrollLeft = right - nav.clientWidth;
  }, [active]);
  const jump = (id) => {
    const box = scrollRef.current;
    const bar = barRef.current;
    const h = box && box.querySelector(`[data-pref-group="${id}"]`);
    if (!h || !bar) return;
    // 目標：小標停在黏住的跳轉列正下方（跳轉列黏住時上緣＝捲動區上緣）。
    const delta =
      h.getBoundingClientRect().top -
      (box.getBoundingClientRect().top + bar.offsetHeight + 4);
    box.scrollTo({
      top: box.scrollTop + delta,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    setActive(id);
  };
  return (
    <nav
      ref={barRef}
      className="PrefModal__GroupNav"
      aria-label={i18n("options_groupNav")}
    >
      {GENERAL_GROUPS.map((g) => (
        <button
          key={g.id}
          type="button"
          data-pref-group-jump={g.id}
          aria-current={active === g.id ? "true" : undefined}
          onClick={() => jump(g.id)}
        >
          {i18n(g.titleKey)}
        </button>
      ))}
    </nav>
  );
};
// 判定「進到這一段」時，跳轉列底下多算幾 px（小標本身的上邊距）。
const GROUP_LINE_SLACK = 8;

// 沒有 name 屬性、也不是分區的可操作項（主題切換、色票列、debug 開關）。
const PrefAnchor = ({ anchorKey, children, className, ...rest }) => {
  const flashKey = useFlashKey();
  return (
    <div
      data-pref-anchor={anchorKey}
      className={
        [className, flashKey === anchorKey ? PREF_FLASH_CLASS : null]
          .filter(Boolean)
          .join(" ") || undefined
      }
      {...rest}
    >
      {children}
    </div>
  );
};

// Offer the credentials to the password manager (browser's, or the Android
// APK's native one — see credential_store.js), with the 2FA secret packed into the password field.
//
// Deliberately does NOT strip anything from what gets written to localStorage:
// store() resolves before the user answers the browser's save prompt, so
// clearing the local copy here loses the password entirely when they press
// "Never". Wiping the plaintext is auto_login.js's job — it only happens once a
// later credentials.get() proves the store really has it.
const storeCredential = (values) => {
  const cred = credentialToStore(values, {
    supported: credentialStoreAvailable(),
  });
  if (!cred) return;
  // unsupported/blocked → the local copy above is the fallback
  storeCredentialInManager(cred).catch(() => {});
};

// Returns an array of children. The link elements are shared module-level
// instances, so the key is assigned here per position (not inside link()).
// 佔位符只收 \w：舊版 \S+ 會把「#a#（#b#」這種中文標點緊貼的兩個佔位符吃成一個。
export const fillPlaceholders = (message, replacements) =>
  message.split(/#(\w+)#/g).map((it, index) => {
    if (index % 2 === 1 && it in replacements) {
      return cloneElement(replacements[it], { key: index });
    } else {
      return it;
    }
  });

export const replaceI18n = (id, replacements) =>
  fillPlaceholders(i18n(id), replacements);

const link = (text, url) => (
  <Anchor href={url} target="_blank" rel="noreferrer">
    {text}
  </Anchor>
);

const changeNestedValue = (obj, key, newValue) => {
  let i = key.indexOf(".");
  if (i > 0) {
    let parentKey = key.substring(0, i);
    let subKey = key.substring(i + 1);
    return {
      ...obj,
      [parentKey]: changeNestedValue(obj[parentKey], subKey, newValue),
    };
  }
  return {
    ...obj,
    [key]: newValue,
  };
};

// The About tab's version blurb embeds clickable links; these never change, so
// build them once at module load (was recompose's static initial state).
// 血緣：iamchucky（Chrome extension 原版）→ robertabcd（網頁版，term.ptt.cc）
// → abccbaandy（本 fork，增強版）。
export const ABOUT_LINKS = {
  link_github_abccbaandy: link("abccbaandy", "https://github.com/abccbaandy"),
  link_this_PttChrome: link(
    "abccbaandy/PttChrome",
    "https://github.com/abccbaandy/PttChrome",
  ),
  link_this_site: link(
    "abccbaandy.github.io/PttChrome",
    "https://abccbaandy.github.io/PttChrome/",
  ),
  link_this_issues: link(
    "GitHub Issues",
    "https://github.com/abccbaandy/PttChrome/issues",
  ),
  link_term_ptt_cc: link("term.ptt.cc", "https://term.ptt.cc"),
  link_github_iamchucky: link("Chuck Yang", "https://github.com/iamchucky"),
  link_github_robertabcd: link("robertabcd", "https://github.com/robertabcd"),
  link_robertabcd_PttChrome: link(
    "robertabcd/PttChrome",
    "https://github.com/robertabcd/PttChrome",
  ),
  link_iamchucky_PttChrome: link(
    "iamchucky/PttChrome",
    "https://github.com/iamchucky/PttChrome",
  ),
  link_GPL20: link(
    "General Public License v2.0",
    "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
  ),
};

export const PrefModal = ({
  show,
  onSave,
  onReset,
  debugMode,
  onDebugModeChange,
  jumpTarget,
  registerBack,
  mobile,
}) => {
  const [navActiveKey, setNavActiveKey] = useState("general");
  const narrow = useNarrow();
  // 窄版：true＝分類清單，false＝某個分類的設定。每次打開都從清單開始。
  const [categoryList, setCategoryList] = useState(true);
  const rightColRef = useRef(null);
  const [values, setValues] = useState(readValuesWithDefault);
  // 手機版面：設定頁裡把「手機版面」改成關（還沒存檔）時，手機用語與收起的格子照電腦版畫回來
  //（P100 的說明指向的「手機字級」那時也不畫了）。
  const mobileUi = !!mobile && values.mobileLayout !== "off";
  const mk = (key) => mobileTextKey(key, mobileUi);
  // What localStorage held when the dialog opened. `values` follows the user's
  // typing, so only this can answer "is there still a plaintext copy here?".
  const [storedSnapshot, setStoredSnapshot] = useState(readValuesWithDefault);
  const [syncUser, setSyncUser] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | synced | error
  // 使用者（或企業政策）已封鎖本站通知：deep link 交接就只剩標題閃爍＋頁內橫幅，
  // 說清楚比讓那個勾勾看起來有效好。初值直接讀當下的權限，不必等使用者去點。
  const [notifyDenied, setNotifyDenied] = useState(
    () =>
      typeof Notification !== "undefined" &&
      Notification.permission === "denied",
  );
  // 裝置端 AI（Prompt API）可用性：unsupported | unavailable | downloadable |
  // downloading | available。掛載時查一次；**下載只由使用者的點擊觸發**
  // （Prompt API 的模型下載需要 user activation，且模型有數 GB）。
  const [aiState, setAiState] = useState(null);
  const [aiProgress, setAiProgress] = useState(null);
  // 設定備份分頁的最後一次結果訊息：null | "imported" | "badJson" | "badFormat"
  const [backupResult, setBackupResult] = useState(null);
  // 本機收藏匯出／匯入的最後一次結果（已組好的字串）；null＝還沒做過。
  const [savedBackupMsg, setSavedBackupMsg] = useState(null);
  const savedImportInputRef = useRef(null);
  // 閱讀紀錄（P98，js/history_backup.js）匯出／匯入的最後一次結果（已組好的字串）。
  const [historyBackupMsg, setHistoryBackupMsg] = useState(null);
  const historyImportInputRef = useRef(null);
  // 設定搜尋跳轉：pendingJump 是「要跳去哪」的指令，flashKey 是「現在哪一項在
  // 閃」。分成兩個 state 是因為跳轉要等一個 frame（見下面的 effect），而高亮的
  // 生命週期比跳轉長。
  const [pendingJump, setPendingJump] = useState(null);
  const flashKey = useFlashKey();
  const importInputRef = useRef(null);
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  const anchor = useCallback((key) => anchorFor(key, flashKey), [flashKey]);

  // 要排在指令面板跳轉的 effect 前面：打開＝回清單，有跳轉目標時再被它改成直接進分類。
  useEffect(() => {
    if (show) setCategoryList(true);
  }, [show]);

  const openCategory = useCallback((value) => {
    setNavActiveKey(value);
    setCategoryList(false);
    if (rightColRef.current) rightColRef.current.scrollTop = 0;
  }, []);

  // 窄版在分類裡：系統返回（history_back_guard → App.dismissTopSheet）＝回分類清單。
  const inCategory = !!(show && narrow && !categoryList);
  useEffect(() => {
    if (!inCategory || typeof registerBack !== "function") return undefined;
    return registerBack(() => setCategoryList(true));
  }, [inCategory, registerBack]);

  const onSearchJump = useCallback((hit) => {
    setNavActiveKey(hit.tab);
    setCategoryList(false);
    // n 遞增：連點同一筆結果也要重新觸發，所以物件 identity 必須改變。
    setPendingJump((p) => ({ key: hit.key, n: (p ? p.n : 0) + 1 }));
  }, []);
  // 指令面板挑了某個設定項（{ tab, key, n }）：開啟時直接跳過去，同設定搜尋。
  useEffect(() => {
    if (show && jumpTarget) onSearchJump(jumpTarget);
  }, [show, jumpTarget, onSearchJump]);

  // 切分頁 → 捲動 → 短暫高亮。
  //
  // **必須等一個 frame**，兩個各自獨立的理由：
  //  1) Mantine 的 Tabs.Panel 走 React 的 <Activity>（非作用分頁整塊
  //     display:none）⇒ 跟 setNavActiveKey 同一個 commit 裡 scrollIntoView 是
  //     no-op，量不到版面；
  //  2)「自動登入」分頁是條件渲染（navActiveKey === "autologin" && …），
  //     目標元素這一刻根本還不存在。
  useEffect(() => {
    if (!pendingJump) return;
    let timer = 0;
    const raf = requestAnimationFrame(() => {
      const node = document.querySelector(
        `[data-pref-anchor="${pendingJump.key}"]`,
      );
      if (node && node.scrollIntoView) {
        const reduce = prefersReducedMotion();
        node.scrollIntoView({
          block: "center",
          behavior: reduce ? "auto" : "smooth",
        });
      }
      setFlashKey(pendingJump.key);
      timer = window.setTimeout(() => setFlashKey(null), PREF_FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      setFlashKey(null);
    };
  }, [pendingJump]);

  // 設定頁關閉 → 下次打開是乾淨狀態（否則會看到上次那一項還在閃）。
  useEffect(() => {
    if (!show) {
      setPendingJump(null);
      setFlashKey(null);
    }
  }, [show]);

  useEffect(() => {
    let alive = true;
    promptApiAvailability().then((a) => alive && setAiState(a));
    return () => {
      alive = false;
    };
  }, []);

  const startAiDownload = useCallback(() => {
    setAiState("downloading");
    ensurePromptApiModel((loaded) =>
      setAiProgress(Math.round(loaded * 100)),
    ).then((a) => {
      setAiState(a);
      setAiProgress(null);
    });
  }, []);

  // AI 總開關：不能走通用的 onCheckboxChange——勾選要順帶帶著 user activation 觸發
  // 模型下載，取消勾選要把常駐的 session 釋放掉（模型佔記憶體）。
  const onAiMasterChange = useCallback(
    ({ target: { checked } }) => {
      setValues((v) => changeNestedValue(v, "enableAi", !!checked));
      if (!checked) {
        destroyPromptApi();
        return;
      }
      startAiDownload();
    },
    [startAiDownload],
  );

  const onCloseClick = useCallback(() => {
    // 只寫回在設定頁裡改過的格子（跟打開時的 storedSnapshot 比），其餘以儲存裡現在的值為準：
    // 開著的期間別的分頁、雲端同步、右鍵加黑名單寫進去的改動不可以被打開那一刻的表單蓋掉
    // （見 pref_merge.js）。
    const fresh = readValuesWithDefault();
    const next = mergeEditedPrefs(
      fresh,
      storedSnapshot,
      pruneQuickSearchEntries(normalizeAutoLoginValues(values)),
    );
    // Untouched form → nothing to persist or upload; uploading anyway
    // would bump updatedAt and ping every other device for nothing.
    if (!deepEqual(next, fresh)) {
      storeCredential(next);
      writeValues(next);
      prefSync.savePrefs(next);
    }
    // 兩個通知 pref 的預設值都是 true ⇒ 使用者不會去勾一個已經勾好的框 ⇒ 只靠
    // onHandoffNotifyChange 的話權限永遠停在 'default'，系統通知永遠不出現（要
    // 「關掉再打開」才問得到，等於隱藏操作）。所以每次關閉設定頁都再檢查一次。
    // 兩個開關共用同一個瀏覽器權限，任一為開就該有——水球那個從來不曾自己問過。
    //
    // 用 Esc 關閉不算 user activation（HTML 規範明文把 Esc 排除在外），那一次請求
    // 可能被瀏覽器忽略；可以接受——下次關閉設定頁還會再檢查。不接 onResult：
    // 對話框正要卸載，setNotifyDenied 已經沒有意義。
    ensureNotifyPermission(
      next.deepLinkHandoffNotify || next.enableNotifications,
    );
    onSave(next);
  }, [values, storedSnapshot, onSave]);

  const onResetClick = useCallback(() => {
    prefSync.savePrefs(DEFAULT_PREFS);
    onReset(writeValues({ ...DEFAULT_PREFS }));
  }, [onReset]);

  const onCheckboxChange = useCallback(({ target: { name, checked } }) => {
    setValues((v) => changeNestedValue(v, name, !!checked));
  }, []);

  // Deep link 交接通知：勾選的當下有 user activation（權限彈窗最穩的時機），所以
  // 這裡先問一次，不等到關閉設定頁。跟 onAiMasterChange 同一個理由不能走通用的
  // onCheckboxChange。
  //
  // 權限拿不到不算失敗：標題閃爍與頁內橫幅照常運作，只是少了「點通知切分頁」那條
  // 路，所以這裡只更新提示文字，不回頭把勾勾取消掉。
  const onHandoffNotifyChange = useCallback(({ target: { name, checked } }) => {
    setValues((v) => changeNestedValue(v, name, !!checked));
    ensureNotifyPermission(checked, (r) => setNotifyDenied(r === "denied"));
  }, []);

  const onTextInputChange = useCallback(({ target: { name, value } }) => {
    setValues((v) => changeNestedValue(v, name, value));
  }, []);

  // Mantine NumberInput/Select hand the value directly (not an event), so these
  // take (name, value) instead of reading e.target.
  const onNumberChange = useCallback((name, value) => {
    setValues((v) => changeNestedValue(v, name, parseInt(value, 10)));
  }, []);

  const onSelectNum = useCallback((name, value) => {
    setValues((v) => changeNestedValue(v, name, parseInt(value, 10)));
  }, []);

  const onSelectStr = useCallback((name, value) => {
    setValues((v) => changeNestedValue(v, name, value));
  }, []);

  // Pasted otpauth:// URIs become the bare Base32 secret as soon as the field
  // loses focus, so the user can see what was actually stored.
  const onOtpSecretBlur = useCallback(() => {
    setValues((v) => normalizeAutoLoginValues(v));
  }, []);

  // Drop the local plaintext copy. Only touches form state — the write happens
  // through the regular "persist on close" path, like every other field.
  const onClearLocalCredential = useCallback(() => {
    setValues((v) => ({
      ...v,
      autoLoginUser: "",
      autoLoginPassword: "",
      autoLoginOtpSecret: "",
    }));
  }, []);

  // Hotkey capture: record the pressed key (e.key) into the named pref.
  // Ignore bare modifier/Tab presses so the field can't be set to them.
  const onHotkeyCapture = useCallback((e) => {
    e.preventDefault();
    const key = e.key;
    const name = e.target.name;
    if (["Shift", "Control", "Alt", "Meta", "Tab"].indexOf(key) >= 0) {
      return;
    }
    setValues((v) => changeNestedValue(v, name, key));
  }, []);

  // 快速搜尋清單：一律**直接替換整個陣列**，不可走 changeNestedValue（它只認物件，
  // 遇到陣列會 spread 成普通物件把陣列毀掉）。DEFAULT_PREFS 裡的空陣列是 frozen，
  // 且 readValuesWithDefault 的淺層複製共用同一個 reference → 禁止 in-place 修改。
  const onQuickSearchBuiltinToggle = useCallback(
    ({ target: { name, checked } }) => {
      const id = name.replace(/^quickSearchBuiltin-/, "");
      setValues((v) => {
        const rest = (v.quickSearchDisabled || []).filter((x) => x !== id);
        return {
          ...v,
          quickSearchDisabled: checked ? rest : rest.concat(id),
        };
      });
    },
    [],
  );

  // 內建快速搜尋那幾列的標題（名稱＋灰字網址樣板）是 JSX：每次 render 新建就讓
  // PrefCheckbox 的 memo 失效 ⇒ 建一次就好（內容只跟語系有關，開著設定頁不會換語系）。
  const builtinQuickSearchLabels = useMemo(() => {
    const out = {};
    for (const b of BUILTIN_QUICK_SEARCH) {
      out[b.id] = (
        <>
          {i18n(b.nameKey)}
          <Text span size="xs" c="dimmed" ml="xs">
            {b.urlTemplate}
            {b.match === MATCH_DIGITS
              ? ` (${i18n("options_quickSearchMatchDigits")})`
              : ""}
          </Text>
        </>
      );
    }
    return out;
  }, []);

  const onQuickSearchCustomChange = useCallback((id, patch) => {
    setValues((v) => ({
      ...v,
      quickSearchCustom: (v.quickSearchCustom || []).map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    }));
  }, []);

  const onQuickSearchCustomDelete = useCallback((id) => {
    setValues((v) => ({
      ...v,
      quickSearchCustom: (v.quickSearchCustom || []).filter((c) => c.id !== id),
    }));
  }, []);

  const onQuickSearchCustomAdd = useCallback(() => {
    setValues((v) => ({
      ...v,
      quickSearchCustom: (v.quickSearchCustom || []).concat({
        id: makeQuickSearchId(),
        name: "",
        urlTemplate: "",
        match: MATCH_ANY,
        enabled: true,
      }),
    }));
  }, []);

  // Cloud values land in modal state only; the app applies them through the
  // regular onSave chain when the modal closes.
  const onSyncSignInClick = useCallback(() => {
    setSyncStatus("syncing");
    prefSync
      .signIn((merged) => setValues(merged))
      .then(() => setSyncStatus("synced"))
      .catch((e) => {
        // 使用者自己關掉登入視窗／選單：回到未登入，不顯示同步失敗。
        if (isSignInCancelled(e)) {
          setSyncStatus("idle");
          return;
        }
        console.warn("pref_sync: sign-in failed", e);
        setSyncStatus("error");
      });
  }, []);

  const onSyncSignOutClick = useCallback(() => {
    setSyncStatus("idle");
    prefSync.signOut().catch(() => {});
  }, []);

  // 匯出的是**當下表單值**（含還沒關閉存檔的修改），所以套用與 onCloseClick 同一組
  // 正規化。憑證的剝除由 buildExportPayload 負責（共用雲端同步的排除名單）。
  const onBackupExportClick = useCallback(() => {
    const next = pruneQuickSearchEntries(normalizeAutoLoginValues(values));
    downloadAsFile(
      backupFileName(),
      JSON.stringify(buildExportPayload(next), null, 2),
      "application/json",
    );
  }, [values]);

  // 本機收藏（P64，js/saved_articles.js）：整篇存在 IndexedDB，匯出檔就是那些紀錄原樣。
  const fillMsg = (key, vars) =>
    String(i18n(key) || "").replace(/\{(\w+)\}/g, (m, k) =>
      vars && vars[k] != null ? String(vars[k]) : m,
    );
  const onSavedExportClick = useCallback(async () => {
    const res = await exportSavedArticles(downloadAsFile);
    setSavedBackupMsg(
      res.count
        ? fillMsg("options_savedExported", res)
        : i18n("options_savedExportEmpty"),
    );
  }, []);
  // 閱讀紀錄：匯出＝這台的七種紀錄；匯入＝跟這台合併（不蓋掉），寫回 localStorage。
  // 各功能下次讀的時候就看得到（最近讀過／新推文標記每次比對原文、看板分頁每幀重讀、
  // 首頁回到主選單時重讀最近看板）。
  const onHistoryExportClick = useCallback(() => {
    const { payload, total } = buildHistoryExport();
    if (!total) {
      setHistoryBackupMsg(i18n("options_historyExportEmpty"));
      return;
    }
    downloadAsFile(
      historyFileName(),
      JSON.stringify(payload, null, 2),
      "application/json",
    );
    setHistoryBackupMsg(fillMsg("options_historyExported", { total }));
  }, []);
  const onHistoryImportFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let text = "";
    try {
      text = await file.text();
    } catch (err) {
      setHistoryBackupMsg(i18n("options_backupErrorBadJson"));
      return;
    }
    const res = importHistory(text);
    if (!res.ok) {
      setHistoryBackupMsg(
        i18n(
          res.reason === "badJson"
            ? "options_backupErrorBadJson"
            : "options_historyErrorBadFormat",
        ),
      );
      return;
    }
    setHistoryBackupMsg(
      [
        fillMsg("options_historyImported", res),
        res.failed ? fillMsg("options_historyImportFailed", res) : "",
      ]
        .filter(Boolean)
        .join(""),
    );
  }, []);
  const onSavedImportFile = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let text = "";
    try {
      text = await file.text();
    } catch (err) {
      setSavedBackupMsg(i18n("options_backupErrorBadJson"));
      return;
    }
    const res = await importSavedArticles(text);
    if (!res.ok) {
      setSavedBackupMsg(
        i18n(
          res.reason === "badJson"
            ? "options_backupErrorBadJson"
            : "options_savedErrorBadFormat",
        ),
      );
      return;
    }
    setSavedBackupMsg(
      [
        fillMsg("options_savedImported", res),
        res.skipped ? fillMsg("options_savedImportSkipped", res) : "",
        res.full ? fillMsg("options_savedImportFull", res) : "",
      ]
        .filter(Boolean)
        .join(""),
    );
  }, []);

  // 匯入＝立即寫入 + 立即套用（走既有的 reset 路徑，見 ContextMenu/index.jsx
  // #onPrefReset：redraw(true) + onPrefSaveImpl → onValuesPrefChange 全量重套）。
  // 設定對話框沒有「取消」，關閉即存檔，所以「先預覽再決定」並不成立。
  const onBackupImportFile = useCallback(
    async (e) => {
      const file = e.target.files && e.target.files[0];
      // 清空才能重複選同一個檔案（change 事件靠值有變化才觸發）。
      e.target.value = "";
      if (!file) return;
      let text;
      try {
        text = await file.text();
      } catch (err) {
        setBackupResult("badJson");
        return;
      }
      const parsed = parseImportPayload(text);
      if (!parsed.ok) {
        setBackupResult(parsed.reason);
        return;
      }
      // 備份檔沒提到的 key 回預設值，local-only（帳密／上班模式）保留本機現值。
      const merged = pruneQuickSearchEntries(
        mergeImportedPrefs(DEFAULT_PREFS, values, parsed.prefs),
      );
      writeValues(merged);
      prefSync.savePrefs(merged);
      setValues(merged);
      // storedSnapshot 是自動登入分頁憑證狀態的資料來源，不同步會顯示舊資訊。
      setStoredSnapshot(merged);
      // storeCredential 刻意不呼叫：匯入檔不含憑證，merged 的憑證欄位就是本機原值。
      onReset(merged);
      setBackupResult("imported");
    },
    [values, onReset],
  );

  useEffect(() => {
    const unsub = prefSync.onAuthState((user) => setSyncUser(user));
    return () => {
      if (unsub) unsub();
    };
  }, []);

  useEffect(() => {
    // The modal is mounted once at app startup and toggled via `show`, so the
    // form state captured back then goes stale: cloud snapshots and the
    // auto-login credential cleanup rewrite localStorage underneath it. Without
    // this re-read on open, closing the dialog would save (and upload) those
    // stale values — undoing the cleanup and overwriting newer cloud prefs from
    // another device.
    if (show) {
      const stored = readValuesWithDefault();
      setValues(stored);
      setStoredSnapshot(stored);
      setBackupResult(null);
    }
  }, [show]);

  // 這台機器根本用不了（沒 API／裝置不符）→ 連總開關都不給勾。null（還在探測）
  // 不算 unusable，避免開啟面板的瞬間閃一下反灰。
  const credentialApi = credentialStoreAvailable();
  // 狀態說明看的是「開啟設定頁當下 localStorage 有什麼」；清除鈕看的是目前表單
  // （按下去就該立刻反灰）。兩者刻意不同來源。
  const credentialStatus = localCredentialStatus(storedSnapshot, {
    supported: credentialApi,
  });
  const hasLocalCredential = !!(
    values.autoLoginUser ||
    values.autoLoginPassword ||
    values.autoLoginOtpSecret
  );

  const aiUnusable = aiState === "unsupported" || aiState === "unavailable";
  // 子選項＝總閘門關閉或機器用不了就反灰（值保留，重開即回復先前組合）。
  const aiSubDisabled = !values.enableAi || aiUnusable;
  // 網址類複核管的兩個增強功能「任一個開」才有事做：索引的 requires 是「全部都開」，
  // 表達不了「任一個」，所以在這裡算。
  const urlAiDisabled =
    aiSubDisabled || !(values.enableBareDomainLink || values.enableAutoFixUrl);

  return (
    <SafeModeModal
      safeMode={!!values.nativeSafeMode}
      mobileUi={mobileUi}
      opened={show}
      onClose={onCloseClick}
      // marker 放在 content（可見的對話框本體）而非 mantine-Modal-root（外層 0 尺寸
      // wrapper，Playwright 會判定 hidden）。
      classNames={{
        content: narrow
          ? "PrefModal PrefModal--narrow" +
            (categoryList ? " PrefModal--categoryList" : "")
          : "PrefModal",
      }}
      withCloseButton
      closeButtonProps={{ "aria-label": "Close" }}
      padding={0}
      // 用 Mantine 正規 size（--modal-size）給固定寬度：寬版（接近舊版），Mantine 會
      // 自動以視窗寬度為上限縮放（RWD），且固定寬度 → 切分頁不會忽寬忽窄。
      // 窄螢幕改全螢幕：標題移到 Modal header（與關閉鈕同一列），省下一列高度。
      size="900px"
      fullScreen={narrow}
      title={narrow ? i18n("menu_settings") : undefined}
      styles={{
        content: narrow ? undefined : { height: "90%" },
        body: { height: "100%" },
      }}
    >
      <Tabs
        value={navActiveKey}
        onChange={setNavActiveKey}
        orientation={narrow ? "horizontal" : "vertical"}
        className="PrefModal__Tabs"
      >
        <div className="PrefModal__Grid">
          <div className="PrefModal__Grid__Col--left">
            {!narrow && <Title order={3}>{i18n("menu_settings")}</Title>}
            <PrefSearchBox
              onJump={onSearchJump}
              resetToken={show}
              mobile={mobileUi}
            />
            {!narrow && (
              <Tabs.List>
                {PREF_CATEGORIES.map((c) => (
                  <Tabs.Tab key={c.value} value={c.value}>
                    {i18n(mk(c.labelKey))}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            )}
            {narrow && categoryList && (
              <nav
                className="PrefModal__Categories"
                aria-label={i18n("menu_settings")}
              >
                {PREF_CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className="PrefModal__Category"
                    data-pref-category={c.value}
                    onClick={() => openCategory(c.value)}
                  >
                    <span className="PrefModal__Category__Text">
                      <span className="PrefModal__Category__Title">
                        {i18n(mk(c.labelKey))}
                      </span>
                      <span className="PrefModal__Category__Desc">
                        {i18n(mk(c.descKey))}
                      </span>
                    </span>
                    <IconChevronRight
                      className="PrefModal__Category__Chevron"
                      size={18}
                      aria-hidden
                    />
                  </button>
                ))}
              </nav>
            )}
            {narrow && !categoryList && (
              <button
                type="button"
                className="PrefModal__CategoryBack"
                data-pref-category-back=""
                aria-label={i18n("options_categoryBack")}
                onClick={() => setCategoryList(true)}
              >
                <IconChevronLeft size={20} aria-hidden />
                <span>
                  {i18n(
                    mk(
                      (
                        PREF_CATEGORIES.find((c) => c.value === navActiveKey) ||
                        PREF_CATEGORIES[0]
                      ).labelKey,
                    ),
                  )}
                </span>
              </button>
            )}
            {!narrow && (
              <Button
                variant="default"
                className="PrefModal__Grid__Col--left__Reset"
                onClick={onResetClick}
              >
                {i18n("options_reset")}
              </Button>
            )}
          </div>
          <div className="PrefModal__Grid__Col--right" ref={rightColRef}>
            <Tabs.Panel value="general">
              <PrefSection legendKey="options_general">
                <PrefGroupNav scrollRef={rightColRef} />
                <PrefIndexRows
                  sectionKey="options_general"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                  custom={{
                    deepLinkHandoffNotify: (
                      <>
                        <PrefCheckbox
                          name="deepLinkHandoffNotify"
                          checked={values.deepLinkHandoffNotify}
                          onChange={onHandoffNotifyChange}
                        >
                          {i18n("options_deepLinkHandoffNotify")}
                        </PrefCheckbox>
                        {notifyDenied && (
                          <Text className="PrefModal__warning">
                            {i18n("options_deepLinkHandoffNotifyDenied")}
                          </Text>
                        )}
                      </>
                    ),
                  }}
                />
              </PrefSection>
              <PrefSection legendKey="options_contextMenu">
                <PrefIndexRows
                  sectionKey="options_contextMenu"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                />
              </PrefSection>
              <PrefSection legendKey="options_appearance">
                <PrefIndexRows
                  sectionKey="options_appearance"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                  onTextInputChange={onTextInputChange}
                  onSelectStr={onSelectStr}
                  selectOptions={APPEARANCE_SELECT_OPTIONS}
                  custom={{
                    "ui:theme": (
                      <PrefAnchor anchorKey="ui:theme">
                        <Text size="sm" fw={500} mb={4}>
                          {i18n("options_theme")}
                        </Text>
                        <SegmentedControl
                          value={colorScheme}
                          onChange={setColorScheme}
                          data={[
                            {
                              value: "light",
                              label: i18n("options_themeLight"),
                            },
                            { value: "dark", label: i18n("options_themeDark") },
                            { value: "auto", label: i18n("options_themeAuto") },
                          ]}
                          mb="xs"
                        />
                      </PrefAnchor>
                    ),
                    // 手機字級：下拉選單而非數字框（手機上不必叫鍵盤，值也只有偶數）。
                    mobileFontSize: (
                      <PrefSelect
                        label={i18n("options_mobileFontSize")}
                        description={i18n("tooltip_mobileFontSize")}
                        name="mobileFontSize"
                        value={String(
                          normalizeMobileFontPx(values.mobileFontSize),
                        )}
                        onChange={onSelectNum}
                        data={MOBILE_FONT_PX_CHOICES}
                      />
                    ),
                  }}
                />
              </PrefSection>
              {/* 游標所在列：滑鼠與鍵盤共用同一條渲染管線與同一組樣式，所以獨立成
                一區（原本整組塞在「滑鼠瀏覽」裡，鍵盤使用者根本找不到）。滑鼠那條
                來源開關已隨整組滑鼠設定搬到「滑鼠」分頁，樣式仍是兩者共用，留這裡。
                上兩個 checkbox ＝**樣式層**（畫什麼，可同時開），
                keyboardCursorHighlight ＝**來源層**（哪一列）。 */}
              <PrefSection legendKey="options_cursorHighlight">
                <PrefIndexRows
                  sectionKey="options_cursorHighlight"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                  custom={{
                    "ui:highlightColor": (
                      <PrefAnchor anchorKey="ui:highlightColor">
                        <Text
                          size="sm"
                          fw={500}
                          mb={4}
                          c={values.cursorRowBackground ? undefined : "dimmed"}
                        >
                          {i18n("options_highlightColor")}
                        </Text>
                        {/* 一排可點色塊（b1..b15 = color.css 的底色 class），選中者描邊。
                  比下拉好：直接顯示對應顏色，而非 index 數字。
                  顏色**只對「整列上底色」這個樣式有意義** ⇒ 底色關掉時整排變灰
                  且不接受點擊（aria-disabled 讓測試與輔助技術讀得到）。 */}
                        <div
                          className="PrefModal__HighlightColors"
                          aria-disabled={!values.cursorRowBackground}
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                            marginBottom: 12,
                            opacity: values.cursorRowBackground ? 1 : 0.4,
                            pointerEvents: values.cursorRowBackground
                              ? undefined
                              : "none",
                          }}
                        >
                          {Array.from({ length: 15 }, (_, i) => i + 1).map(
                            (i) => (
                              <div
                                key={i}
                                className={`b${i}`}
                                title={String(i)}
                                onClick={() =>
                                  setValues((v) =>
                                    changeNestedValue(
                                      v,
                                      "mouseBrowsingHighlightColor",
                                      i,
                                    ),
                                  )
                                }
                                style={{
                                  width: 22,
                                  height: 22,
                                  cursor: "pointer",
                                  boxSizing: "border-box",
                                  border:
                                    values.mouseBrowsingHighlightColor === i
                                      ? "2px solid var(--mantine-color-bright)"
                                      : "1px solid var(--mantine-color-default-border)",
                                }}
                              />
                            ),
                          )}
                        </div>
                        <Text size="xs" c="dimmed">
                          {i18n(mk("tooltip_highlightColorShared"))}
                        </Text>
                      </PrefAnchor>
                    ),
                  }}
                />
              </PrefSection>
            </Tabs.Panel>
            {/* 滑鼠：總開關 + 四個子功能。子項一律 disabled={!useMouseBrowsing}，
              因為總開關現在真的管得住全部（含中鍵與滾輪）——改版前那兩個根本
              不看它。決策層是 js/mouse_regions.js，合約見 docs/mouse.md。 */}
            {/* 滑鼠分頁整頁由索引畫出（架構 review A7 第二十步，L 同意統一說明畫法）：
              勾選列的說明一律畫在勾選框下面、下拉的說明一律當 description（標題下面）。 */}
            <Tabs.Panel value="mouse">
              <PrefSection legendKey="options_mouseBrowsing">
                <PrefIndexRows
                  sectionKey="options_mouseBrowsing"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              <PrefSection legendKey="options_mouseMove">
                <PrefIndexRows
                  sectionKey="options_mouseMove"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              <PrefSection legendKey="options_mouseLeftClick">
                <PrefIndexRows
                  sectionKey="options_mouseLeftClick"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              {/* 點擊範圍（取代舊的防誤觸開關，issue #56）：列表可點起始欄＝底色
                起始欄（js/mouse_regions.clickableColStart）、推文列可點區起訖
                （pusherClickRange）。總開關關掉時沒有東西要分區（resolveMouseGates.clickRange）。 */}
              <PrefSection legendKey="options_mouseClickRange">
                <PrefHint textKey="tooltip_mouseClickRange" />
                <PrefIndexRows
                  sectionKey="options_mouseClickRange"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              {/* 邊緣點擊翻頁（2026-09 從 term.ptt.cc 原版找回）：頂列 Home／底列
                End／右緣與文章上下半翻頁。送鍵走鍵盤那條分派鏈，所以兩種好讀
                模式自動是捲動語意。主功能表不適用（PTT 端語意相反）。 */}
              <PrefSection legendKey="options_mouseEdgePaging">
                <PrefIndexRows
                  sectionKey="options_mouseEdgePaging"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              {/* 功能鍵可點：解析在 js/footer_keys.js，只認單一按鍵的括號組。
                總開關關掉時 term_view 也一併 gate，一個節點都不產生。 */}
              <PrefSection legendKey="options_mouseFunctionKeys">
                <PrefIndexRows
                  sectionKey="options_mouseFunctionKeys"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              <PrefSection legendKey="options_mouseMiddleClick">
                <PrefIndexRows
                  sectionKey="options_mouseMiddleClick"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              {/* 平滑捲動只在文章列表好讀模式有作用，且是滾輪的子行為
                ⇒ 滾輪關掉時一併反灰（索引 requires，gating 同 resolveMouseGates）。 */}
              <PrefSection legendKey="options_mouseWheel">
                <PrefIndexRows
                  sectionKey="options_mouseWheel"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              {/* 瀏覽器的「返回」（觸控板左滑手勢／滑鼠側鍵／Alt+←／工具列）
                → 左方向鍵。**一個 pref、一條實作**（history sentinel），刻意不
                掛在滾輪底下 —— 見 mouse_regions.resolveMouseGates。 */}
              <PrefSection legendKey="options_mouseBackNav">
                <PrefIndexRows
                  sectionKey="options_mouseBackNav"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
              {/* 把滑鼠交給 PTT server（XTerm SGR 回報）。開啟後上面所有「我們自己
                的」滑鼠行為整組讓位 ⇒ 放在最後、獨立一個 fieldset。
                預設關的兩個理由見 pref_storage.js（PTT 的 UF_MOUSE 預設關，且
                pttbbs 目前沒有任何東西消費 KEY_MOUSE）。 */}
              <PrefSection legendKey="options_mouseServerReport">
                <PrefIndexRows
                  sectionKey="options_mouseServerReport"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onSelectStr={onSelectStr}
                  onSelectNum={onSelectNum}
                  selectOptions={MOUSE_SELECT_OPTIONS}
                />
              </PrefSection>
            </Tabs.Panel>
            <Tabs.Panel value="connection">
              {/* Android APK：連線固定走原生前景服務的本機 proxy（android_bridge.js），
                這組設定在 APK 裡不會生效，顯示出來只會誤導。 */}
              {isAndroidApp() ? (
                <PrefSection legendKey="options_connection_bbs">
                  <Text size="sm">{i18n("options_androidProxyNote")}</Text>
                  {/* APK 自己的設定（dev server 模式等）在原生頁面，不進網頁 prefs（不同步到桌機）。 */}
                  <Button
                    variant="default"
                    size="xs"
                    mt="xs"
                    onClick={openAppSettings}
                  >
                    {i18n("options_androidAppSettings")}
                  </Button>
                </PrefSection>
              ) : (
                <PrefSection legendKey="options_connection_bbs">
                  <PrefIndexRows
                    sectionKey="options_connection_bbs"
                    values={values}
                    onCheckboxChange={onCheckboxChange}
                    onTextInputChange={onTextInputChange}
                    placeholders={CONNECTION_PLACEHOLDERS}
                  />
                </PrefSection>
              )}
              {/* 連線協議（docs/ssh.md）。APK 的協議在原生 App 設定（上面的按鈕），不進網頁 prefs。
                WebCrypto 只在 secure context：從區網 http 開 dev 時整段不出現。
                兩個欄位都是本機專屬（LOCAL_ONLY_PREF_KEYS），不同步、不進備份。 */}
              {!isAndroidApp() && sshSupported() && (
                <PrefSection legendKey="options_connectionProtocol">
                  {/* 轉送位址只在選了 SSH 時有作用：反灰條件看的是下拉的值（不是勾選框），
                    索引的 requires 表達不了 ⇒ 這一格放 custom。 */}
                  <PrefIndexRows
                    sectionKey="options_connectionProtocol"
                    values={values}
                    onSelectStr={onSelectStr}
                    selectOptions={CONNECTION_SELECT_OPTIONS}
                    custom={{
                      sshRelayUrl: (
                        <PrefText
                          name="sshRelayUrl"
                          value={values.sshRelayUrl}
                          disabled={values.connectionProtocol !== "ssh"}
                          onChange={onTextInputChange}
                          label={i18n("options_sshRelayUrl")}
                          description={i18n("tooltip_sshRelayUrl")}
                          placeholder={DEFAULT_SSH_RELAY_HOST}
                        />
                      ),
                    }}
                  />
                  <Text size="xs" c="dimmed">
                    {i18n("tooltip_sshLocalOnly")}{" "}
                    <Anchor
                      href={SSH_SELF_HOST_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      size="xs"
                    >
                      {i18n("options_sshSelfHostHelp")}
                    </Anchor>
                  </Text>
                </PrefSection>
              )}
              {/* 線路編碼在 telnet 層轉（js/wire_charset.js、js/unicode_cells.js），APK 的 WebView 也走同一層，
                所以不放進上面的 isAndroidApp 分支。 */}
              <PrefSection legendKey="options_connectionEncoding">
                <PrefIndexRows
                  sectionKey="options_connectionEncoding"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                  onSelectStr={onSelectStr}
                  selectOptions={CONNECTION_SELECT_OPTIONS}
                />
              </PrefSection>
              <PrefSection legendKey="options_imgurProxy">
                {/* 隱私揭露：代理由專案方持有，會看到「哪個 IP 在看哪張圖」。
                  預設開啟，所以這段文字必須在使用者第一次翻到這裡就看得到。 */}
                <Text className="PrefModal__warning">
                  {i18n("tooltip_imgurProxy")}
                </Text>
                {/* 各站開關（清單＝image_proxy.js#IMAGE_PROXY_SITES，索引照它展開成縮排子選項）。
                  總開關關閉時反灰但值保留，重開即恢復原本的逐站選擇。
                  代理位址的 placeholder 放實際生效的預設位址（留空就是用它）。 */}
                <PrefIndexRows
                  sectionKey="options_imgurProxy"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                  onTextInputChange={onTextInputChange}
                  placeholders={CONNECTION_PLACEHOLDERS}
                />
              </PrefSection>
              <PrefSection legendKey="options_openCache">
                <PrefIndexRows
                  sectionKey="options_openCache"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                />
              </PrefSection>
            </Tabs.Panel>
            <Tabs.Panel value="enhance">
              <PrefSection legendKey="options_enhance">
                {/* 圖片上傳的總開關 enableImageUpload 在這裡；憑證（token）在「本機設定」
                  分頁 —— 它不上雲，與這個可同步的開關刻意分開放。 */}
                <PrefIndexRows
                  sectionKey="options_enhance"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onHotkeyCapture={onHotkeyCapture}
                  onNumberChange={onNumberChange}
                  onTextInputChange={onTextInputChange}
                />
              </PrefSection>
            </Tabs.Panel>
            {/* 快速搜尋分頁：右鍵選單（選取文字後）的搜尋項目清單。內建項目只能停用
              不能編輯／刪除——它們定義在 quick_search.js#BUILTIN_QUICK_SEARCH，
              pref 只存「被停用的 id」，所以日後新增內建項目舊使用者也拿得到。 */}
            <Tabs.Panel value="quicksearch">
              <PrefSection legendKey="options_quickSearchBuiltin">
                <PrefHint textKey="tooltip_quickSearch" />
                {BUILTIN_QUICK_SEARCH.map((b) => (
                  <PrefCheckbox
                    key={b.id}
                    name={`quickSearchBuiltin-${b.id}`}
                    checked={
                      (values.quickSearchDisabled || []).indexOf(b.id) < 0
                    }
                    onChange={onQuickSearchBuiltinToggle}
                  >
                    {builtinQuickSearchLabels[b.id]}
                  </PrefCheckbox>
                ))}
              </PrefSection>
              <PrefSection legendKey="options_quickSearchCustom">
                {(values.quickSearchCustom || []).map((c) => (
                  <QuickSearchCustomRow
                    key={c.id}
                    entry={c}
                    onChange={onQuickSearchCustomChange}
                    onDelete={onQuickSearchCustomDelete}
                  />
                ))}
                <Button variant="default" onClick={onQuickSearchCustomAdd}>
                  {i18n("options_quickSearchAdd")}
                </Button>
              </PrefSection>
            </Tabs.Panel>
            {/* 自動登入分頁：整條流程（開關＋憑證）集中在這裡，因為使用者要看懂
              「填什麼、存去哪、何時被清掉」得同時看到兩組。兩個 fieldset 刻意
              分開並各自標示同步性質：上面那組會雲端同步，下面的帳號／密碼／
              2FA 密鑰是 local-only（LOCAL_ONLY_PREF_KEYS in pref_sync_logic.js）。 */}
            {/* 只在真的切到這一頁時才渲染（其他分頁維持 Tabs 預設的 keepMounted）。
              這一頁是唯一「長得像登入表單」的內容，留在 DOM 只會讓瀏覽器的密碼
              管理員在使用者根本沒在看它的時候跑自動填入／存密碼提示。 */}
            <Tabs.Panel value="autologin">
              {navActiveKey === "autologin" && (
                <>
                  <PrefSection legendKey="options_autoLogin">
                    <PrefHint textKey="tooltip_autoLoginSynced" />
                    <PrefIndexRows
                      sectionKey="options_autoLogin"
                      values={values}
                      selectOptions={AUTO_LOGIN_SELECT_OPTIONS}
                      onCheckboxChange={onCheckboxChange}
                      onSelectStr={onSelectStr}
                    />
                  </PrefSection>
                  <PrefSection legendKey="options_autoLoginCredentials">
                    {/* 分區說明（索引的 tooltip_autoLogin）沒有密碼管理員時換成明文版。 */}
                    <Text className="PrefModal__warning">
                      {credentialApi
                        ? i18n("tooltip_autoLogin")
                        : i18n("tooltip_autoLoginPlaintext")}
                    </Text>
                    {credentialApi && (
                      <Text className="PrefModal__warning">
                        {i18n("tooltip_autoLoginLocalCopy")}
                      </Text>
                    )}
                    <PrefHint textKey="tooltip_autoLoginUpdate" />
                    {/* 帳號照索引畫；密碼（type=password、PTT 長度上限）與 2FA 密鑰（前面的
                      風險警告、格式錯誤提示、離開欄位時正規化）長得不一樣，放 custom。 */}
                    <PrefIndexRows
                      sectionKey="options_autoLoginCredentials"
                      values={values}
                      placeholders={
                        credentialApi
                          ? {
                              autoLoginUser: i18n("placeholder_autoLoginUser"),
                            }
                          : undefined
                      }
                      onTextInputChange={onTextInputChange}
                      custom={{
                        autoLoginPassword: (
                          <PrefText
                            label={i18n("options_autoLoginPassword")}
                            type="password"
                            name="autoLoginPassword"
                            autoComplete="new-password"
                            maxLength={72} /* PTT PW_PLAIN_LEN */
                            placeholder={
                              credentialApi
                                ? i18n("placeholder_autoLoginPassword")
                                : undefined
                            }
                            value={values.autoLoginPassword}
                            onChange={onTextInputChange}
                          />
                        ),
                        autoLoginOtpSecret: (
                          <>
                            {/* 2FA 密鑰是長期憑證，且與密碼存在同一個保險庫 → 風險必須寫在
                              欄位前面，並附上兩條降級做法（留空手動輸入／PTT 端改用僅新 IP
                              才驗證）。留空是刻意支援的用法，不是設定不完整。 */}
                            <Text className="PrefModal__warning">
                              {i18n("tooltip_autoLoginOtpSecretRisk")}
                            </Text>
                            {/* **不可改成 type="password"**：第二個密碼欄會讓 Chrome 把整頁判成
                              登入表單，抓最近的文字輸入當帳號、把密鑰當密碼跳出假的儲存提示，
                              並開始自動填入（那會讓「欄位空白＝已交給密碼管理員」的說明失真）。
                              密鑰本來就是 PTT 在終端機上以明文印出來給使用者抄的東西。 */}
                            <PrefText
                              label={i18n("options_autoLoginOtpSecret")}
                              name="autoLoginOtpSecret"
                              autoComplete="off"
                              description={i18n("tooltip_autoLoginOtpSecret")}
                              placeholder={
                                credentialApi
                                  ? i18n("placeholder_autoLoginOtpSecret")
                                  : undefined
                              }
                              error={
                                values.autoLoginOtpSecret &&
                                !isValidOtpSecret(values.autoLoginOtpSecret)
                                  ? i18n("tooltip_autoLoginOtpSecretInvalid")
                                  : null
                              }
                              value={values.autoLoginOtpSecret}
                              onChange={onTextInputChange}
                              onBlur={onOtpSecretBlur}
                            />
                          </>
                        ),
                      }}
                    />
                    <Text size="xs" c="dimmed" mb="xs">
                      {i18n("options_autoLoginLocalStatus_" + credentialStatus)}
                    </Text>
                    <Button
                      id="autoLoginClearLocalBtn"
                      variant="default"
                      size="xs"
                      disabled={!hasLocalCredential}
                      onClick={onClearLocalCredential}
                    >
                      {i18n("options_autoLoginClearLocal")}
                    </Button>
                    <Text size="xs" c="dimmed" mt={4}>
                      {i18n("tooltip_autoLoginClearLocal")}
                    </Text>
                  </PrefSection>
                </>
              )}
            </Tabs.Panel>
            {/* AI 分頁：所有裝置端 AI（Chrome Prompt API）設定收攏於此。
              enableAi 是**總閘門**——每個子功能的生效條件都是 `enableAi && <子
              pref>`（AND 在 term_view.js 匯總），總開關關掉時子選項只是反灰，
              值原樣保留。不支援的瀏覽器**分頁照常顯示**、全部反灰＋狀態說明，
              使用者才知道有這功能與為何不能用。
              顯示與否一律看 availability() 探測結果，勿用 typeof
              window.LanguageModel（Chromium 有 global 但沒模型，見
              docs/enhanced-addon.md 踩坑 A）。 */}
            <Tabs.Panel value="ai">
              <PrefSection legendKey="options_ai">
                <Text className="PrefModal__warning">{i18n("tooltip_ai")}</Text>
                {/* 總開關另有 onChange（勾選那一下要觸發模型下載）與反灰（機器用不了、
                  下載中），只換成索引取字；下面的狀態列與補救鈕都是手寫。 */}
                <PrefCheckRow
                  name="enableAi"
                  values={values}
                  disabled={aiUnusable || aiState === "downloading"}
                  onChange={onAiMasterChange}
                />
                {aiState && (
                  <Text size="xs" c="dimmed" mb="xs">
                    {i18n("options_aiStatus_" + aiState)}
                    {aiProgress !== null ? " " + aiProgress + "%" : ""}
                  </Text>
                )}
                {/* 補救鈕：prefs 會跨裝置同步，換一台機器時 enableAi 已是 true 但
                  模型還沒下載 → 勾選那次的 user activation 早就用掉了，沒有別的
                  入口可以觸發下載。只在這個狀態出現，available 後自動消失。 */}
                {values.enableAi && aiState === "downloadable" && (
                  <Button
                    id="aiDownloadBtn"
                    variant="default"
                    size="xs"
                    mb="xs"
                    onClick={startAiDownload}
                  >
                    {i18n("options_aiDownloadBtn")}
                  </Button>
                )}
              </PrefSection>
              <PrefSection legendKey="options_ai_features">
                {/* 子選項整區看總閘門（disabled）。網址類複核另外管兩個增強功能：裸網域
                  自動連結（AI 只能撤掉誤連）與自動修復斷掉的連結（AI 才能放行規則不敢認的
                  候選），兩者都關掉時它無事可做 ⇒ 「任一個開」索引的 requires 表達不了，
                  留 custom。 */}
                <PrefIndexRows
                  sectionKey="options_ai_features"
                  values={values}
                  disabled={aiSubDisabled}
                  onCheckboxChange={onCheckboxChange}
                  custom={{
                    enableUrlAi: (
                      <PrefCheckRow
                        name="enableUrlAi"
                        values={values}
                        disabled={urlAiDisabled}
                        onChange={onCheckboxChange}
                      />
                    ),
                  }}
                />
              </PrefSection>
            </Tabs.Panel>
            {/* local-only 分頁：這裡的設定僅存本機、絕不上雲（LOCAL_ONLY_PREF_KEYS
              in pref_sync_logic.js）。之後新增的 local-only 設定一律放這。
              例外：自動登入的帳號／密碼／2FA 密鑰同樣 local-only，但整條登入
              流程要一起看才讀得懂，故集中在「自動登入」分頁。 */}
            <Tabs.Panel value="local">
              <PrefSection legendKey="options_local">
                <Text className="PrefModal__warning">
                  {i18n("tooltip_local")}
                </Text>
                {/* 上班模式＋urusai 圖床的存取憑證（是憑證就不上雲，LOCAL_ONLY_PREF_KEYS，
                  所以放這個分頁；留空＝匿名上傳，功能照常）。
                  憑證欄**刻意不是 type=password**（同 autoLoginOtpSecret 的理由）：整頁
                  多一個密碼欄，Chrome 就會把設定頁判成登入表單 → 跳假的「儲存密碼」
                  提示並開始自動填入。守護在 pref_modal_autologin_tab.test.jsx。 */}
                <PrefIndexRows
                  sectionKey="options_local"
                  values={values}
                  onCheckboxChange={onCheckboxChange}
                  onTextInputChange={onTextInputChange}
                />
              </PrefSection>
            </Tabs.Panel>
            <Tabs.Panel value="backup">
              <PrefSection legendKey="options_backupExport">
                <Text className="PrefModal__warning">
                  {i18n("tooltip_backupExport")}
                </Text>
                <Button variant="default" onClick={onBackupExportClick}>
                  {i18n("options_backupExportBtn")}
                </Button>
              </PrefSection>
              <PrefSection legendKey="options_backupImport">
                <Text className="PrefModal__warning">
                  {i18n("tooltip_backupImport")}
                </Text>
                {/* 檔案選擇器藏起來、由按鈕轉發點擊：原生 input[type=file] 的外觀
                  無法跟 Mantine 的按鈕對齊。 */}
                <input
                  ref={importInputRef}
                  type="file"
                  name="backupImportFile"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={onBackupImportFile}
                />
                <Button
                  variant="default"
                  onClick={() =>
                    importInputRef.current && importInputRef.current.click()
                  }
                >
                  {i18n("options_backupImportBtn")}
                </Button>
                {backupResult && (
                  <Text>
                    {i18n(
                      backupResult === "imported"
                        ? "options_backupImported"
                        : backupResult === "badJson"
                          ? "options_backupErrorBadJson"
                          : "options_backupErrorBadFormat",
                    )}
                  </Text>
                )}
              </PrefSection>
              <PrefSection legendKey="options_savedBackup">
                <PrefHint textKey="tooltip_savedBackup" />
                <input
                  ref={savedImportInputRef}
                  type="file"
                  name="savedImportFile"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={onSavedImportFile}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button
                    variant="default"
                    data-saved-export
                    onClick={onSavedExportClick}
                  >
                    {i18n("options_savedExportBtn")}
                  </Button>
                  <Button
                    variant="default"
                    data-saved-import
                    onClick={() =>
                      savedImportInputRef.current &&
                      savedImportInputRef.current.click()
                    }
                  >
                    {i18n("options_savedImportBtn")}
                  </Button>
                </div>
                {savedBackupMsg && (
                  <Text size="sm" mt={6} data-saved-backup-result>
                    {savedBackupMsg}
                  </Text>
                )}
              </PrefSection>
              <PrefSection legendKey="options_historyBackup">
                <PrefHint textKey="tooltip_historyBackup" />
                <input
                  ref={historyImportInputRef}
                  type="file"
                  name="historyImportFile"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={onHistoryImportFile}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button
                    variant="default"
                    data-history-export
                    onClick={onHistoryExportClick}
                  >
                    {i18n("options_historyExportBtn")}
                  </Button>
                  <Button
                    variant="default"
                    data-history-import
                    onClick={() =>
                      historyImportInputRef.current &&
                      historyImportInputRef.current.click()
                    }
                  >
                    {i18n("options_historyImportBtn")}
                  </Button>
                </div>
                {historyBackupMsg && (
                  <Text size="sm" mt={6} data-history-backup-result>
                    {historyBackupMsg}
                  </Text>
                )}
              </PrefSection>
              <PrefSection legendKey="options_sync">
                <Text className="PrefModal__warning">
                  {i18n("tooltip_sync")}
                </Text>
                {syncUser ? (
                  <div>
                    <Text>
                      {i18n("options_syncSignedInAs")}
                      {syncUser.email}
                    </Text>
                    <Button variant="default" onClick={onSyncSignOutClick}>
                      {i18n("options_syncSignOut")}
                    </Button>
                    {/* 稍後閱讀同步：只在登入雲端同步時出現（沒登入同步就沒有東西可同步）。 */}
                    <PrefCheckbox
                      name="syncReadLater"
                      checked={values.syncReadLater}
                      disabled={!values.enableRecentArticles}
                      onChange={onCheckboxChange}
                    >
                      {i18n("options_syncReadLater")}
                    </PrefCheckbox>
                    <PrefHint textKey="tooltip_syncReadLater" />
                  </div>
                ) : (
                  <Button
                    variant="default"
                    onClick={onSyncSignInClick}
                    disabled={syncStatus === "syncing"}
                  >
                    {i18n("options_syncSignIn")}
                  </Button>
                )}
                {syncStatus !== "idle" && (
                  <Text>
                    {i18n(
                      {
                        syncing: "options_syncStatusSyncing",
                        synced: "options_syncStatusSynced",
                        error: "options_syncStatusError",
                      }[syncStatus],
                    )}
                  </Text>
                )}
              </PrefSection>
            </Tabs.Panel>
            {/* 快捷鍵一覽（js/shortcut_list.js）：只列本站自己加的鍵，跟著目前的設定值走。 */}
            <Tabs.Panel value="shortcuts">
              <PrefSection legendKey="options_shortcuts">
                <PrefHint textKey="tooltip_shortcuts" />
                <table className="PrefModal__shortcuts">
                  <tbody>
                    {shortcutList(values, isMacPlatform()).map((s) => (
                      <tr key={s.labelKey}>
                        <td>
                          {s.keys.map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </td>
                        <td>{i18n(s.labelKey)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </PrefSection>
            </Tabs.Panel>
            <Tabs.Panel value="about" className="PrefModal__about-selectable">
              <div>
                <Title order={4}>
                  PttChrome {i18n("about_appName_edition")}
                  <small> - {i18n("about_appName_subtitle")}</small>
                </Title>
                <Text>{replaceI18n("about_description", ABOUT_LINKS)}</Text>
              </div>
              {/* 「關於」頁沒有 fieldset（版面是 Title + 清單），所以分區錨點
                掛在 PrefAnchor 上而不是 PrefSection。 */}
              <PrefAnchor anchorKey="section:about_version_title">
                <Title order={5}>{i18n("about_version_title")}</Title>
                <ul>
                  <li>{replaceI18n("about_version_current", ABOUT_LINKS)}</li>
                  <li>{replaceI18n("about_version_upstream", ABOUT_LINKS)}</li>
                  <li>{replaceI18n("about_version_original", ABOUT_LINKS)}</li>
                  <li>
                    build: <code>{process.env.GIT_COMMIT}</code> (
                    {process.env.BUILD_TIME})
                  </li>
                </ul>
              </PrefAnchor>
              <PrefAnchor anchorKey="section:options_debugMode_title">
                <Title order={5}>{i18n("options_debugMode_title")}</Title>
                {/* runtime-only：不進 values / DEFAULT_PREFS / pref_storage /
                  pref_sync —— 不落地、不上雲，重新整理即重設為關閉。 */}
                <Switch
                  id="pref-debug-mode"
                  checked={!!debugMode}
                  onChange={(e) => onDebugModeChange(e.currentTarget.checked)}
                  label={i18n("options_debugMode")}
                  description={i18n("options_debugMode_desc")}
                  mb="xs"
                  {...anchor("ui:debugMode")}
                />
                <PrefCheckbox
                  name="bgDebugRecord"
                  checked={values.bgDebugRecord}
                  onChange={onCheckboxChange}
                  description={i18n("options_bgDebugRecord_desc")}
                >
                  {i18n("options_bgDebugRecord")}
                </PrefCheckbox>
              </PrefAnchor>
              <PrefAnchor anchorKey="section:about_new_title">
                <Title order={5}>{i18n("about_new_title")}</Title>
                <ul>
                  {i18n("about_new_content").map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </PrefAnchor>
            </Tabs.Panel>
            {/* 窄版沒有左欄的底部空間：重設放在內容最底。 */}
            {narrow && (
              <Button
                variant="default"
                className="PrefModal__Grid__Col--right__Reset"
                onClick={onResetClick}
              >
                {i18n("options_reset")}
              </Button>
            )}
          </div>
        </div>
      </Tabs>
    </SafeModeModal>
  );
};

export default PrefModal;
