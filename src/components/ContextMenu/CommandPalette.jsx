import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, TextInput, Text, UnstyledButton } from "@mantine/core";
import MobileSheet from "../MobileSheet";
import { i18n } from "../../js/i18n";
import { buildPaletteItems, movePaletteIndex } from "../../js/command_palette";
import "./CommandPalette.css";

// 指令面板的外殼（純邏輯在 js/command_palette.js，執行在 ./index.jsx#runPaletteItem）。
// ctx：開面板當下量好的「這一刻能做什麼」，面板開著期間不重量（畫面不會在面板開著時變）。
// 清單框固定高度（CommandPalette.css）：打字時項目數一直變，彈窗高度不可以跟著跳。

const fmt = (key, vars) =>
  String(i18n(key) || "").replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );

const KIND_KEY = {
  article: "palette_kindArticle",
  board: "palette_kindBoard",
  search: "palette_kindSearch",
  action: "palette_kindAction",
  setting: "palette_kindSetting",
};

const SEARCH_TITLE_KEY = {
  title: "palette_searchTitle",
  author: "palette_searchAuthor",
  push: "palette_searchPush",
};

export function paletteItemLabel(item) {
  switch (item.kind) {
    case "article":
      // 最近讀過／稍後再讀：標題＋「稍後再讀 · 看板」（沒有標題的退回 #AID 寫法）。
      if (item.source)
        return {
          title: item.title || fmt("palette_openArticle", item.target),
          subtitle: [
            i18n(item.source === "later" ? "recent_later" : "recent_recent"),
            item.target.board,
          ].join(" · "),
        };
      return { title: fmt("palette_openArticle", item.target) };
    case "board":
      return {
        title: fmt("palette_gotoBoard", { board: item.text }),
        subtitle:
          item.source === "recent"
            ? i18n("palette_recentBoard")
            : item.source === "favorite"
              ? [i18n("palette_favoriteBoard"), item.desc]
                  .filter(Boolean)
                  .join(" · ")
              : undefined,
      };
    case "search":
      return {
        title: fmt(SEARCH_TITLE_KEY[item.searchKind], { q: item.text }),
      };
    case "action":
      return { title: i18n(item.titleKey) };
    case "setting":
      return {
        title: fmt("palette_setting", { title: item.title }),
        subtitle: [item.tabLabel, item.sectionLabel]
          .filter(Boolean)
          .join(" › "),
      };
    default:
      return { title: item.id };
  }
}

export const CommandPalette = ({
  show,
  ctx,
  onHide,
  onRun,
  mobile,
  pttchrome,
}) => {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // 每次打開都從空白開始（同 SearchModal：上一次打的字留著只會擋路）。
  useEffect(() => {
    if (show) {
      setQuery("");
      setIndex(0);
    }
  }, [show]);
  const items = useMemo(
    () =>
      show
        ? buildPaletteItems(query, { ...(ctx || {}), title: (k) => i18n(k) })
        : [],
    [show, query, ctx],
  );
  const active = items.length
    ? Math.min(Math.max(index, 0), items.length - 1)
    : -1;

  const run = useCallback(
    (item) => {
      if (item) onRun(item);
    },
    [onRun],
  );
  const onChange = useCallback((e) => {
    setQuery(e.currentTarget.value);
    setIndex(0);
  }, []);
  const onKeyDown = useCallback(
    (e) => {
      if (e.nativeEvent && e.nativeEvent.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex(
          movePaletteIndex(
            active,
            e.key === "ArrowDown" ? 1 : -1,
            items.length,
          ),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        run(items[active]);
      }
    },
    [active, items, run],
  );
  // 鍵盤移動時讓選到的那一項保持在框內。
  useEffect(() => {
    if (!show || active < 0) return;
    const node = document.querySelector(`[data-palette-index="${active}"]`);
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
  }, [show, active]);

  const body = (
    <div className="commandPalette" data-command-palette>
      <TextInput
        data-autofocus
        name="commandPaletteQuery"
        placeholder={i18n("palette_placeholder")}
        autoComplete="off"
        value={query}
        onChange={onChange}
        onKeyDown={onKeyDown}
        aria-controls="commandPaletteList"
      />
      <div
        id="commandPaletteList"
        className="commandPaletteList"
        role="listbox"
        data-mobile={mobile ? "" : undefined}
      >
        {items.length === 0 && (
          <Text size="sm" c="dimmed" p="xs" data-palette-empty>
            {i18n("palette_empty")}
          </Text>
        )}
        {items.map((item, i) => {
          const label = paletteItemLabel(item);
          return (
            <UnstyledButton
              key={item.id}
              role="option"
              aria-selected={i === active}
              className="commandPaletteItem"
              data-palette-item={item.id}
              data-palette-index={i}
              data-active={i === active ? "" : undefined}
              onMouseMove={() => i !== active && setIndex(i)}
              onClick={() => run(item)}
            >
              <span className="commandPaletteKind">
                {i18n(KIND_KEY[item.kind])}
              </span>
              <span className="commandPaletteText">
                <span className="commandPaletteTitle">{label.title}</span>
                {label.subtitle && (
                  <span className="commandPaletteSub">{label.subtitle}</span>
                )}
              </span>
            </UnstyledButton>
          );
        })}
      </div>
      {!mobile && (
        <Text size="xs" c="dimmed" mt={6}>
          {i18n("palette_footer")}
        </Text>
      )}
    </div>
  );

  if (mobile)
    return (
      <MobileSheet
        pttchrome={pttchrome}
        opened={show}
        onClose={onHide}
        title={i18n("cmenu_commandPalette")}
        sheetKey="commandPalette"
      >
        {body}
      </MobileSheet>
    );
  return (
    <Modal
      opened={show}
      onClose={onHide}
      withCloseButton={false}
      // 貼頂不置中：結果多寡不移動輸入框（同 SearchModal）。
      yOffset="10vh"
      size="lg"
      aria-label={i18n("cmenu_commandPalette")}
    >
      {body}
    </Modal>
  );
};

export default CommandPalette;
