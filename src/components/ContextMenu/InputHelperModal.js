import { useState, useCallback, useRef } from "react";
import {
  Paper,
  Tabs,
  Menu,
  Button,
  Checkbox,
  CloseButton,
  Group,
  Text,
} from "@mantine/core";
import ColorSpan from "../Row/WordSegmentBuilder/ColorSpan";
import { i18n } from "../../js/i18n";
import "./InputHelperModal.css";

const SYMBOLS = {
  general: [
    "，",
    "、",
    "。",
    "．",
    "？",
    "！",
    "～",
    "＄",
    "％",
    "＠",
    "＆",
    "＃",
    "＊",
    "‧",
    "；",
    "︰",
    "…",
    "‥",
    "﹐",
    "﹒",
    "˙",
    "·",
    "﹔",
    "﹕",
    "‘",
    "’",
    "“",
    "”",
    "〝",
    "〞",
    "‵",
    "′",
    "〃",
  ],

  lineBorders: [
    "├",
    "─",
    "┼",
    "┴",
    "┬",
    "┤",
    "┌",
    "┐",
    "│",
    "▕",
    "└",
    "┘",
    "╭",
    "╮",
    "╰",
    "╯",
    "╔",
    "╦",
    "╗",
    "╠",
    "═",
    "╬",
    "╣",
    "╓",
    "╥",
    "╖",
    "╒",
    "╤",
    "╕",
    "║",
    "╚",
    "╩",
    "╝",
    "╟",
    "╫",
    "╢",
    "╙",
    "╨",
    "╜",
    "╞",
    "╪",
    "╡",
    "╘",
    "╧",
    "╛",
  ],

  blocks: [
    "＿",
    "ˍ",
    "▁",
    "▂",
    "▃",
    "▄",
    "▅",
    "▆",
    "▇",
    "█",
    "▏",
    "▎",
    "▍",
    "▌",
    "▋",
    "▊",
    "▉",
    "◢",
    "◣",
    "◥",
    "◤",
  ],

  lines: [
    "﹣",
    "﹦",
    "≡",
    "｜",
    "∣",
    "∥",
    "–",
    "︱",
    "—",
    "︳",
    "╴",
    "¯",
    "￣",
    "﹉",
    "﹊",
    "﹍",
    "﹎",
    "﹋",
    "﹌",
    "﹏",
    "︴",
    "∕",
    "﹨",
    "╱",
    "╲",
    "／",
    "＼",
  ],

  special: [
    "↑",
    "↓",
    "←",
    "→",
    "↖",
    "↗",
    "↙",
    "↘",
    "㊣",
    "◎",
    "○",
    "●",
    "⊕",
    "⊙",
    "△",
    "▲",
    "☆",
    "★",
    "◇",
    "Æ",
    "□",
    "■",
    "▽",
    "▼",
    "§",
    "￥",
    "〒",
    "￠",
    "￡",
    "※",
    "♀",
    "♂",
  ],

  brackets: [
    "〔",
    "〕",
    "【",
    "】",
    "《",
    "》",
    "（",
    "）",
    "｛",
    "｝",
    "﹙",
    "﹚",
    "『",
    "』",
    "﹛",
    "﹜",
    "﹝",
    "﹞",
    "＜",
    "＞",
    "﹤",
    "﹥",
    "「",
    "」",
    "︵",
    "︶",
    "︷",
    "︸",
    "︹",
    "︺",
    "︻",
    "︼",
    "︽",
    "︾",
    "〈",
    "〉",
    "︿",
    "﹀",
    "﹁",
    "﹂",
    "﹃",
    "﹄",
  ],

  greek: [
    "Α",
    "Β",
    "Γ",
    "Δ",
    "Ε",
    "Ζ",
    "Η",
    "Θ",
    "Ι",
    "Κ",
    "Λ",
    "Μ",
    "Ν",
    "Ξ",
    "Ο",
    "Π",
    "Ρ",
    "Σ",
    "Τ",
    "Υ",
    "Φ",
    "Χ",
    "Ψ",
    "Ω",
    "α",
    "β",
    "γ",
    "δ",
    "ε",
    "ζ",
    "η",
    "θ",
    "ι",
    "κ",
    "λ",
    "μ",
    "ν",
    "ξ",
    "ο",
    "π",
    "ρ",
    "σ",
    "τ",
    "υ",
    "φ",
    "χ",
    "ψ",
    "ω",
  ],

  phonetic: [
    "ㄅ",
    "ㄆ",
    "ㄇ",
    "ㄈ",
    "ㄉ",
    "ㄊ",
    "ㄋ",
    "ㄌ",
    "ㄍ",
    "ㄎ",
    "ㄏ",
    "ㄐ",
    "ㄑ",
    "ㄒ",
    "ㄓ",
    "ㄔ",
    "ㄕ",
    "ㄖ",
    "ㄗ",
    "ㄘ",
    "ㄙ",
    "ㄚ",
    "ㄛ",
    "ㄜ",
    "ㄝ",
    "ㄞ",
    "ㄟ",
    "ㄠ",
    "ㄡ",
    "ㄢ",
    "ㄣ",
    "ㄤ",
    "ㄥ",
    "ㄦ",
    "ㄧ",
    "ㄨ",
    "ㄩ",
    "˙",
    "ˊ",
    "ˇ",
    "ˋ",
  ],

  math: [
    "╳",
    "＋",
    "﹢",
    "－",
    "×",
    "÷",
    "＝",
    "≠",
    "≒",
    "∞",
    "ˇ",
    "±",
    "√",
    "⊥",
    "∠",
    "∟",
    "⊿",
    "㏒",
    "㏑",
    "∫",
    "∮",
    "∵",
    "∴",
    "≦",
    "≧",
    "∩",
    "∪",
  ],

  hiragana: [
    "あ",
    "い",
    "う",
    "え",
    "お",
    "か",
    "き",
    "く",
    "け",
    "こ",
    "さ",
    "し",
    "す",
    "せ",
    "そ",
    "た",
    "ち",
    "つ",
    "て",
    "と",
    "な",
    "に",
    "ぬ",
    "ね",
    "の",
    "は",
    "ひ",
    "ふ",
    "へ",
    "ほ",
    "ま",
    "み",
    "む",
    "め",
    "も",
    "ら",
    "り",
    "る",
    "れ",
    "ろ",
    "が",
    "ぎ",
    "ぐ",
    "げ",
    "ご",
    "ざ",
    "じ",
    "ず",
    "ぜ",
    "ぞ",
    "だ",
    "ぢ",
    "づ",
    "で",
    "ど",
    "ば",
    "び",
    "ぶ",
    "べ",
    "ぼ",
    "ぱ",
    "ぴ",
    "ぷ",
    "ぺ",
    "ぽ",
    "や",
    "ゆ",
    "よ",
    "わ",
    "ん",
    "を",
  ],

  katakana: [
    "ア",
    "イ",
    "ウ",
    "エ",
    "オ",
    "カ",
    "キ",
    "ク",
    "ケ",
    "コ",
    "サ",
    "シ",
    "ス",
    "セ",
    "ソ",
    "タ",
    "チ",
    "ツ",
    "テ",
    "ト",
    "ナ",
    "ニ",
    "ヌ",
    "ネ",
    "ノ",
    "ハ",
    "ヒ",
    "フ",
    "ヘ",
    "ホ",
    "マ",
    "ミ",
    "ム",
    "メ",
    "モ",
    "ラ",
    "リ",
    "ル",
    "レ",
    "ロ",
    "ガ",
    "ギ",
    "グ",
    "ゲ",
    "ゴ",
    "ザ",
    "ジ",
    "ズ",
    "ゼ",
    "ゾ",
    "ダ",
    "ジ",
    "ズ",
    "デ",
    "ド",
    "バ",
    "ビ",
    "ブ",
    "ベ",
    "ボ",
    "パ",
    "ピ",
    "プ",
    "ペ",
    "ポ",
    "ヤ",
    "ユ",
    "ヨ",
    "ワ",
    "ン",
    "ヲ",
  ],
};

