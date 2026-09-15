// 設定頁左欄的搜尋框。
//
// **命名**：與右鍵選單的「快速搜尋」（src/js/quick_search.js，選字跳 Google）
// 是兩回事，勿混用。
//
// 為什麼用 Mantine 內建的 Combobox 而不是 @mantine/spotlight：後者要新增依賴，
// 而 Combobox 本來就在 bundle 裡（Select 就是拿它做的）。它還順帶免費解掉
// Escape 的衝突——Combobox.Target 會在下拉開著時自動掛上
// data-mantine-stop-propagation，而 Modal 的 Esc 攔截是 window + capture，
// 自己呼叫 stopPropagation() 對它無效。結果正是想要的：下拉開著按 Esc 只關下拉，
// 下拉關著才關設定頁。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox, TextInput, Text, useCombobox } from "@mantine/core";
import { i18n } from "../../js/i18n";
import { searchPrefSettings } from "../../js/pref_search";

// 高亮片段一律照 searchPrefSettings 回傳的區間切，**不在這裡重新比對一次**：
// 比對規則只能有一份，否則兩邊遲早會漂掉。
const Highlighted = ({ text, ranges }) => {
  if (!ranges || !ranges.length) return text;
  const out = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark className="PrefModal__Search__Mark" key={i}>
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
};

export const PrefSearchBox = ({ onJump, resetToken }) => {
  const [query, setQuery] = useState("");
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const results = useMemo(() => searchPrefSettings(query), [query]);

  // 查詢一變就把第一筆設為選取，否則 Enter 不會有反應：Mantine 的 Enter 分支
  // 要求 selectedOptionIndex !== -1，而沒按過方向鍵時它是 -1。必須等新選項
  // render 完才呼叫——selectFirstOption 讀的是 DOM。
  useEffect(() => {
    if (results.length) combobox.selectFirstOption();
    // combobox 是 store，identity 每次 render 都變，放進 deps 會變成無窮迴圈。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // 設定頁重開 → 從乾淨狀態開始（否則會看到上次的查詢字還在）。
  useEffect(() => {
    setQuery("");
    combobox.closeDropdown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  const onChange = useCallback(
    (e) => {
      const v = e.currentTarget.value;
      setQuery(v);
      if (v.trim()) combobox.openDropdown();
      else combobox.closeDropdown();
    },
    [combobox],
  );

  const onSubmit = useCallback(
    (val) => {
      const hit = results.find((r) => r.key === val);
      combobox.closeDropdown();
      if (hit) onJump(hit);
    },
    [results, combobox, onJump],
  );

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={onSubmit}
      // 左欄只有 160px 寬；不給 width 的話 Combobox 預設是 "target"（跟著目標
      // 元素寬度），結果會窄到讀不了。
      width={340}
      position="bottom-start"
      shadow="md"
      // withinPortal 預設就是 true，而且**不可以關掉**：.mantine-Modal-body 是
      // overflow:hidden，不 portal 出去的下拉會被整個裁掉。
    >
      <Combobox.Target>
        <TextInput
          aria-label={i18n("options_settingsSearchLabel")}
          placeholder={i18n("options_settingsSearchPlaceholder")}
          value={query}
          size="xs"
          mb="xs"
          className="PrefModal__Search"
          onChange={onChange}
          onFocus={() => query.trim() && combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
        />
      </Combobox.Target>
      {/* className 是測試用來把「搜尋結果」跟畫面上其他 Select 的選項分開的
          依據——Mantine 的下拉全都是 role=listbox/option，全域抓會混在一起。 */}
      <Combobox.Dropdown className="PrefModal__Search__Dropdown">
        <Combobox.Options>
          {results.length ? (
            results.map((r) => (
              <Combobox.Option value={r.key} key={r.key}>
                <Text size="xs" c="dimmed">
                  {r.tabLabel}
                  {r.sectionLabel ? " · " + r.sectionLabel : ""}
                  {r.matchedVia === "key" || r.matchedVia === "altLang"
                    ? " · " + i18n("options_settingsSearchHintKey")
                    : ""}
                </Text>
                <Text size="sm">
                  <Highlighted text={r.title} ranges={r.ranges} />
                </Text>
              </Combobox.Option>
            ))
          ) : (
            <Combobox.Empty>
              {i18n("options_settingsSearchEmpty")}
            </Combobox.Empty>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
};

export default PrefSearchBox;
