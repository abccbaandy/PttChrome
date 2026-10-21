// 水球收件匣「回覆」最新一位以外的寄件人（docs/message-inbox.md「回覆」）。
//
// 第一下 ^R 在兩種水球模式都指向最新一位寄件人；要回別人得在 PTT 原生的回覆畫面裡換人。
// 兩種模式換人都是「再按 ^R」（讀碼 mbbsd/wmsg.c）：
//   - 一對一模式（UF_PAGER_OFO，ofo_my_write）：row 0 是 `丟<id>:` 輸入列，row 1 起是
//     「↑反擊對象↓」名單（最多 WB_OFO_USER_NUM=5 人）；^R／↓ 換下一位（ofo_switch_user(1)），
//     row 0 跟著改成新的對象。
//   - 一般模式（wmsg_handle_ctrl_r_default）：第一下 row 0 是 `訊息傳過去: `；第二下起在 row 1
//     畫「訊息回顧」面板（wmsg_show_panel_new），row 3 起是最近 MAX_REVIEW=7 則水球，選中那則
//     行首是 `>`＋寄件人；每按一下 ^R 往舊的選一則，送出時對象就是選中那則的寄件人
//     （my_write_get_input 的 watermode > 0 分支）。
// 每按一下都等畫面停下來、認出是哪一種、讀出目前選中的人，對上了就停手交給使用者打字。
// **認不出 ⇒ 停手**：不再送任何鍵，使用者留在 PTT 原生的回覆畫面（可以自己換人或 ← 取消），
// 不會被多送的鍵帶去別處。回覆畫面是 scr_dump／scr_restore 包起來的，回完原畫面原樣回來
// ⇒ 不經閱讀紀錄（同第一下 ^R）。

// wmsg.c#PROMPT_OFO "丟%s:"；PROMPT_TO "訊息傳過去: "。
const OFO_PROMPT_RE = /^丟(\S+?):/;
const DEFAULT_PROMPT = '訊息傳過去: ';
// ofo_init_screen 的名單標題（WB_OFO_USER_TOP=1）。
const OFO_LIST_MARK = '↑反擊對象↓';
// wmsg_show_panel_new 的 row 1；新舊字樣都只認這段（MSG_SEPARATOR 夾字的部分）。
const PANEL_MARK = '訊─息─回─顧';
const PANEL_FIRST_ROW = 3;
// 一對一模式名單最多 5 人、一般模式回顧最多 7 則；多給一輪就收手。
export const MAX_SWITCH_STEPS = 8;
export const STEP_TIMEOUT_MS = 3000;

// 認畫面。rows＝整頁每列文字。回傳：
//   { mode: 'ofo', selected: id }
//   { mode: 'default', selected: null }      第一下（還沒有回顧面板）
//   { mode: 'default', selected: id|null }   回顧面板（selected＝行首 `>` 那則的寄件人）
//   null                                      認不出
export function classifyReplyScreen(rows) {
  const r0 = (rows && rows[0]) || '';
  const r1 = (rows && rows[1]) || '';
  const ofo = OFO_PROMPT_RE.exec(r0);
  if (ofo && r1.indexOf(OFO_LIST_MARK) >= 0) return { mode: 'ofo', selected: ofo[1], panel: false };
  if (r0.indexOf(DEFAULT_PROMPT) !== 0) return null;
  if (r1.indexOf(PANEL_MARK) < 0) return { mode: 'default', selected: null, panel: false };
  let selected = null;
  for (let i = PANEL_FIRST_ROW; i < rows.length; i++) {
    const m = /^>(\S+) /.exec(rows[i] || '');
    if (m) {
      if (selected) return null; // 兩列都像選中 ⇒ 不是我們認得的面板
      selected = m[1];
    }
  }
  return selected ? { mode: 'default', selected, panel: true } : null;
}

// 下一步。screen＝classifyReplyScreen 的結果。回傳 'done'（對上了，交給使用者）、
// 'next'（再按一下 ^R）、'stop'（換一輪還找不到，停手）、'wait'（認不出 ⇒ 不送鍵，等下一次
// 畫面停下；一直認不出就由逾時收手）。認不出不立刻收手：按下第一下時好讀切原生鏡像會先停
// 一次舊畫面，那不是 PTT 的回應。
export function nextReplyStep(screen, target, latest, steps) {
  if (!screen) return 'wait';
  if (screen.mode === 'ofo' || screen.panel) {
    if (screen.selected === target) return 'done';
  } else if (target === latest) {
    // 一般模式第一下：對象就是最新一位寄件人。
    return 'done';
  }
  return steps < MAX_SWITCH_STEPS ? 'next' : 'stop';
}

// 一趟回覆。core 要有 buf（screenSettled／getRowText／rows）與 view.sendKeyAsUser。
// onEnd(outcome) 收 'done'／'stop'／'timeout'（認不出的畫面一直沒換掉）／'cancel'。回傳 cancel 函式。
export function startWaterballReply(core, target, latest, opts) {
  const buf = core.buf;
  const view = core.view;
  const setTimer = (opts && opts.setTimeout) || setTimeout;
  const clearTimer = (opts && opts.clearTimeout) || clearTimeout;
  const onEnd = (opts && opts.onEnd) || function() {};
  let steps = 0;
  let timer = null;
  let ended = false;

  const finish = (outcome) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimer(timer);
    buf.removeEventListener('screenSettled', onSettled);
    onEnd(outcome);
  };
  const press = () => {
    if (timer) clearTimer(timer);
    timer = setTimer(() => finish('timeout'), STEP_TIMEOUT_MS);
    view.sendKeyAsUser('r', { ctrlKey: true });
  };
  function onSettled() {
    const rows = [];
    for (let i = 0; i < buf.rows; i++) rows.push(buf.getRowText(i));
    const step = nextReplyStep(classifyReplyScreen(rows), target, latest, steps);
    if (step === 'wait') return;
    if (step === 'next') {
      steps++;
      press();
    } else {
      finish(step);
    }
  }

  buf.addEventListener('screenSettled', onSettled);
  press();
  return () => finish('cancel');
}