const EMOTICONS = {
  angry: [
    "(ノ ゜Д゜)ノ ︵ ═╩════╩═",
    "╯-____-)╯~═╩════╩═~",
    "(╭∩╮\\_/╭∩╮)",
    "( ︶︿︶)_╭∩╮",
    "( ‵□′)───C＜─___-)|||",
    "(￣ε(#￣) #○=(一-一o)",
    "(o一-一)=○# (￣#)3￣)",
    "╰(‵皿′＊)╯",
    "○(#‵︿′ㄨ)○",
    "◢▆▅▄▃-崩╰(〒皿〒)╯潰-▃▄▅▆◣",
  ],

  meh: [
    "(σ′▽‵)′▽‵)σ 哈哈哈哈～你看看你",
    "( ￣ c￣)y▂ξ",
    "( ′-`)y-～",
    "′_>‵",
    "╮(′～‵〞)╭",
    '╮(﹀_﹀")╭',
    "︿(￣︶￣)︿",
    "..╮(﹋﹏﹌)╭..",
    "╮(╯_╰)╭",
    "╮(╯▽╰)/",
  ],

  sweat: [
    "(－^－)ｄ",
    "(￣￣；)",
    "(￣□￣|||)a",
    "(●；－_－)●",
    "￣▽￣||",
    "╭ ﹀◇﹀〣",
    "ˋ(′_‵||)ˊ",
    "●( ¯▽¯；●",
    "o(＞＜；)o o",
  ],

  happy: [
    "~(￣▽￣)~(＿△＿)~(￣▽￣)~(＿△＿)~(￣▽￣)~",
    "(~^O^~)",
    "(∩_∩)",
    "<(￣︶￣)>",
    "v(￣︶￣)y",
    "﹨(╯▽╰)∕",
    "\\(@^0^@)/",
    "\\(^▽^)/",
    "\\⊙▽⊙/",
  ],

  other: [
    "(．＿．?)",
    "(？o？)",
    "(‧Q‧)",
    "〒△〒",
    "m川@.川m",
    "(¯(∞)¯)",
    "(⊙o⊙)",
    "(≧<>≦)",
    "(☆_☆)",
    'o(‧"‧)o',
  ],
};

