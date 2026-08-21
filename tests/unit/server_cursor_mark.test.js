// 閃爍底線抑制（autoHideBlinkCursor）：PTT 自己畫了游標的畫面不再疊一個閃爍 `_`。
//
// 判定依據是 pttbbs 的不變量（`mbbsd/stuff.c#cursor_show`）：
//     move(row, column); outs(STR_CURSOR); move(row, column);
// 印完游標記號後把終端機游標移回**同一格**，所以「cur_x/cur_y 那格就是游標記號」
// ⇔「PTT 已經自己畫了游標」。輸入框／編輯器不走 cursor_show，該格是內容或空白。
//
// 兩代游標都要認（見 comment_parse.js 的 LIST_CURSOR 說明區塊）：
//   新 STR_CURSOR ">"  半形，1 cell
//   舊 STR_CURSOR2 "●" 全形，DBCS pair（cell 存單一 Big5 byte）—— offline e2e 的
//   cassette 是舊 server 錄的，是 CI gate。

import { hasServerCursorMark } from "../../src/js/comment_parse";
import { TermView } from "../../src/js/term_view";
import { u2b } from "../../src/js/string_util";
import { loadBig5Tables } from "./helpers/load_big5_tables";

loadBig5Tables();

function cell(ch, isLeadByte = false) {
  return { ch, isLeadByte };
}

// ASCII 一列：每個字元一格。
function row(text) {
  return text.split("").map(c => cell(c));
}

// 舊全形 ● 佔 [0,1]：lead byte + trail byte，其餘 ASCII 補滿。
function rowWithOldCursor(rest) {
  const b5 = u2b("●");
  return [cell(b5[0], true), cell(b5[1], false), ...row(rest)];
}

describe("hasServerCursorMark", () => {
  test("半形 '>' 就在游標那一格 → true", () => {
    // "> 350024 + ..." 的列首，游標停在 col 0
    expect(hasServerCursorMark(row("> 350024 a0930307"), 0)).toBe(true);
  });

  test("'>' 在游標的前一格（使用者在輸入框打了 '>'）→ false", () => {
    // 打字時游標停在字元「後面」那一格，不是字元本身那一格
    expect(hasServerCursorMark(row(">  "), 1)).toBe(false);
  });

  test("'>' 在游標的後一格 → false", () => {
    expect(hasServerCursorMark(row(" > "), 0)).toBe(false);
  });

  test("舊全形 ● 就在游標那一格 → true", () => {
    expect(hasServerCursorMark(rowWithOldCursor("350024 a0930307"), 0)).toBe(
      true
    );
  });

  test("舊全形 ● 的第二個 byte 不算（游標不會停在 trail byte）", () => {
    expect(hasServerCursorMark(rowWithOldCursor("350024"), 1)).toBe(false);
  });

  test("其他全形字（釘選列的 ★）不算游標", () => {
    const b5 = u2b("★");
    const line = [cell(b5[0], true), cell(b5[1], false), ...row("公告")];
    expect(hasServerCursorMark(line, 0)).toBe(false);
  });

  test("空白格 / 空列 / 越界 → false", () => {
    expect(hasServerCursorMark(row("   "), 1)).toBe(false);
    expect(hasServerCursorMark([], 0)).toBe(false);
    expect(hasServerCursorMark(null, 0)).toBe(false);
    expect(hasServerCursorMark(row("> "), 5)).toBe(false);
    expect(hasServerCursorMark(row("> "), -1)).toBe(false);
  });
});

// refreshCursorVisibility 的來源合併。#cursor 的顯示由三個**獨立**來源決定：
//   _cursorHidden     列表好讀模式（list_session hideCursor/showCursor）
//   _cursorSuppressed 本功能
//   !_gridRender      這一幀的 `.main` 裝的不是固定格線畫面（好讀累積長頁）
// 用 OR 合併於 _applyCursorVisibility —— 共用一個旗標會讓 showCursor() 誤清抑制狀態。
describe("TermView.refreshCursorVisibility", () => {
  function view({ autoHide = true, hidden = false, line, curX = 0, gridRender = true } = {}) {
    return {
      bbsCursor: { style: {} },
      autoHideBlinkCursor: autoHide,
      _cursorHidden: hidden,
      _cursorSuppressed: false,
      _gridRender: gridRender,
      buf: { lines: [line], cur_x: curX, cur_y: 0 },
      _applyCursorVisibility: TermView.prototype._applyCursorVisibility,
      refreshCursorVisibility: TermView.prototype.refreshCursorVisibility,
    };
  }

  test("設定開 + PTT 有畫游標 → 隱藏", () => {
    const v = view({ line: row("> 350024") });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
  });

  test("設定開 + PTT 沒畫游標（輸入框）→ 照舊閃爍", () => {
    // 輸入框：游標停在已打字元的後一格（空白）
    const v = view({ line: row("guest      "), curX: 5 });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("");
  });

  test("設定關 → 即使 PTT 有畫游標也照舊閃爍", () => {
    const v = view({ autoHide: false, line: row("> 350024") });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("");
  });

  test("列表好讀的 hideCursor 優先：沒有 PTT 游標也維持隱藏", () => {
    const v = view({ hidden: true, line: row("   350024") });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
  });

  test("showCursor 不會被本功能的抑制狀態干擾（反之亦然）", () => {
    const v = view({ hidden: true, line: row("> 350024") });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
    // 列表好讀退出 → _cursorHidden 解除，但 PTT 游標還在 → 仍該隱藏
    v._cursorHidden = false;
    v._applyCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
  });

  // 好讀累積長頁：畫面第 N 列與格線第 N 列毫無關係，`buf.cur_y` 指不到任何一列，
  // 游標畫在哪裡都是錯的（舊實作把它畫在視窗的 cur_y 列 → 飄在任意內文上）。
  // 文章內的輸入一律走 functionMode 原生鏡像（＝格線幀），所以隱藏不影響打字。
  test("非格線幀（好讀累積長頁）→ 隱藏，即使 PTT 沒畫游標", () => {
    const v = view({ gridRender: false, line: row("guest      "), curX: 5 });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
  });

  test("回到格線幀 → 顯示權交還給閃爍機制", () => {
    const v = view({ gridRender: false, line: row("guest      "), curX: 5 });
    v.refreshCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
    v._gridRender = true;
    v._applyCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("");
  });

  test("非格線幀的隱藏與另外兩個來源互不干擾", () => {
    // 列表好讀退出（_cursorHidden 解除）不該讓長頁幀的游標冒出來
    const v = view({ gridRender: false, hidden: true, line: row("   350024") });
    v.refreshCursorVisibility();
    v._cursorHidden = false;
    v._applyCursorVisibility();
    expect(v.bbsCursor.style.display).toBe("none");
  });

  test("buf 尚未接上（連線前）不炸", () => {
    const v = view({ line: row("> ") });
    v.buf = null;
    expect(() => v.refreshCursorVisibility()).not.toThrow();
    expect(v.bbsCursor.style.display).toBe("");
  });
});
