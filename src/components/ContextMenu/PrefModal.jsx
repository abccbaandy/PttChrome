import { useState, useCallback, useEffect, useRef } from "react";
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
import {
  DEFAULT_PREFS,
  readValuesWithDefault,
  writeValues,
} from "../../js/pref_storage";
import * as prefSync from "../../js/pref_sync";
import {
  promptApiAvailability,
  ensurePromptApiModel,
  destroyPromptApi,
} from "../../js/prompt_api";
import { deepEqual } from "../../js/pref_sync_logic";
import { ensureNotifyPermission } from "../../js/notification_gate";
import {
  buildExportPayload,
  parseImportPayload,
  mergeImportedPrefs,
  backupFileName,
} from "../../js/pref_backup";
import { isValidOtpSecret } from "../../js/totp";
import {
  normalizeAutoLoginValues,
  credentialToStore,
  localCredentialStatus,
} from "./pref_credential";
import { DEFAULT_PROXY_HOST, downloadAsFile } from "../../js/util";
import { DEFAULT_IMGUR_PROXY_BASE } from "../../js/imgur_proxy";
import {
  BUILTIN_QUICK_SEARCH,
  MATCH_ANY,
  MATCH_DIGITS,
  makeQuickSearchId,
  pruneQuickSearchEntries,
  validateQuickSearchEntry,
} from "../../js/quick_search";
import "./PrefModal.css";

// Checkbox adapter：保留 id={`pref-check-${name}`}（label[for=...] e2e marker，且
// 點 label 文字才能切換）、name（input[name=...] marker）、event.target.checked 契約。
const PrefCheckbox = ({ name, checked, disabled, onChange, children }) => (
  <Checkbox
    id={`pref-check-${name}`}
    name={name}
    checked={checked}
    disabled={disabled}
    onChange={onChange}
    label={children}
    mb="xs"
  />
);

const credentialApiAvailable = () =>
  !!window.PasswordCredential &&
  !!(navigator.credentials && navigator.credentials.store);

// Offer the credentials to the browser's password manager (Google Password
// Manager etc.), with the 2FA secret packed into the password field.
//
// Deliberately does NOT strip anything from what gets written to localStorage:
// store() resolves before the user answers the browser's save prompt, so
// clearing the local copy here loses the password entirely when they press
// "Never". Wiping the plaintext is auto_login.js's job — it only happens once a
// later credentials.get() proves the store really has it.
const storeCredential = (values) => {
  const cred = credentialToStore(values, {
    supported: credentialApiAvailable(),
  });
  if (!cred) return;
  try {
    navigator.credentials
      .store(new PasswordCredential({ ...cred, name: "PTT" }))
      .catch(() => {});
  } catch (e) {
    // unsupported/blocked → the local copy above is the fallback
  }
};

