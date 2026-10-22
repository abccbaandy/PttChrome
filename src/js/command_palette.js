// 指令面板（快捷鍵預設 F4，pref enableCommandPalette／commandPaletteKey）的純邏輯：
// 輸入一串字 → 這一刻能做的事。無 DOM、無網路；React 外殼在
// components/ContextMenu/CommandPalette.jsx，執行在 ContextMenu/index.jsx#runPaletteItem。
//
// 面板本身**不發明任何新的 PTT 操作**：每一項都接到既有入口（deep link 跳文、搜尋
// 彈窗的送出、重新整理、跳到未讀、設為全部已讀、複製本篇連結、返回原文、設定搜尋），
// 送鍵、閱讀紀錄、認不出就不動的規則全由那些入口自己負責。這裡只決定「列出哪些」：
//   - 能不能用由呼叫端在開面板當下量好放進 ctx（與右鍵選單／手機工具列同一組判準），
//     不能用的直接不列，不列出來再失敗。
//   - 快捷鍵用 F 鍵：F 鍵在 term_keyboard 沒有對應，永遠送不到 PTT。Ctrl+K 不行 ——
//     pttbbs 的編輯器（edit.c 刪至行尾）、輸入欄（vtuikit.c）、pager（more.c）都在用。
import { parseDeepLink } from "./deep_link";
import { BOARD_RE, isAidc, parseArticleUrl } from "./aid_codec";
import { searchPrefSettings } from "./pref_search";

// 面板一次最多列幾筆設定項（設定搜尋只是其中一類，不該把指令擠出畫面）。
export const PALETTE_SETTING_LIMIT = 4;

// 最近去過／我的最愛的看板（pref paletteQuickBoards）：空白時最多列幾個、打字時最多幾個。
export const PALETTE_QUICK_BOARD_LIMIT = 12;
export const PALETTE_QUICK_MATCH_LIMIT = 5;

// 最近去過的看板與我的最愛 → 「前往看板」項目（kind 'board'，執行跟打板名同一條路）。
// 資料是首頁儀表板現成的（最近看板、我的最愛快取），面板一個 byte 都不多送。
// 最近的在前、最愛在後，不分大小寫去重；q 非空 ⇒ 只留板名以 q 開頭的。
export function quickBoardItems(q, quick, limit) {
  const src = quick || {};
  const seen = new Set();
  const out = [];
  const add = (name, source, desc) => {
    const n = String(name || "");
    if (!n || !BOARD_RE.test(n)) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (q && key.indexOf(q) !== 0) return;
    if (out.length >= limit) return;
    out.push({ id: "quick:" + key, kind: "board", text: n, source, desc: desc || "" });
  };
  (src.recent || []).forEach((n) => add(n, "recent"));
  (src.favorites || []).forEach((b) => b && add(b.name, "favorite", b.desc));
  return out;
}

// 動作：id ＝ 執行端的分派鍵；when ＝ ctx 的哪個旗標為真才列；keywords 兩語系都放
// （面板以目前語系顯示，但打另一種語言也找得到）。
export const PALETTE_ACTIONS = [
  { id: "refresh", titleKey: "palette_refresh", when: "refresh", keywords: ["重新整理", "重整", "更新", "refresh", "reload", "f5"] },
  { id: "unreadJump", titleKey: "palette_unreadJump", when: "unreadJump", keywords: ["跳到第一篇未讀", "未讀", "unread", "first unread"] },
  { id: "markAllRead", titleKey: "palette_markAllRead", when: "markAllRead", keywords: ["設為全部已讀", "全部已讀", "已讀", "mark all read", "read"] },
  { id: "copyLink", titleKey: "palette_copyLink", when: "copyLink", keywords: ["複製本篇連結", "複製連結", "分享", "copy link", "share", "url"] },
  { id: "back", titleKey: "palette_back", when: "back", keywords: ["返回原文", "返回", "上一篇", "back", "return"] },
  { id: "settings", titleKey: "palette_settings", when: null, keywords: ["設定", "偏好", "settings", "preferences", "options"] },
  { id: "safeModeOn", titleKey: "palette_safeModeOn", when: "safeModeOff", keywords: ["安全模式", "全部用原生", "原生", "safe mode", "native"] },
  { id: "safeModeOff", titleKey: "palette_safeModeOff", when: "safeModeOn", keywords: ["安全模式", "關閉安全模式", "safe mode", "native"] },
];

const norm = (s) => String(s || "").trim().toLowerCase();

