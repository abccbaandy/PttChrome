import cx from "classnames";
import React from "react";
import { compose, withStateHandlers, withHandlers, lifecycle } from "recompose";
import {
  Modal,
  Tab,
  Row,
  Col,
  Nav,
  NavItem,
  Button,
  Checkbox,
  FormGroup,
  ControlLabel,
  FormControl,
  OverlayTrigger,
  Popover
} from "react-bootstrap";
import { i18n } from "../../js/i18n";
import {
  DEFAULT_PREFS,
  readValuesWithDefault,
  writeValues
} from "../../js/pref_storage";
import * as prefSync from "../../js/pref_sync";
import { deepEqual } from "../../js/pref_sync_logic";
import "./PrefModal.css";

// With credentials filled in on a supporting browser, persist the password to
// the browser's password manager (Google Password Manager etc.) instead of
// localStorage. Returns the values to persist; the caller still hands the
// original (with password) to onSave so it takes effect this session.
const storeCredentialAndStrip = values => {
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
          name: "PTT"
        })
      )
      .catch(() => {});
  } catch (e) {
    return values;
  }
  return { ...values, autoLoginPassword: "" };
};

const normalizeSec = value => {
  const sec = parseInt(value, 10);
  return sec > 1 ? sec : 1;
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
  <a href={url} target="_blank" rel="noreferrer">
    {text}
  </a>
);

const changeNestedValue = (obj, key, newValue) => {
  let i = key.indexOf(".");
  if (i > 0) {
    let parentKey = key.substring(0, i);
    let subKey = key.substring(i + 1);
    return {
      ...obj,
      [parentKey]: changeNestedValue(obj[parentKey], subKey, newValue)
    };
  }
  return {
    ...obj,
    [key]: newValue
  };
};