function sendColorCommand({ fg, bg, isBlink }, onCmdSend, type) {
  let lightColor = "0;";
  if (fg > 7) {
    fg %= 8;
    lightColor = "1;";
  }
  fg += 30;
  bg += 40;
  let blink = "";
  if (isBlink) {
    blink = "5;";
  }
  let cmd = "\x15[";
  if (type == "foreground") {
    cmd += lightColor + blink + fg + "m";
  } else if (type == "background") {
    cmd += bg + "m";
  } else {
    cmd += lightColor + blink + fg + ";" + bg + "m";
  }
  onCmdSend(cmd);
}

export const InputHelperModal = ({
  show,
  onReset,
  onHide,
  onCmdSend,
  onConvSend,
}) => {
  const [fg, setFg] = useState(7);
  const [bg, setBg] = useState(0);
  const [isBlink, setIsBlink] = useState(false);
  // Active tab key: "colors" | `symbols.${group}` | `emoticons.${group}`.
  // Symbol/emoticon groups are picked from the dropdown menus in the tab bar.
  const [tab, setTab] = useState("colors");

  const onColorClick = useCallback(
    ({
      target: {
        dataset: { fg },
      },
    }) => {
      setFg(parseInt(fg, 10));
    },
    [],
  );
  const onColorContextMenu = useCallback((event) => {
    const {
      target: { dataset },
    } = event;
    event.preventDefault();
    event.stopPropagation();
    if ("bg" in dataset) {
      setBg(parseInt(dataset.bg, 10));
    }
  }, []);
  const onBlinkChange = useCallback(({ target: { checked } }) => {
    setIsBlink(checked);
  }, []);
  const onSendClick = useCallback(
    () => sendColorCommand({ fg, bg, isBlink }, onCmdSend),
    [fg, bg, isBlink, onCmdSend],
  );
  const onSendSelect = useCallback(
    (eventKey) => sendColorCommand({ fg, bg, isBlink }, onCmdSend, eventKey),
    [fg, bg, isBlink, onCmdSend],
  );
  const onSymEmoClick = useCallback(
    ({ target: { textContent } }) => onConvSend(textContent),
    [onConvSend],
  );

  // 拖曳：位置存 state（React 控制 inline top/left → re-render 不會跑位），只從
  // 標題列拖動。pointerdown 後掛 window 監聽追蹤位移，pointerup 卸載。
  const [pos, setPos] = useState({ top: 80, left: 360 });
  const dragRef = useRef(null);
  const onHeaderPointerDown = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, y: e.clientY };
    const onMove = (ev) => {
      window.getSelection().removeAllRanges();
      setPos((p) => ({
        top: p.top + (ev.clientY - dragRef.current.y),
        left: p.left + (ev.clientX - dragRef.current.x),
      }));
      dragRef.current = { x: ev.clientX, y: ev.clientY };
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  if (!show) return null;

  return (
    <Paper
      shadow="md"
      withBorder
      className="InputHelperModal__Dialog"
      style={{ top: pos.top, left: pos.left }}
    >
      <Group
        justify="space-between"
        className="InputHelperModal__Header"
        px="sm"
        py={4}
        onPointerDown={onHeaderPointerDown}
      >
        <Text fw={600}>{i18n("inputHelperTitle")}</Text>
        <CloseButton onClick={onHide} />
      </Group>
      <div className="InputHelperModal__Content">
        <Tabs value={tab} onChange={setTab}>
          <Tabs.List>
            <Tabs.Tab value="colors">{i18n("colorTitle")}</Tabs.Tab>
            <Menu trigger="click-hover" position="bottom-start" zIndex={3000}>
              <Menu.Target>
                <Button variant="subtle" size="compact-sm">
                  {i18n("symTitle")}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {Object.keys(SYMBOLS).map((group) => (
                  <Menu.Item
                    key={group}
                    onClick={() => setTab(`symbols.${group}`)}
                  >
                    {i18n(`symTitle_${group}`)}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Menu trigger="click-hover" position="bottom-start" zIndex={3000}>
              <Menu.Target>
                <Button variant="subtle" size="compact-sm">
                  {i18n("emoTitle")}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {Object.keys(EMOTICONS).map((group) => (
                  <Menu.Item
                    key={group}
                    onClick={() => setTab(`emoticons.${group}`)}
                  >
                    {i18n(`emoTitle_${group}`)}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Tabs.List>
          <Tabs.Panel value="colors">
            <ul className="InputHelperModal__ColorList">
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b0"
                data-fg="0"
                data-bg="0"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b1"
                data-fg="1"
                data-bg="1"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b2"
                data-fg="2"
                data-bg="2"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b3"
                data-fg="3"
                data-bg="3"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b4"
                data-fg="4"
                data-bg="4"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b5"
                data-fg="5"
                data-bg="5"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b6"
                data-fg="6"
                data-bg="6"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b7"
                data-fg="7"
                data-bg="7"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b8"
                data-fg="8"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b9"
                data-fg="9"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b10"
                data-fg="10"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b11"
                data-fg="11"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b12"
                data-fg="12"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b13"
                data-fg="13"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b14"
                data-fg="14"
              />
              <li
                onClick={onColorClick}
                onContextMenu={onColorContextMenu}
                className="b15"
                data-fg="15"
              />
            </ul>
            <Text size="sm" mt="xs">
              {i18n("colorHelperTooltip1")}
              <br />
              {i18n("colorHelperTooltip2")}
            </Text>
            <div className="InputHelperModal__Preview">
              <ColorSpan
                className="InputHelperModal__Preview__Content"
                colorState={{
                  fg,
                  bg,
                  blink: isBlink,
                }}
                inner={i18n("colorHelperPreview")}
              />
            </div>
            <Group justify="space-between" mt="xs">
              <Checkbox
                checked={isBlink}
                onChange={onBlinkChange}
                label={i18n("colorHelperBlink")}
              />
              <Button.Group>
                <Button variant="default" onClick={onSendClick}>
                  {i18n("colorHelperSend")}
                </Button>
                <Menu position="bottom-end" zIndex={3000}>
                  <Menu.Target>
                    <Button variant="default" px="xs">
                      ▾
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => onSendSelect("foreground")}>
                      {i18n("colorHelperSendMenuFore")}
                    </Menu.Item>
                    <Menu.Item onClick={() => onSendSelect("background")}>
                      {i18n("colorHelperSendMenuBack")}
                    </Menu.Item>
                    <Menu.Divider />
                    <Menu.Item onClick={() => onReset()}>
                      {i18n("colorHelperSendMenuReset")}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Button.Group>
            </Group>
          </Tabs.Panel>
          {Object.keys(SYMBOLS).map((group) => (
            <Tabs.Panel key={group} value={`symbols.${group}`}>
              <ul className="InputHelperModal__SymbolList">
                {SYMBOLS[group].map((it, index) => (
                  <li key={index} onClick={onSymEmoClick}>
                    {it}
                  </li>
                ))}
              </ul>
            </Tabs.Panel>
          ))}
          {Object.keys(EMOTICONS).map((group) => (
            <Tabs.Panel key={group} value={`emoticons.${group}`}>
              <ul className="InputHelperModal__EmoticonList">
                {EMOTICONS[group].map((it, index) => (
                  <li key={index} onClick={onSymEmoClick}>
                    {it}
                  </li>
                ))}
              </ul>
            </Tabs.Panel>
          ))}
        </Tabs>
      </div>
    </Paper>
  );
};

export default InputHelperModal;
