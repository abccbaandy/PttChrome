// 原生文章列表（列表好讀關掉、或暫時切到原生鏡像）的右鍵／長按「稍後再讀」。
//
// 列表好讀那一份在 list_session.readLaterAt（P53）：真游標同步到那一列 → `Q` 讀 AID →
// 空白關框。原生格線沒有那套游標同步，這裡自己走同一組 PTT 協定：
//   1. 右鍵的那一列不是游標列 ⇒ `<編號>⏎` 把游標移過去（read.c 的「跳至第幾項」；同一頁，
//      不會翻頁），落地要求游標列＝那個編號**而且**標題跟右鍵時看到的一樣（編號當身分不夠，
//      judgment review #237：畫面在選單開著時換掉，同一個編號可能是另一篇）。
//   2. `Q`（bbs.c#view_postinfo 資訊框）：認出框（postInfoAnswer）才算數；框沒出現 ⇒ 不送空白
//      （列表上的空白是翻頁）。
//   3. 空白關框：回到乾淨的列表（框不在了）才把答案交出去。
// 置底文沒有編號、跳不過去 ⇒ 只有在它剛好就是游標列時給（直接從第 2 步開始）。
// 刪除文／鎖文／被黑名單擋掉的列不給（list_row_filter：使用者看到的是提示列，不是那篇）。
// 結束後 PTT 游標停在右鍵的那一列（同一頁、畫面不捲），跟點了那一列一樣。
//
// 守護 tests/unit/native_read_later.test.js；docs/recent-articles.md。

import { parseListEntry } from './agent_parse';
import { isHiddenListText, listFilterOf } from './list_row_filter';
import { refreshTargetOf } from './screen_refresh';
import { submitSerializedSteps } from './article_search';
import { numJumpLanded, postInfoAnswer } from './aid_navigation';
import { KEY_DISMISS } from './screen_dismiss';
import { recordFor } from './reading_record';
import { serializedOpHint } from './serialized_op_gate';

export const NATIVE_READ_LATER_FLAG = 'nativeReadLaterInFlight';

// 純判定：這一列能不能在原生列表上「稍後再讀」。
//   in: { rowText, row, cursorRow, rows, filter: { blacklist, titleKeywords } }
//   out: { row, num, title, rowText, onCursor } | null
export function nativeReadLaterTarget(input) {
  const o = input || {};
  const rows = o.rows || 24;
  // 條目區：表頭三列與底列不算（read.c 的列表從第 3 列畫到 b_lines-1）。
  if (typeof o.row !== 'number' || o.row < 3 || o.row > rows - 2) return null;
  const text = String(o.rowText == null ? '' : o.rowText);
  const entry = parseListEntry(text);
  if (!entry || entry.deleted || entry.locked) return null;
  const f = o.filter || {};
  if (isHiddenListText(text, f.blacklist, f.titleKeywords)) return null;
  const onCursor = o.row === o.cursorRow;
  if (!onCursor && entry.num == null) return null;
  return { row: o.row, num: entry.num, title: entry.title, rowText: text, onCursor: onCursor };
}

// 這一幀、這一列能不能用。列表好讀正在畫列表（activeListSession 有主）時不給：那條走
// list_session.readLaterAt，滑鼠列號也是好讀視窗的列號，不是 buf 的列。
export function nativeReadLaterTargetAt(core, row) {
  if (!core || !core.buf || !core.conn || !core.conn.isConnected) return null;
  if (typeof core.activeListSession === 'function' && core.activeListSession()) return null;
  const t = refreshTargetOf(core);
  if (!t || t.kind !== 'article-list') return null;
  const buf = core.buf;
  return nativeReadLaterTarget({
    rowText: buf.getRowText(row),
    row: row,
    cursorRow: buf.cur_y,
    rows: buf.rows,
    filter: listFilterOf(core.view)
  });
}

// 送出。onAnswer({ aid, board } | null) 只在框關掉、回到列表之後才叫；onFail() ＝送出去了
// 但某一步沒等到該有的畫面（停在原生畫面）。回 false ＝沒送（畫面在選單開著時變了、
// 線路被別的交易佔住、PTT 正開著 prompt）；呼叫端負責提示。
export function readLaterNative(core, target, onAnswer, onFail) {
  if (!core || !core.buf || !target) return false;
  if (serializedOpHint(core)) return false;
  // 選單開著期間畫面可能已經換了：那一列的字（含游標標記）要跟右鍵時一模一樣才送。
  if (core.buf.getRowText(target.row) !== target.rowText) return false;
  if (target.onCursor && core.buf.cur_y !== target.row) return false;

  const rr = recordFor(core);
  const bm = rr.begin('read-later-list');
  let answer = null;
  let ended = false;
  const end = function(outcome) {
    if (ended) return;
    ended = true;
    rr.end(bm, outcome);
  };
  const fail = function() {
    if (ended) return;
    end('fail');
    if (onFail) onFail();
  };
  const steps = [];
  if (!target.onCursor) {
    steps.push({
      keys: String(target.num) + '\r',
      kind: 'read-later-native-jump',
      fullRepaint: false,
      expect: function(snap, facts) {
        if (!numJumpLanded(facts, target.num)) return false;
        const e = parseListEntry((facts.rowTexts || [])[facts.curY] || '');
        return !!e && e.num === target.num && e.title === target.title;
      },
      onFail: fail
    });
  }
  steps.push(
    {
      keys: 'Q',
      kind: 'read-later-native-info',
      // 不可以尾附 \f：會被資訊框的 pressanykey 吃掉當成關框（同 list_session.readLaterAt）。
      fullRepaint: false,
      expect: function(snap, facts) {
        const a = postInfoAnswer(facts.rowTexts || [], facts.rows);
        if (!a) return false;
        answer = a.info;
        return true;
      },
      onFail: fail
    },
    {
      keys: KEY_DISMISS,
      kind: 'read-later-native-dismiss',
      fullRepaint: false,
      expect: function(snap, facts) {
        return facts.kind === 'clean-list' && postInfoAnswer(facts.rowTexts || [], facts.rows) === false;
      },
      onFail: fail,
      onDone: function() {
        end('done');
        if (onAnswer) onAnswer(answer);
      }
    }
  );
  if (!submitSerializedSteps(core, steps, { kind: 'read-later', flag: NATIVE_READ_LATER_FLAG })) {
    end('cancel');
    return false;
  }
  return true;
}