const enhance = compose(
  withStateHandlers(
    () => ({
      navActiveKey: "general",
      values: readValuesWithDefault(),
      syncUser: null,
      syncStatus: "idle", // idle | syncing | synced | error
      replacements: {
        link_github_iamchucky: link(
          "Chuck Yang",
          "https://github.com/iamchucky"
        ),
        link_github_robertabcd: link(
          "robertabcd",
          "https://github.com/robertabcd"
        ),
        link_robertabcd_PttChrome: link(
          "robertabcd/PttChrome",
          "https://github.com/robertabcd/PttChrome"
        ),
        link_iamchucky_PttChrome: link(
          "iamchucky/PttChrome",
          "https://github.com/iamchucky/PttChrome"
        ),
        link_GPL20: link(
          "General Public License v2.0",
          "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html"
        )
      }
    }),
    {
      onCloseClick: ({ values }, { onSave }) => () => {
        // Untouched form → nothing to persist or upload; uploading anyway
        // would bump updatedAt and ping every other device for nothing.
        if (!deepEqual(values, readValuesWithDefault())) {
          writeValues(storeCredentialAndStrip(values));
          prefSync.savePrefs(values);
        }
        return onSave(values);
      },

      onResetClick: (state, { onReset }) => () => {
        prefSync.savePrefs(DEFAULT_PREFS);
        return onReset(
          writeValues({
            ...DEFAULT_PREFS
          })
        );
      },

      setSyncUser: () => syncUser => ({ syncUser }),

      setSyncStatus: () => syncStatus => ({ syncStatus }),

      setValues: () => values => ({ values }),

      onNavSelect: () => activeKey => ({
        navActiveKey: activeKey
      }),

      onCheckboxChange: ({ values }) => ({ target: { name, checked } }) => ({
        values: changeNestedValue(values, name, !!checked)
      }),

      onNumberInputChange: ({ values }) => ({ target: { name, value } }) => ({
        values: changeNestedValue(values, name, parseInt(value, 10))
      }),

      onTextInputChange: ({ values }) => ({ target: { name, value } }) => ({
        values: changeNestedValue(values, name, value)
      }),

      // Hotkey capture: record the pressed key (e.key) into the named pref.
      // Ignore bare modifier/Tab presses so the field can't be set to them.
      onHotkeyCapture: ({ values }) => e => {
        e.preventDefault();
        const key = e.key;
        // Use e.target (NOT e.currentTarget): recompose's withStateHandlers runs this
        // inside a setState updater, i.e. AFTER React's executeDispatch force-nulls
        // event.currentTarget at the end of the listener. e.target survives (same as
        // the sibling onCheckboxChange/onTextInputChange handlers). Reading
        // e.currentTarget here throws "Cannot read properties of null (reading 'name')".
        const name = e.target.name;
        if (["Shift", "Control", "Alt", "Meta", "Tab"].indexOf(key) >= 0) {
          return {};
        }
        return {
          values: changeNestedValue(values, name, key)
        };
      }
    }
  ),
  withHandlers({
    // Cloud values land in modal state only; the app applies them through the
    // regular onSave chain when the modal closes.
    onSyncSignInClick: ({ setSyncStatus, setValues }) => () => {
      setSyncStatus("syncing");
      prefSync
        .signIn(merged => setValues(merged))
        .then(() => setSyncStatus("synced"))
        .catch(e => {
          console.warn("pref_sync: sign-in failed", e);
          setSyncStatus("error");
        });
    },

    onSyncSignOutClick: ({ setSyncStatus }) => () => {
      setSyncStatus("idle");
      prefSync.signOut().catch(() => {});
    }
  }),
  lifecycle({
    componentDidMount() {
      this.unsubAuth = prefSync.onAuthState(user =>
        this.props.setSyncUser(user)
      );
    },
    componentDidUpdate(prevProps) {
      // The modal is mounted once at app startup and toggled via `show`, so
      // the form state captured back then goes stale: cloud snapshots and the
      // auto-login credential cleanup rewrite localStorage underneath it.
      // Without this re-read, closing the dialog would save (and upload)
      // those stale values — undoing the cleanup and overwriting newer cloud
      // prefs from another device.
      if (this.props.show && !prevProps.show) {
        console.info("PrefModal: open → re-read prefs from storage");
        this.props.setValues(readValuesWithDefault());
      }
    },
    componentWillUnmount() {
      if (this.unsubAuth) this.unsubAuth();
    }
  })
);

