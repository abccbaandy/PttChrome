import { useState, useCallback, useEffect } from "react";
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
  captionAiAvailability,
  ensureCaptionAiReady,
} from "../../js/caption_ai";
import { deepEqual } from "../../js/pref_sync_logic";
import "./PrefModal.css";

// Checkbox adapter：保留 id={`pref-check-${name}`}（label[for=...] e2e marker，且
// 點 label 文字才能切換）、name（input[name=...] marker）、event.target.checked 契約。
const PrefCheckbox = ({ name, checked, onChange, children }) => (
  <Checkbox
    id={`pref-check-${name}`}
    name={name}
    checked={checked}
    onChange={onChange}
    label={children}
    mb="xs"
  />
);

// With credentials filled in on a supporting browser, persist the password to
// the browser's password manager (Google Password Manager etc.) instead of
// localStorage. Returns the values to persist; the caller still hands the
// original (with password) to onSave so it takes effect this session.
const storeCredentialAndStrip = (values) => {
  if (
    !values.autoLogin ||
    !values.autoLoginUser ||
    !values.autoLoginPassword ||
    !window.PasswordCredential ||
    !(navigator.credentials && navigator.credentials.store)
  ) {
    return values; // unsupported browser → legacy plaintext behavior
  }
  try {
    navigator.credentials
      .store(
        new PasswordCredential({
          id: values.autoLoginUser,
          password: values.autoLoginPassword,
          name: "PTT",
        }),
      )
      .catch(() => {});
  } catch (e) {
    return values;
  }
  return { ...values, autoLoginPassword: "" };
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
  const [syncUser, setSyncUser] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | synced | error
  // 裝置端 AI（好讀圖文並排的 AI 校正）：unsupported | unavailable | downloadable
  // | downloading | available。開啟本 tab 時查一次；按鈕按下去才可能觸發下載
  // （Prompt API 的模型下載需要 user activation）。
  const [captionAiState, setCaptionAiState] = useState(null);
  const [captionAiProgress, setCaptionAiProgress] = useState(null);
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  useEffect(() => {
    let alive = true;
    captionAiAvailability().then((a) => alive && setCaptionAiState(a));
    return () => {
      alive = false;
    };
  }, []);

  const onCaptionAiEnableClick = useCallback(() => {
    setCaptionAiState("downloading");
    ensureCaptionAiReady((loaded) =>
      setCaptionAiProgress(Math.round(loaded * 100)),
    ).then((a) => {
      setCaptionAiState(a);
      setCaptionAiProgress(null);
    });
  }, []);

  const onCloseClick = useCallback(() => {
    // Untouched form → nothing to persist or upload; uploading anyway
    // would bump updatedAt and ping every other device for nothing.
    if (!deepEqual(values, readValuesWithDefault())) {
      writeValues(storeCredentialAndStrip(values));
      prefSync.savePrefs(values);
    }
    onSave(values);
  }, [values, onSave]);

  const onResetClick = useCallback(() => {
    prefSync.savePrefs(DEFAULT_PREFS);
    onReset(writeValues({ ...DEFAULT_PREFS }));
  }, [onReset]);

  const onCheckboxChange = useCallback(({ target: { name, checked } }) => {
    setValues((v) => changeNestedValue(v, name, !!checked));
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
      setValues(readValuesWithDefault());
    }
  }, [show]);

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
              <Tabs.Tab value="enhance">{i18n("options_enhance")}</Tabs.Tab>
              <Tabs.Tab value="local">{i18n("options_local")}</Tabs.Tab>
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
                <legend>{i18n("options_connection")}</legend>
                <PrefCheckbox
                  name="useProxy"
                  checked={values.useProxy}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_useProxy")}
                </PrefCheckbox>
                <TextInput
                  label={i18n("options_proxyUrl")}
                  name="proxyUrl"
                  disabled={!values.useProxy}
                  value={values.proxyUrl}
                  placeholder={i18n("tooltip_proxyUrl")}
                  onChange={onTextInputChange}
                  mb="xs"
                />
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_appearance")}</legend>
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
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_mouseBrowsing")}</legend>
                <PrefCheckbox
                  name="useMouseBrowsing"
                  checked={values.useMouseBrowsing}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_useMouseBrowsing")}
                </PrefCheckbox>
                <PrefCheckbox
                  name="mouseBrowsingHighlight"
                  checked={values.mouseBrowsingHighlight}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_mouseBrowsingHighlight")}
                </PrefCheckbox>
                <Text size="sm" fw={500} mb={4}>
                  {i18n("options_highlightColor")}
                </Text>
                {/* 一排可點色塊（b1..b15 = color.css 的底色 class），選中者描邊。
                    比下拉好：直接顯示對應顏色，而非 index 數字。 */}
                <div
                  className="PrefModal__HighlightColors"
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 4,
                    marginBottom: 12,
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
                <Select
                  label={i18n("options_mouseLeftFunction")}
                  name="mouseLeftFunction"
                  value={String(values.mouseLeftFunction)}
                  allowDeselect={false}
                  onChange={(val) => onSelectNum("mouseLeftFunction", val)}
                  data={selectData([
                    "options_none",
                    "options_enterKey",
                    "options_rightKey",
                  ])}
                  mb="xs"
                />
                <Select
                  label={i18n("options_mouseMiddleFunction")}
                  name="mouseMiddleFunction"
                  value={String(values.mouseMiddleFunction)}
                  allowDeselect={false}
                  onChange={(val) => onSelectNum("mouseMiddleFunction", val)}
                  data={selectData([
                    "options_none",
                    "options_enterKey",
                    "options_leftKey",
                    "options_doPaste",
                  ])}
                  mb="xs"
                />
                <Select
                  label={i18n("options_mouseWheelFunction1")}
                  name="mouseWheelFunction1"
                  value={String(values.mouseWheelFunction1)}
                  allowDeselect={false}
                  onChange={(val) => onSelectNum("mouseWheelFunction1", val)}
                  data={selectData([
                    "options_none",
                    "options_upDown",
                    "options_pageUpDown",
                    "options_threadLastNext",
                  ])}
                  mb="xs"
                />
                <Select
                  label={i18n("options_mouseWheelFunction2")}
                  name="mouseWheelFunction2"
                  value={String(values.mouseWheelFunction2)}
                  allowDeselect={false}
                  onChange={(val) => onSelectNum("mouseWheelFunction2", val)}
                  data={selectData([
                    "options_none",
                    "options_upDown",
                    "options_pageUpDown",
                    "options_threadLastNext",
                  ])}
                  mb="xs"
                />
                <Select
                  label={i18n("options_mouseWheelFunction3")}
                  name="mouseWheelFunction3"
                  value={String(values.mouseWheelFunction3)}
                  allowDeselect={false}
                  onChange={(val) => onSelectNum("mouseWheelFunction3", val)}
                  data={selectData([
                    "options_none",
                    "options_upDown",
                    "options_pageUpDown",
                    "options_threadLastNext",
                  ])}
                  mb="xs"
                />
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
                  name="enableCaptionAi"
                  checked={values.enableCaptionAi}
                  onChange={onCheckboxChange}
                >
                  {i18n("options_enableCaptionAi")}
                </PrefCheckbox>
                <div style={{ marginBottom: "0.5rem" }}>
                  <Button
                    id="captionAiEnableBtn"
                    variant="default"
                    size="xs"
                    onClick={onCaptionAiEnableClick}
                    disabled={
                      !values.enableCaptionAi ||
                      captionAiState === "unsupported" ||
                      captionAiState === "unavailable" ||
                      captionAiState === "downloading"
                    }
                  >
                    {i18n("options_captionAiEnableBtn")}
                  </Button>
                  {captionAiState && (
                    <Text size="xs" c="dimmed" mt={4}>
                      {i18n("options_captionAiStatus_" + captionAiState)}
                      {captionAiProgress !== null
                        ? " " + captionAiProgress + "%"
                        : ""}
                    </Text>
                  )}
                </div>
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
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_autoLogin")}</legend>
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
                  value={values.autoLoginDupConn}
                  allowDeselect={false}
                  onChange={(val) => onSelectStr("autoLoginDupConn", val)}
                  data={[
                    { value: "N", label: i18n("options_autoLoginDupConnNo") },
                    { value: "Y", label: i18n("options_autoLoginDupConnYes") },
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
            </Tabs.Panel>
            {/* local-only 分頁：這裡的設定僅存本機、絕不上雲（LOCAL_ONLY_PREF_KEYS
                in pref_sync_logic.js）。之後新增的 local-only 設定一律放這。
                注意：自動登入的開關/重複登入/跳過歡迎畫面「有」上雲，故留在增強
                功能分頁；只有帳號密碼欄位是 local-only 放這裡。 */}
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
              </fieldset>
              <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                <legend>{i18n("options_autoLoginCredentials")}</legend>
                <Text className="PrefModal__warning">
                  {window.PasswordCredential
                    ? i18n("tooltip_autoLogin")
                    : i18n("tooltip_autoLoginPlaintext")}
                </Text>
                <TextInput
                  label={i18n("options_autoLoginUser")}
                  name="autoLoginUser"
                  autoComplete="off"
                  value={values.autoLoginUser}
                  onChange={onTextInputChange}
                  mb="xs"
                />
                <TextInput
                  label={i18n("options_autoLoginPassword")}
                  type="password"
                  name="autoLoginPassword"
                  autoComplete="new-password"
                  placeholder={
                    window.PasswordCredential
                      ? i18n("placeholder_autoLoginPassword")
                      : undefined
                  }
                  value={values.autoLoginPassword}
                  onChange={onTextInputChange}
                  mb="xs"
                />
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