// 文章：ptt.cc 網址、本站 deep link、或 PTT 自己顯示 AID 的寫法
// 「#1abcDEFG (Gossiping)」（文章資訊框 Q 的那一行）與「Gossiping #1abcDEFG」。
// 沒寫看板的 #AID 不收：面板外的畫面沒有可靠的「目前看板」可以補。
const AID_WITH_BOARD_RE = /^#([0-9A-Za-z_-]{8})\s*[(（]?\s*([0-9A-Za-z_.-]+)\s*[)）]?$/;
// 空白隔開時 # 必填：「ABC 12345678」更可能是要搜的標題。
const BOARD_WITH_AID_RE = /^([0-9A-Za-z_.-]+)(?:\/#?|\s+#)([0-9A-Za-z_-]{8})$/;

export function parseArticleTarget(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return parseArticleUrl(s) || parseDeepLink(s);
  const pick = (aid, board) =>
    isAidc(aid) && BOARD_RE.test(board) ? { board, aid } : null;
  let m = AID_WITH_BOARD_RE.exec(s);
  if (m) return pick(m[1], m[2]);
  m = BOARD_WITH_AID_RE.exec(s);
  if (m) return pick(m[2], m[1]);
  return null;
}

// 2 ＝標題或某個關鍵字以 q 開頭（排在搜尋前面：打「未讀」「refresh」就是要那個動作），
// 1 ＝只是中間含 q（排在搜尋後面），0 ＝不符。空輸入一律 2。
function actionMatch(action, q, title) {
  if (!q) return 2;
  const words = [norm(title)].concat(action.keywords.map((k) => k.toLowerCase()));
  if (words.some((w) => w.indexOf(q) === 0)) return 2;
  return words.some((w) => w.indexOf(q) > 0) ? 1 : 0;
}

/**
 * @param {string} query 使用者輸入
 * @param {object} ctx 開面板當下量好的事實：
 *   searchKinds: string[]（article_search.availableSearchKinds）
 *   refresh / unreadJump / markAllRead / copyLink / back: boolean
 *   safeMode: boolean（目前安全模式開著嗎）
 *   title(key): string —— 動作標題（i18n；比對用，可省）
 *   lang: 設定搜尋用的語系（可省）
 *   quickBoards: { recent: string[], favorites: {name, desc}[] } | null（可省）
 * @returns {Array<{id, kind, ...}>} 依顯示順序。kind ∈ article｜board｜search｜action｜setting
 */
export function buildPaletteItems(query, ctx) {
  const c = ctx || {};
  const raw = String(query || "").trim();
  const q = norm(raw);
  const kinds = c.searchKinds || [];
  const out = [];

  const target = parseArticleTarget(raw);
  if (target) out.push({ id: "article", kind: "article", target });

  // 最近／最愛的看板排在動作前面：空白時 F4 → ↓ → Enter 就回到剛剛的板。
  const quick =
    !target && c.quickBoards && kinds.indexOf("board") >= 0
      ? quickBoardItems(
          q,
          c.quickBoards,
          q ? PALETTE_QUICK_MATCH_LIMIT : PALETTE_QUICK_BOARD_LIMIT,
        )
      : [];
  out.push(...quick);

  const flags = {
    refresh: !!c.refresh,
    unreadJump: !!c.unreadJump,
    markAllRead: !!c.markAllRead,
    copyLink: !!c.copyLink,
    back: !!c.back,
    safeModeOn: !!c.safeMode,
    safeModeOff: !c.safeMode,
  };
  const title = typeof c.title === "function" ? c.title : () => "";
  const strong = [];
  const weak = [];
  for (const a of PALETTE_ACTIONS) {
    if (a.when && !flags[a.when]) continue;
    const m = actionMatch(a, q, title(a.titleKey));
    if (!m) continue;
    const it = { id: "action:" + a.id, kind: "action", action: a.id, titleKey: a.titleKey };
    (m === 2 ? strong : weak).push(it);
  }
  out.push(...strong);

  if (!target && raw) {
    if (
      kinds.indexOf("board") >= 0 &&
      BOARD_RE.test(raw) &&
      !quick.some((it) => it.text.toLowerCase() === q)
    )
      out.push({ id: "board", kind: "board", text: raw });
    if (kinds.indexOf("title") >= 0)
      out.push({ id: "search:title", kind: "search", searchKind: "title", text: raw });
    if (kinds.indexOf("author") >= 0 && /^[0-9A-Za-z]+$/.test(raw))
      out.push({ id: "search:author", kind: "search", searchKind: "author", text: raw });
    if (kinds.indexOf("push") >= 0 && /^-?\d+$/.test(raw))
      out.push({ id: "search:push", kind: "search", searchKind: "push", text: raw });
  }

  out.push(...weak);

  if (q && !target) {
    const hits = searchPrefSettings(raw, {
      lang: c.lang,
      limit: PALETTE_SETTING_LIMIT,
    });
    for (const h of hits)
      out.push({
        id: "setting:" + h.key,
        kind: "setting",
        settingKey: h.key,
        tab: h.tab,
        title: h.title,
        tabLabel: h.tabLabel,
        sectionLabel: h.sectionLabel,
      });
  }
  return out;
}

// 選取游標上下移動（循環）。count 0 ⇒ -1。
export function movePaletteIndex(index, delta, count) {
  if (!count) return -1;
  const i = index < 0 ? (delta > 0 ? -1 : 0) : index;
  return (i + delta + count) % count;
}