export const PrefModal = ({
  show,
  // from recompose
  onCloseClick,
  onResetClick,
  navActiveKey,
  onNavSelect,
  values,
  onCheckboxChange,
  onNumberInputChange,
  onTextInputChange,
  onHotkeyCapture,
  replacements,
  syncUser,
  syncStatus,
  onSyncSignInClick,
  onSyncSignOutClick
}) => (
  <Modal show={show} onHide={onCloseClick} className="PrefModal">
    <Modal.Body>
      <Tab.Container activeKey={navActiveKey} onSelect={onNavSelect}>
        <div className="PrefModal__Grid">
          <div className="PrefModal__Grid__Col--left">
            <h3>{i18n("menu_settings")}</h3>
            <Nav bsStyle="pills" stacked>
              <NavItem eventKey="general">{i18n("options_general")}</NavItem>
              <NavItem eventKey="enhance">{i18n("options_enhance")}</NavItem>
              <NavItem eventKey="about">{i18n("options_about")}</NavItem>
            </Nav>
            <Button
              className="PrefModal__Grid__Col--left__Reset"
              onClick={onResetClick}
            >
              {i18n("options_reset")}
            </Button>
          </div>
          <div className="PrefModal__Grid__Col--right">
            <Tab.Content animation>
              <Tab.Pane eventKey="general">
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>
                    {i18n("options_general")}
                    <button
                      type="button"
                      className="close"
                      onClick={onCloseClick}
                    >
                      &times;
                    </button>
                  </legend>
                  <Checkbox
                    name="enablePicPreview"
                    checked={values.enablePicPreview}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_enablePicPreview")}
                  </Checkbox>
                  <Checkbox
                    name="enableNotifications"
                    checked={values.enableNotifications}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_enableNotifications")}
                  </Checkbox>
                  <Checkbox
                    name="enableEasyReading"
                    checked={values.enableEasyReading}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_enableEasyReading")}
                  </Checkbox>
                  <Checkbox
                    name="easyReadingEndSwitchNative"
                    checked={values.easyReadingEndSwitchNative}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_easyReadingEndSwitchNative")}
                  </Checkbox>
                  <FormGroup controlId="easyReadingEndSwitchKey">
                    <ControlLabel>
                      {i18n("options_easyReadingEndSwitchKey")}
                    </ControlLabel>
                    <FormControl
                      name="easyReadingEndSwitchKey"
                      type="text"
                      readOnly
                      disabled={!values.easyReadingEndSwitchNative}
                      value={values.easyReadingEndSwitchKey}
                      placeholder={i18n("tooltip_easyReadingEndSwitchKey")}
                      onKeyDown={onHotkeyCapture}
                    />
                  </FormGroup>
                  <Checkbox
                    name="endTurnsOnLiveUpdate"
                    checked={values.endTurnsOnLiveUpdate}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_endTurnsOnLiveUpdate")}
                  </Checkbox>
                  <Checkbox
                    name="copyOnSelect"
                    checked={values.copyOnSelect}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_copyOnSelect")}
                  </Checkbox>
                  <FormGroup controlId="antiIdleTime">
                    <ControlLabel>{i18n("options_antiIdleTime")}</ControlLabel>
                    <OverlayTrigger
                      trigger="focus"
                      placement="right"
                      overlay={
                        <Popover id="tooltip_antiIdleTime">
                          {i18n("tooltip_antiIdleTime")}
                        </Popover>
                      }
                    >
                      <FormControl
                        name="antiIdleTime"
                        type="number"
                        value={values.antiIdleTime}
                        onChange={onNumberInputChange}
                      />
                    </OverlayTrigger>
                  </FormGroup>
                  <FormGroup controlId="lineWrap">
                    <ControlLabel>{i18n("options_lineWrap")}</ControlLabel>
                    <FormControl
                      name="lineWrap"
                      type="number"
                      value={values.lineWrap}
                      onChange={onNumberInputChange}
                    />
                  </FormGroup>
                </fieldset>
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>{i18n("options_connection")}</legend>
                  <Checkbox
                    name="useProxy"
                    checked={values.useProxy}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_useProxy")}
                  </Checkbox>
                  <FormGroup controlId="proxyUrl">
                    <ControlLabel>{i18n("options_proxyUrl")}</ControlLabel>
                    <FormControl
                      name="proxyUrl"
                      type="text"
                      disabled={!values.useProxy}
                      value={values.proxyUrl}
                      placeholder={i18n("tooltip_proxyUrl")}
                      onChange={onTextInputChange}
                    />
                  </FormGroup>
                </fieldset>
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>{i18n("options_appearance")}</legend>
                  <FormGroup controlId="fontFace">
                    <ControlLabel>{i18n("options_fontFace")}</ControlLabel>
                    <OverlayTrigger
                      trigger="focus"
                      placement="right"
                      overlay={
                        <Popover id="tooltip_fontFace">
                          {i18n("tooltip_fontFace")}
                        </Popover>
                      }
                    >
                      <FormControl
                        name="fontFace"
                        type="text"
                        value={values.fontFace}
                        onChange={onTextInputChange}
                      />
                    </OverlayTrigger>
                  </FormGroup>
                  <FormGroup controlId="bbsMargin">
                    <ControlLabel>{i18n("options_bbsMargin")}</ControlLabel>
                    <FormControl
                      name="bbsMargin"
                      type="number"
                      value={values.bbsMargin}
                      onChange={onNumberInputChange}
                    />
                  </FormGroup>
                  <FormGroup controlId="termSizeMode">
                    <ControlLabel>{i18n("options_termSize")}</ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="termSizeMode"
                      value={values.termSizeMode}
                      onChange={onTextInputChange}
                    >
                      <option
                        key={"options_fixedTermSize"}
                        value={"fixed-term-size"}
                      >
                        {i18n("options_fixedTermSize")}
                      </option>
                      <option
                        key={"options_fixedFontSize"}
                        value={"fixed-font-size"}
                      >
                        {i18n("options_fixedFontSize")}
                      </option>
                    </FormControl>
                  </FormGroup>
                  {(() => {
                    switch (values.termSizeMode) {
                      case "fixed-term-size":
                        return (
                          <div>
                            <FormGroup controlId="termSize_cols">
                              <ControlLabel>
                                {i18n("options_cols")}
                              </ControlLabel>
                              <FormControl
                                name="termSize.cols"
                                type="number"
                                value={values.termSize.cols}
                                onChange={onNumberInputChange}
                              />
                            </FormGroup>
                            <FormGroup controlId="termSize_rows">
                              <ControlLabel>
                                {i18n("options_rows")}
                              </ControlLabel>
                              <FormControl
                                name="termSize.rows"
                                type="number"
                                value={values.termSize.rows}
                                onChange={onNumberInputChange}
                              />
                            </FormGroup>
                            <Checkbox
                              name="fontFitWindowWidth"
                              checked={values.fontFitWindowWidth}
                              onChange={onCheckboxChange}
                            >
                              {i18n("options_fontFitWindowWidth")}
                            </Checkbox>
                          </div>
                        );
                      case "fixed-font-size":
                        return (
                          <FormGroup controlId="fontSize">
                            <ControlLabel>
                              {i18n("options_fontSize")}
                            </ControlLabel>
                            <FormControl
                              name="fontSize"
                              type="number"
                              value={values.fontSize}
                              onChange={onNumberInputChange}
                            />
                          </FormGroup>
                        );
                      default:
                        return null;
                    }
                  })()}
                </fieldset>
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>{i18n("options_mouseBrowsing")}</legend>
                  <Checkbox
                    name="useMouseBrowsing"
                    checked={values.useMouseBrowsing}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_useMouseBrowsing")}
                  </Checkbox>
                  <Checkbox
                    name="mouseBrowsingHighlight"
                    checked={values.mouseBrowsingHighlight}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_mouseBrowsingHighlight")}
                  </Checkbox>
                  <div className="PrefModal__Grid__Col--right__MouseBrowsingHighlightColor">
                    {i18n("options_highlightColor")}
                    <FormControl
                      componentClass="select"
                      className={cx(
                        `b${values.mouseBrowsingHighlightColor}`,
                        `b${values.mouseBrowsingHighlightColor}`
                      )}
                      name="mouseBrowsingHighlightColor"
                      value={values.mouseBrowsingHighlightColor}
                      onChange={onNumberInputChange}
                    >
                      {Array(16)
                        .fill(0, 1 /* skip transparent (index === 0) */)
                        .map((x, i) => (
                          <option
                            key={i}
                            value={i}
                            className={cx(
                              `b${i}` /* FIXME: Existing bug: Not working for Chrome */
                            )}
                          />
                        ))}
                    </FormControl>
                  </div>
                  <FormGroup controlId="mouseLeftFunction">
                    <ControlLabel>
                      {i18n("options_mouseLeftFunction")}
                    </ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="mouseLeftFunction"
                      value={values.mouseLeftFunction}
                      onChange={onNumberInputChange}
                    >
                      {[
                        "options_none",
                        "options_enterKey",
                        "options_rightKey"
                      ].map((key, index) => (
                        <option key={key} value={index}>
                          {i18n(key)}
                        </option>
                      ))}
                    </FormControl>
                  </FormGroup>
                  <FormGroup controlId="mouseMiddleFunction">
                    <ControlLabel>
                      {i18n("options_mouseMiddleFunction")}
                    </ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="mouseMiddleFunction"
                      value={values.mouseMiddleFunction}
                      onChange={onNumberInputChange}
                    >
                      {[
                        "options_none",
                        "options_enterKey",
                        "options_leftKey",
                        "options_doPaste"
                      ].map((key, index) => (
                        <option key={key} value={index}>
                          {i18n(key)}
                        </option>
                      ))}
                    </FormControl>
                  </FormGroup>
                  <FormGroup controlId="mouseWheelFunction1">
                    <ControlLabel>
                      {i18n("options_mouseWheelFunction1")}
                    </ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="mouseWheelFunction1"
                      value={values.mouseWheelFunction1}
                      onChange={onNumberInputChange}
                    >
                      {[
                        "options_none",
                        "options_upDown",
                        "options_pageUpDown",
                        "options_threadLastNext"
                      ].map((key, index) => (
                        <option key={key} value={index}>
                          {i18n(key)}
                        </option>
                      ))}
                    </FormControl>
                  </FormGroup>
                  <FormGroup controlId="mouseWheelFunction2">
                    <ControlLabel>
                      {i18n("options_mouseWheelFunction2")}
                    </ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="options_mouseWheelFunction2"
                      value={values.options_mouseWheelFunction2}
                      onChange={onNumberInputChange}
                    >
                      {[
                        "options_none",
                        "options_upDown",
                        "options_pageUpDown",
                        "options_threadLastNext"
                      ].map((key, index) => (
                        <option key={key} value={index}>
                          {i18n(key)}
                        </option>
                      ))}
                    </FormControl>
                  </FormGroup>
                  <FormGroup controlId="mouseWheelFunction3">
                    <ControlLabel>
                      {i18n("options_mouseWheelFunction3")}
                    </ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="options_mouseWheelFunction3"
                      value={values.options_mouseWheelFunction3}
                      onChange={onNumberInputChange}
                    >
                      {[
                        "options_none",
                        "options_upDown",
                        "options_pageUpDown",
                        "options_threadLastNext"
                      ].map((key, index) => (
                        <option key={key} value={index}>
                          {i18n(key)}
                        </option>
                      ))}
                    </FormControl>
                  </FormGroup>
                </fieldset>
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>{i18n("options_sync")}</legend>
                  <p className="PrefModal__warning">{i18n("tooltip_sync")}</p>
                  {syncUser ? (
                    <div>
                      <p>
                        {i18n("options_syncSignedInAs")}
                        {syncUser.email}
                      </p>
                      <Button onClick={onSyncSignOutClick}>
                        {i18n("options_syncSignOut")}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      onClick={onSyncSignInClick}
                      disabled={syncStatus === "syncing"}
                    >
                      {i18n("options_syncSignIn")}
                    </Button>
                  )}
                  {syncStatus !== "idle" && (
                    <p>
                      {i18n(
                        {
                          syncing: "options_syncStatusSyncing",
                          synced: "options_syncStatusSynced",
                          error: "options_syncStatusError"
                        }[syncStatus]
                      )}
                    </p>
                  )}
                </fieldset>
              </Tab.Pane>
              <Tab.Pane eventKey="enhance">
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>
                    {i18n("options_enhance")}
                    <button
                      type="button"
                      className="close"
                      onClick={onCloseClick}
                    >
                      &times;
                    </button>
                  </legend>
                  <Checkbox
                    name="showFloorNumbers"
                    checked={values.showFloorNumbers}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_showFloorNumbers")}
                  </Checkbox>
                  <Checkbox
                    name="highlightAuthorComments"
                    checked={values.highlightAuthorComments}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_highlightAuthorComments")}
                  </Checkbox>
                  <Checkbox
                    name="enableAutoFixUrl"
                    checked={values.enableAutoFixUrl}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_enableAutoFixUrl")}
                  </Checkbox>
                  <Checkbox
                    name="enableXMentionLink"
                    checked={values.enableXMentionLink}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_enableXMentionLink")}
                  </Checkbox>
                  <FormGroup controlId="blacklist">
                    <ControlLabel>{i18n("options_blacklist")}</ControlLabel>
                    <FormControl
                      componentClass="textarea"
                      name="blacklist"
                      rows={6}
                      value={values.blacklist}
                      placeholder={i18n("tooltip_blacklist")}
                      onChange={onTextInputChange}
                    />
                  </FormGroup>
                </fieldset>
                <fieldset className="PrefModal__Grid__Col--right__Fieldset">
                  <legend>{i18n("options_autoLogin")}</legend>
                  <Checkbox
                    name="autoLogin"
                    checked={values.autoLogin}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_autoLoginEnable")}
                  </Checkbox>
                  <p className="PrefModal__warning">
                    {window.PasswordCredential
                      ? i18n("tooltip_autoLogin")
                      : i18n("tooltip_autoLoginPlaintext")}
                  </p>
                  <FormGroup controlId="autoLoginUser">
                    <ControlLabel>{i18n("options_autoLoginUser")}</ControlLabel>
                    <FormControl
                      name="autoLoginUser"
                      type="text"
                      autoComplete="off"
                      value={values.autoLoginUser}
                      onChange={onTextInputChange}
                    />
                  </FormGroup>
                  <FormGroup controlId="autoLoginPassword">
                    <ControlLabel>
                      {i18n("options_autoLoginPassword")}
                    </ControlLabel>
                    <FormControl
                      name="autoLoginPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        window.PasswordCredential
                          ? i18n("placeholder_autoLoginPassword")
                          : undefined
                      }
                      value={values.autoLoginPassword}
                      onChange={onTextInputChange}
                    />
                  </FormGroup>
                  <FormGroup controlId="autoLoginDupConn">
                    <ControlLabel>
                      {i18n("options_autoLoginDupConn")}
                    </ControlLabel>
                    <FormControl
                      componentClass="select"
                      name="autoLoginDupConn"
                      value={values.autoLoginDupConn}
                      onChange={onTextInputChange}
                    >
                      <option value="N">
                        {i18n("options_autoLoginDupConnNo")}
                      </option>
                      <option value="Y">
                        {i18n("options_autoLoginDupConnYes")}
                      </option>
                    </FormControl>
                  </FormGroup>
                  <Checkbox
                    name="autoLoginSkipWelcome"
                    checked={values.autoLoginSkipWelcome}
                    onChange={onCheckboxChange}
                  >
                    {i18n("options_autoLoginSkipWelcome")}
                  </Checkbox>
                </fieldset>
              </Tab.Pane>
              <Tab.Pane
                eventKey="about"
                className="PrefModal__about-selectable"
              >
                <div>
                  <legend>
                    PttChrome<small> - {i18n("about_appName_subtitle")}</small>
                    <button
                      type="button"
                      className="close"
                      onClick={onCloseClick}
                    >
                      &times;
                    </button>
                  </legend>
                  <p>{replaceI18n("about_description", replacements)}</p>
                </div>
                <div>
                  <legend>{i18n("about_version_title")}</legend>
                  <ul>
                    <li>
                      {replaceI18n("about_version_current", replacements)}
                    </li>
                    <li>
                      {replaceI18n("about_version_original", replacements)}
                    </li>
                    <li>
                      build: <code>{process.env.GIT_COMMIT}</code> (
                      {process.env.BUILD_TIME})
                    </li>
                  </ul>
                </div>
                <div>
                  <legend>{i18n("about_new_title")}</legend>
                  <ul>
                    {i18n("about_new_content").map((text, index) => (
                      <li key={index}>{text}</li>
                    ))}
                  </ul>
                </div>
              </Tab.Pane>
            </Tab.Content>
          </div>
        </div>
      </Tab.Container>
    </Modal.Body>
  </Modal>
);

export default enhance(PrefModal);