const replaceI18n = (id, replacements) => {
  return i18n(id)
    .split(/#(\S+)#/gi)
    .map((it, index) => {
      if (index % 2 === 1 && it in replacements) {
        return replacements[it];
      } else {
        return it;
      }
    });
};

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

// Build Mantine Select data (index-as-value) from i18n keys.
const selectData = (keys) =>
  keys.map((key, index) => ({ value: String(index), label: i18n(key) }));

// The About tab's version blurb embeds clickable links; these never change, so
// build them once at module load (was recompose's static initial state).
const replacements = {
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
}) => {
  const [navActiveKey, setNavActiveKey] = useState("general");
  const [values, setValues] = useState(readValuesWithDefault);
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
  const importInputRef = useRef(null);
  const { colorScheme, setColorScheme } = useMantineColorScheme();

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
    const next = pruneQuickSearchEntries(normalizeAutoLoginValues(values));
    // Untouched form → nothing to persist or upload; uploading anyway
    // would bump updatedAt and ping every other device for nothing.
    if (!deepEqual(next, readValuesWithDefault())) {
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
  }, [values, onSave]);

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
      console.info("PrefModal: open → re-read prefs from storage");
      const stored = readValuesWithDefault();
      setValues(stored);
      setStoredSnapshot(stored);
      setBackupResult(null);
    }
  }, [show]);

  // 這台機器根本用不了（沒 API／裝置不符）→ 連總開關都不給勾。null（還在探測）
  // 不算 unusable，避免開啟面板的瞬間閃一下反灰。
  const credentialApi = credentialApiAvailable();
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

  return (
    <Modal
      opened={show}
      onClose={onCloseClick}
      // marker 放在 content（可見的對話框本體）而非 mantine-Modal-root（外層 0 尺寸
      // wrapper，Playwright 會判定 hidden）。
      classNames={{ content: "PrefModal" }}
      withCloseButton
      closeButtonProps={{ "aria-label": "Close" }}
      padding={0}
      // 用 Mantine 正規 size（--modal-size）給固定寬度：寬版（接近舊版），Mantine 會
      // 自動以視窗寬度為上限縮放（RWD），且固定寬度 → 切分頁不會忽寬忽窄。
      size="900px"
      styles={{
        content: { height: "90%" },
        body: { height: "100%" },
      }}
    >
      <Tabs
        value={navActiveKey}
        onChange={setNavActiveKey}
        orientation="vertical"
        className="PrefModal__Tabs"
      >
        <div className="PrefModal__Grid">
          <div className="PrefModal__Grid__Col--left">
            <Title order={3}>{i18n("menu_settings")}</Title>
            <Tabs.List>
              <Tabs.Tab value="general">{i18n("options_general")}</Tabs.Tab>
              <Tabs.Tab value="mouse">{i18n("options_mouse")}</Tabs.Tab>
              <Tabs.Tab value="connection">
                {i18n("options_connection")}
              </Tabs.Tab>
              <Tabs.Tab value="enhance">{i18n("options_enhance")}</Tabs.Tab>
              <Tabs.Tab value="quicksearch">
                {i18n("options_quickSearch")}
              </Tabs.Tab>
              <Tabs.Tab value="autologin">
                {i18n("options_autoLoginTab")}
              </Tabs.Tab>
              <Tabs.Tab value="ai">{i18n("options_ai")}</Tabs.Tab>
              <Tabs.Tab value="local">{i18n("options_local")}</Tabs.Tab>
              <Tabs.Tab value="backup">{i18n("options_backup")}</Tabs.Tab>
              <Tabs.Tab value="about">{i18n("options_about")}</Tabs.Tab>
            </Tabs.List>
            <Button
              variant="default"
              className="PrefModal__Grid__Col--left__Reset"
              onClick={onResetClick}
            >
              {i18n("options_reset")}
            </Button>
          </div>
          <div className="PrefModal__Grid__Col--right">
            <Tabs.Panel value="general">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_general")}</legend>
                <PrefCheckbox
                  name="enablePicPreview"
                  checked={values.enablePicPreview}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enablePicPreview")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableNotifications"
                  checked={values.enableNotifications}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableNotifications")}
                </PrefCheckbox>
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
                <PrefCheckbox
                  name="enableEasyReading"
                  checked={values.enableEasyReading}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableEasyReading")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableEasyReadingList"
                  checked={values.enableEasyReadingList}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableEasyReadingList")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="easyReadingEndSwitchNative"
                  checked={values.easyReadingEndSwitchNative}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_easyReadingEndSwitchNative")}
                </PrefCheckbox>
                <TextInput
                  label={i18n("options_easyReadingEndSwitchKey")}
                  name="easyReadingEndSwitchKey"
                  readOnly
                  disabled={!values.easyReadingEndSwitchNative}
                  value={values.easyReadingEndSwitchKey}
                  placeholder={i18n("tooltip_easyReadingEndSwitchKey")}
                  onKeyDown={onHotkeyCapture}
                  mb="xs"
                />
                <TextInput
                  label={i18n("options_aidNavBackKey")}
                  name="aidNavBackKey"
                  readOnly
                  value={values.aidNavBackKey}
                  placeholder={i18n("tooltip_aidNavBackKey")}
                  onKeyDown={onHotkeyCapture}
                  mb="xs"
                />
                <TextInput
                  label={i18n("options_deepLinkCopyKey")}
                  name="deepLinkCopyKey"
                  readOnly
                  value={values.deepLinkCopyKey}
                  placeholder={i18n("tooltip_deepLinkCopyKey")}
                  onKeyDown={onHotkeyCapture}
                  mb="xs"
                />
                <PrefCheckbox
                  name="endTurnsOnLiveUpdate"
                  checked={values.endTurnsOnLiveUpdate}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_endTurnsOnLiveUpdate")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="copyOnSelect"
                  checked={values.copyOnSelect}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_copyOnSelect")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableBell"
                  checked={values.enableBell}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableBell")}
                </PrefCheckbox>
                <NumberInput
                  label={i18n("options_antiIdleTime")}
                  description={i18n("tooltip_antiIdleTime")}
                  name="antiIdleTime"
                  value={values.antiIdleTime}
                  onChange={(val) => onNumberChange("antiIdleTime", val)}
                  mb="xs"
                />
                <NumberInput
                  label={i18n("options_lineWrap")}
                  name="lineWrap"
                  value={values.lineWrap}
                  onChange={(val) => onNumberChange("lineWrap", val)}
                  mb="xs"
                />
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_contextMenu")}</legend>
                <PrefCheckbox
                  name="enableInputHelper"
                  checked={values.enableInputHelper}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableInputHelper")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableLiveArticleHelper"
                  checked={values.enableLiveArticleHelper}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableLiveArticleHelper")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableLongPush"
                  checked={values.enableLongPush}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableLongPush")}
                </PrefCheckbox>
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_appearance")}</legend>
                <PrefCheckbox
                  name="autoHideBlinkCursor"
                  checked={values.autoHideBlinkCursor}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_autoHideBlinkCursor")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed" mb="xs">
                  {i18n("tooltip_autoHideBlinkCursor")}
                </Text>
                <Text size="sm" fw={500} mb={4}>
                  {i18n("options_theme")}
                </Text>
                <SegmentedControl
                  value={colorScheme}
                  onChange={setColorScheme}
                  data={[
                    { value: "light", label: i18n("options_themeLight") },
                    { value: "dark", label: i18n("options_themeDark") },
                    { value: "auto", label: i18n("options_themeAuto") },
                  ]}
                  mb="xs"
                />
                <TextInput
                  label={i18n("options_fontFace")}
                  description={i18n("tooltip_fontFace")}
                  name="fontFace"
                  value={values.fontFace}
                  onChange={onTextInputChange}
                  mb="xs"
                />
                <NumberInput
                  label={i18n("options_bbsMargin")}
                  name="bbsMargin"
                  value={values.bbsMargin}
                  onChange={(val) => onNumberChange("bbsMargin", val)}
                  mb="xs"
                />
                <Select
                  label={i18n("options_termSize")}
                  name="termSizeMode"
                  value={values.termSizeMode}
                  allowDeselect={false}
                  onChange={(val) => onSelectStr("termSizeMode", val)}
                  data={[
                    {
                      value: "fixed-term-size",
                      label: i18n("options_fixedTermSize"),
                    },
                    {
                      value: "fixed-font-size",
                      label: i18n("options_fixedFontSize"),
                    },
                  ]}
                  mb="xs"
                />
                {values.termSizeMode === "fixed-term-size" && (
                  <div>
                    <NumberInput
                      label={i18n("options_cols")}
                      name="termSize.cols"
                      value={values.termSize.cols}
                      onChange={(val) => onNumberChange("termSize.cols", val)}
                      mb="xs"
                    />
                    <NumberInput
                      label={i18n("options_rows")}
                      name="termSize.rows"
                      value={values.termSize.rows}
                      onChange={(val) => onNumberChange("termSize.rows", val)}
                      mb="xs"
                    />
                    <PrefCheckbox
                      name="fontFitWindowWidth"
                      checked={values.fontFitWindowWidth}
                      onChange={onCheckboxChange}
                    >
                      {i18n("options_fontFitWindowWidth")}
                    </PrefCheckbox>
                  </div>
                )}
                {values.termSizeMode === "fixed-font-size" && (
                  <NumberInput
                    label={i18n("options_fontSize")}
                    name="fontSize"
                    value={values.fontSize}
                    onChange={(val) => onNumberChange("fontSize", val)}
                    mb="xs"
                  />
                )}
              </fieldset>
              {/* 游標所在列：滑鼠與鍵盤共用同一條渲染管線與同一組樣式，所以獨立成
                  一區（原本整組塞在「滑鼠瀏覽」裡，鍵盤使用者根本找不到）。滑鼠那條
                  來源開關已隨整組滑鼠設定搬到「滑鼠」分頁，樣式仍是兩者共用，留這裡。
                  上兩個 checkbox ＝**樣式層**（畫什麼，可同時開），
                  keyboardCursorHighlight ＝**來源層**（哪一列）。 */}
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_cursorHighlight")}</legend>
                <PrefCheckbox
                  name="cursorRowBrighten"
                  checked={values.cursorRowBrighten}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_cursorRowBrighten")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed" mb="xs">
                  {i18n("tooltip_cursorRowBrighten")}
                </Text>
                <PrefCheckbox
                  name="cursorRowBackground"
                  checked={values.cursorRowBackground}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_cursorRowBackground")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="keyboardCursorHighlight"
                  checked={values.keyboardCursorHighlight}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_keyboardCursorHighlight")}
                </PrefCheckbox>
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
                  {Array.from({ length: 15 }, (_, i) => i + 1).map((i) => (
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
                  ))}
                </div>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_highlightColorShared")}
                </Text>
              </fieldset>
            </Tabs.Panel>
            {/* 滑鼠：總開關 + 四個子功能。子項一律 disabled={!useMouseBrowsing}，
                因為總開關現在真的管得住全部（含中鍵與滾輪）——改版前那兩個根本
                不看它。決策層是 js/mouse_regions.js，合約見 docs/mouse.md。 */}
            <Tabs.Panel value="mouse">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseBrowsing")}</legend>
                <PrefCheckbox
                  name="useMouseBrowsing"
                  checked={values.useMouseBrowsing}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_useMouseBrowsing")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_useMouseBrowsing")}
                </Text>
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseMove")}</legend>
                <PrefCheckbox
                  name="mouseBrowsingHighlight"
                  checked={values.mouseBrowsingHighlight}
                  disabled={!values.useMouseBrowsing}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_mouseBrowsingHighlight")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_mouseBrowsingHighlight")}
                </Text>
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseLeftClick")}</legend>
                <PrefCheckbox
                  name="mouseLeftClick"
                  checked={values.mouseLeftClick}
                  disabled={!values.useMouseBrowsing}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableMouseLeftClick")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_mouseLeftClick")}
                </Text>
              </fieldset>
              {/* 防誤觸：可點區＝底色區的起始欄（js/mouse_regions.clickableColStart）。
                  與其他子項一樣 disabled={!useMouseBrowsing} —— 總開關關掉時左鍵、
                  指標、提示帶全滅，沒有誤觸要防（resolveMouseGates 同步 gate 掉）。 */}
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseMisclickGuard")}</legend>
                <PrefCheckbox
                  name="mouseMisclickGuard"
                  checked={values.mouseMisclickGuard}
                  disabled={!values.useMouseBrowsing}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableMouseMisclickGuard")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_mouseMisclickGuard")}
                </Text>
              </fieldset>
              {/* 功能鍵可點：解析在 js/footer_keys.js，只認單一按鍵的括號組。
                  一樣 disabled={!useMouseBrowsing}（term_view 也一併 gate，
                  總開關關掉時一個節點都不產生）。 */}
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseFunctionKeys")}</legend>
                <PrefCheckbox
                  name="mouseFunctionKeys"
                  checked={values.mouseFunctionKeys}
                  disabled={!values.useMouseBrowsing}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableMouseFunctionKeys")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_mouseFunctionKeys")}
                </Text>
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseMiddleClick")}</legend>
                <Select
                  aria-label={i18n("options_mouseMiddleClick")}
                  name="mouseMiddleClick"
                  value={String(values.mouseMiddleClick)}
                  allowDeselect={false}
                  disabled={!values.useMouseBrowsing}
                  onChange={(val) => onSelectNum("mouseMiddleClick", val)}
                  data={selectData([
                    "options_none",
                    "options_doPaste",
                    "options_leftKey",
                  ])}
                  mb="xs"
                />
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseWheel")}</legend>
                <Select
                  aria-label={i18n("options_mouseWheel")}
                  name="mouseWheel"
                  value={String(values.mouseWheel)}
                  allowDeselect={false}
                  disabled={!values.useMouseBrowsing}
                  onChange={(val) => onSelectNum("mouseWheel", val)}
                  data={selectData(["options_none", "options_pageUpDown"])}
                  mb="xs"
                />
                <Text size="xs" c="dimmed" mb="xs">
                  {i18n("tooltip_mouseWheel")}
                </Text>
                {/* 平滑捲動只在文章列表好讀模式有作用，且是滾輪的子行為
                    ⇒ 滾輪關掉時一併 disabled（gating 同 resolveMouseGates）。 */}
                <PrefCheckbox
                  name="mouseWheelSmoothScroll"
                  checked={values.mouseWheelSmoothScroll}
                  disabled={!values.useMouseBrowsing || !values.mouseWheel}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_mouseWheelSmoothScroll")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_mouseWheelSmoothScroll")}
                </Text>
              </fieldset>
            </Tabs.Panel>
            <Tabs.Panel value="connection">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_connection_bbs")}</legend>
                <PrefCheckbox
                  name="useProxy"
                  checked={values.useProxy}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_useProxy")}
                </PrefCheckbox>
                {/* placeholder 放的是**實際生效的預設位址**（不是說明文字）：欄位
                    留空就是用它，使用者把自訂位址刪光也回得到預設。說明文字改掛
                    description。imgur 那組同理。 */}
                <TextInput
                  label={i18n("options_proxyUrl")}
                  description={i18n("tooltip_proxyUrl")}
                  name="proxyUrl"
                  disabled={!values.useProxy}
                  value={values.proxyUrl}
                  placeholder={DEFAULT_PROXY_HOST}
                  onChange={onTextInputChange}
                  mb="xs"
                />
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_imgurProxy")}</legend>
                {/* 隱私揭露：代理由專案方持有，會看到「哪個 IP 在看哪張圖」。
                    預設開啟，所以這段文字必須在使用者第一次翻到這裡就看得到。 */}
                <Text className="PrefModal__warning">
                  {i18n("tooltip_imgurProxy")}
                </Text>
                <PrefCheckbox
                  name="useImgurProxy"
                  checked={values.useImgurProxy}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_useImgurProxy")}
                </PrefCheckbox>
                <TextInput
                  label={i18n("options_imgurProxyUrl")}
                  description={i18n("tooltip_imgurProxyUrl")}
                  name="imgurProxyUrl"
                  disabled={!values.useImgurProxy}
                  value={values.imgurProxyUrl}
                  placeholder={DEFAULT_IMGUR_PROXY_BASE}
                  onChange={onTextInputChange}
                  mb="xs"
                />
              </fieldset>
            </Tabs.Panel>
            <Tabs.Panel value="enhance">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_enhance")}</legend>
                <PrefCheckbox
                  name="showFloorNumbers"
                  checked={values.showFloorNumbers}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_showFloorNumbers")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="mergeSameAuthorComments"
                  checked={values.mergeSameAuthorComments}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_mergeSameAuthorComments")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="highlightAuthorComments"
                  checked={values.highlightAuthorComments}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_highlightAuthorComments")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableAutoFixUrl"
                  checked={values.enableAutoFixUrl}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableAutoFixUrl")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableXMentionLink"
                  checked={values.enableXMentionLink}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableXMentionLink")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="enableBareDomainLink"
                  checked={values.enableBareDomainLink}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableBareDomainLink")}
                </PrefCheckbox>
                {/* 圖片上傳的總開關。憑證（token）在「本機設定」分頁 —— 它不上雲，
                    與這個可同步的開關刻意分開放。 */}
                <PrefCheckbox
                  name="enableImageUpload"
                  checked={values.enableImageUpload}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableImageUpload")}
                </PrefCheckbox>
                <Textarea
                  label={i18n("options_blacklist")}
                  name="blacklist"
                  autosize
                  minRows={6}
                  value={values.blacklist}
                  placeholder={i18n("tooltip_blacklist")}
                  onChange={onTextInputChange}
                  mb="xs"
                />
                <Textarea
                  label={i18n("options_title_blacklist")}
                  name="titleBlacklist"
                  autosize
                  minRows={6}
                  value={values.titleBlacklist}
                  placeholder={i18n("tooltip_title_blacklist")}
                  onChange={onTextInputChange}
                  mb="xs"
                />
              </fieldset>
            </Tabs.Panel>
            {/* 快速搜尋分頁：右鍵選單（選取文字後）的搜尋項目清單。內建項目只能停用
                不能編輯／刪除——它們定義在 quick_search.js#BUILTIN_QUICK_SEARCH，
                pref 只存「被停用的 id」，所以日後新增內建項目舊使用者也拿得到。 */}
            <Tabs.Panel value="quicksearch">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_quickSearchBuiltin")}</legend>
                <Text size="xs" c="dimmed" mb="xs">
                  {i18n("tooltip_quickSearch")}
                </Text>
                {BUILTIN_QUICK_SEARCH.map((b) => (
                  <PrefCheckbox
                    key={b.id}
                    name={`quickSearchBuiltin-${b.id}`}
                    checked={
                      (values.quickSearchDisabled || []).indexOf(b.id) < 0
                    }
                    onChange={onQuickSearchBuiltinToggle}
                  >
                    {i18n(b.nameKey)}
                    <Text span size="xs" c="dimmed" ml="xs">
                      {b.urlTemplate}
                      {b.match === MATCH_DIGITS
                        ? ` (${i18n("options_quickSearchMatchDigits")})`
                        : ""}
                    </Text>
                  </PrefCheckbox>
                ))}
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_quickSearchCustom")}</legend>
                {(values.quickSearchCustom || []).map((c) => {
                  // 整列空白＝剛按下「新增」還沒填，不要馬上噴紅字（關閉時會被
                  // pruneQuickSearchEntries 丟掉）。
                  const touched = !!(
                    String(c.name || "").trim() ||
                    String(c.urlTemplate || "").trim()
                  );
                  const err = touched ? validateQuickSearchEntry(c) : null;
                  return (
                    <div className="PrefModal__QuickSearchRow" key={c.id}>
                      <Checkbox
                        checked={c.enabled !== false}
                        aria-label={i18n("options_quickSearchEnabled")}
                        onChange={(e) =>
                          onQuickSearchCustomChange(c.id, {
                            enabled: !!e.target.checked,
                          })
                        }
                      />
                      <TextInput
                        label={i18n("options_quickSearchName")}
                        value={c.name}
                        error={
                          err === "quicksearch_err_name" ? i18n(err) : null
                        }
                        onChange={(e) =>
                          onQuickSearchCustomChange(c.id, {
                            name: e.target.value,
                          })
                        }
                        className="PrefModal__QuickSearchRow__Name"
                      />
                      <TextInput
                        label={i18n("options_quickSearchUrl")}
                        value={c.urlTemplate}
                        placeholder="https://example.com/search?q=%s"
                        error={err === "quicksearch_err_url" ? i18n(err) : null}
                        onChange={(e) =>
                          onQuickSearchCustomChange(c.id, {
                            urlTemplate: e.target.value,
                          })
                        }
                        className="PrefModal__QuickSearchRow__Url"
                      />
                      <Select
                        label={i18n("options_quickSearchMatch")}
                        value={
                          c.match === MATCH_DIGITS ? MATCH_DIGITS : MATCH_ANY
                        }
                        allowDeselect={false}
                        onChange={(val) =>
                          onQuickSearchCustomChange(c.id, { match: val })
                        }
                        data={[
                          {
                            value: MATCH_ANY,
                            label: i18n("options_quickSearchMatchAny"),
                          },
                          {
                            value: MATCH_DIGITS,
                            label: i18n("options_quickSearchMatchDigits"),
                          },
                        ]}
                        className="PrefModal__QuickSearchRow__Match"
                      />
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={i18n("options_quickSearchDelete")}
                        onClick={() => onQuickSearchCustomDelete(c.id)}
                      >
                        ✕
                      </ActionIcon>
                    </div>
                  );
                })}
                <Button variant="default" onClick={onQuickSearchCustomAdd}>
                  {i18n("options_quickSearchAdd")}
                </Button>
              </fieldset>
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
                  <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                    <legend>{i18n("options_autoLogin")}</legend>
                    <Text size="xs" c="dimmed" mb="xs">
                      {i18n("tooltip_autoLoginSynced")}
                    </Text>
                    <PrefCheckbox
                      name="autoLogin"
                      checked={values.autoLogin}
                      onChange={onCheckboxChange}
                    >
                      {i18n("options_autoLoginEnable")}
                    </PrefCheckbox>
                    <Select
                      label={i18n("options_autoLoginDupConn")}
                      name="autoLoginDupConn"
                      /* Chrome 曾把這顆 Select 的內層 input 當成「帳號欄」配對到下面的
                     密鑰欄，跳出「使用者名稱：刪除其他連線 (Y)」的假儲存提示。 */
                      autoComplete="off"
                      value={values.autoLoginDupConn}
                      allowDeselect={false}
                      onChange={(val) => onSelectStr("autoLoginDupConn", val)}
                      data={[
                        {
                          value: "N",
                          label: i18n("options_autoLoginDupConnNo"),
                        },
                        {
                          value: "Y",
                          label: i18n("options_autoLoginDupConnYes"),
                        },
                      ]}
                      mb="xs"
                    />
                    <PrefCheckbox
                      name="autoLoginSkipWelcome"
                      checked={values.autoLoginSkipWelcome}
                      onChange={onCheckboxChange}
                    >
                      {i18n("options_autoLoginSkipWelcome")}
                    </PrefCheckbox>
                  </fieldset>
                  <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                    <legend>{i18n("options_autoLoginCredentials")}</legend>
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
                    <Text size="xs" c="dimmed" mb="xs">
                      {i18n("tooltip_autoLoginUpdate")}
                    </Text>
                    <TextInput
                      label={i18n("options_autoLoginUser")}
                      name="autoLoginUser"
                      autoComplete="off"
                      placeholder={
                        credentialApi
                          ? i18n("placeholder_autoLoginUser")
                          : undefined
                      }
                      value={values.autoLoginUser}
                      onChange={onTextInputChange}
                      mb="xs"
                    />
                    <TextInput
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
                      mb="xs"
                    />
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
                    <TextInput
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
                      mb="xs"
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
                  </fieldset>
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
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_ai")}</legend>
                <Text className="PrefModal__warning">{i18n("tooltip_ai")}</Text>
                <PrefCheckbox
                  name="enableAi"
                  checked={values.enableAi}
                  disabled={aiUnusable || aiState === "downloading"}
                  onChange={onAiMasterChange}
                >
                  {i18n("options_enableAi")}
                </PrefCheckbox>
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
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_ai_features")}</legend>
                <PrefCheckbox
                  name="enableCaptionAi"
                  checked={values.enableCaptionAi}
                  disabled={aiSubDisabled}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableCaptionAi")}
                </PrefCheckbox>
                {/* 網址類複核，管兩個增強功能：裸網域自動連結（AI 只能撤掉誤連）
                    與自動修復斷掉的連結（AI 才能放行規則不敢認的候選）。兩者都
                    關掉時它無事可做。 */}
                <PrefCheckbox
                  name="enableUrlAi"
                  checked={values.enableUrlAi}
                  disabled={
                    aiSubDisabled ||
                    !(values.enableBareDomainLink || values.enableAutoFixUrl)
                  }
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableUrlAi")}
                </PrefCheckbox>
                <Text size="xs" c="dimmed">
                  {i18n("tooltip_enableUrlAi")}
                </Text>
              </fieldset>
            </Tabs.Panel>
            {/* local-only 分頁：這裡的設定僅存本機、絕不上雲（LOCAL_ONLY_PREF_KEYS
                in pref_sync_logic.js）。之後新增的 local-only 設定一律放這。
                例外：自動登入的帳號／密碼／2FA 密鑰同樣 local-only，但整條登入
                流程要一起看才讀得懂，故集中在「自動登入」分頁。 */}
            <Tabs.Panel value="local">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_local")}</legend>
                <Text className="PrefModal__warning">
                  {i18n("tooltip_local")}
                </Text>
                <PrefCheckbox
                  name="enableWorkMode"
                  checked={values.enableWorkMode}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableWorkMode")}
                </PrefCheckbox>
                {/* urusai 圖床的存取憑證：是憑證就不上雲（LOCAL_ONLY_PREF_KEYS），
                    所以放這個分頁；留空＝匿名上傳，功能照常。
                    **刻意不是 type=password**（同 autoLoginOtpSecret 的理由）：整頁
                    多一個密碼欄，Chrome 就會把設定頁判成登入表單 → 跳假的「儲存密碼」
                    提示並開始自動填入。守護在 pref_modal_autologin_tab.test.jsx。 */}
                <TextInput
                  label={i18n("options_imageUploadToken")}
                  name="imageUploadToken"
                  autoComplete="off"
                  value={values.imageUploadToken}
                  placeholder={i18n("tooltip_imageUploadToken")}
                  onChange={onTextInputChange}
                  mt="xs"
                />
              </fieldset>
            </Tabs.Panel>
            <Tabs.Panel value="backup">
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_backupExport")}</legend>
                <Text className="PrefModal__warning">
                  {i18n("tooltip_backupExport")}
                </Text>
                <Button variant="default" onClick={onBackupExportClick}>
                  {i18n("options_backupExportBtn")}
                </Button>
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_backupImport")}</legend>
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
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_sync")}</legend>
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
              </fieldset>
            </Tabs.Panel>
            <Tabs.Panel value="about" className="PrefModal__about-selectable">
              <div>
                <Title order={4}>
                  PttChrome
                  <small> - {i18n("about_appName_subtitle")}</small>
                </Title>
                <Text>{replaceI18n("about_description", replacements)}</Text>
              </div>
              <div>
                <Title order={5}>{i18n("about_version_title")}</Title>
                <ul>
                  <li>{replaceI18n("about_version_current", replacements)}</li>
                  <li>{replaceI18n("about_version_original", replacements)}</li>
                  <li>
                    build: <code>{process.env.GIT_COMMIT}</code> (
                    {process.env.BUILD_TIME})
                  </li>
                </ul>
              </div>
              <div>
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
                />
              </div>
              <div>
                <Title order={5}>{i18n("about_new_title")}</Title>
                <ul>
                  {i18n("about_new_content").map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </div>
            </Tabs.Panel>
          </div>
        </div>
      </Tabs>
    </Modal>
  );
};

export default PrefModal;
