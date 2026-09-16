'use strict';

// 送出端鏡像 PTT 的按鍵解析狀態機（pttbbs `common/sys/vtkbd.c#vtkbd_process`），
// 目的只有一個：**不要把 server 的解析器留在「還在等 ESC 的第二個位元組」的狀態**。
//
// 為什麼需要（2026-09-16 實錄，錄製檔 ptt-debug-20260916-011413.json）：
// 使用者關掉長推文輸入框後多按了一下 Esc ⇒ client 送出一個**裸 ESC**；1.4 秒後
// 他按 ← 想離開文章，畫面卻跳到同主題的上一篇。逐條 CONFIRMED：
//
//  1. `VKSTATE_NORMAL` 收到 ESC → 轉 `VKSTATE_ESC`，回 `KEY_INCOMPLETE`
//     ⇒ 裸 ESC **當下不產生任何按鍵**，只是把 server 留在半途（vtkbd.c:129-133）。
//  2. 停在 `VKSTATE_ESC` 時，下一個位元組若不是 `[` / `O`，就被當成 `esc_arg`
//     吃掉、回一個 `KEY_ESC`，狀態回 NORMAL（vtkbd.c:145-160）。
//  3. 所以 ← 的 `ESC [ D`：開頭那個 ESC 被吃成 esc_arg，`[` 與 `D` 變成**字面鍵**。
//  4. `[` 在 pager ＝ RELATE_PREV（more.c:130-136）、在文章列表也是
//     `thread(locmem, RELATE_PREV)`（read.c:840）＝上一篇同主題文章 ⇒ 「亂跳」。
//
// 換句話說「ESC + 跳脫序列」在 PTT **本來就必定壞掉**，不可能是使用者的本意，
// 所以在這個情況下自動化解不會吃掉任何合法輸入。
//
// **補的是 ESC 而不是 `[`**：新版 vtkbd 的 `VKSTATE_CSI` 收到 ESC 會 restart
// （vtkbd.c:230-235），所以補 `[` 理論上可做到零多餘按鍵；但那條分支是後來才加的，
// 而「`VKSTATE_ESC` + 非 `[`/`O` → KEY_ESC」是最古老、跨版本都成立的那段。補 ESC
// 的代價只是 server 收到一個 `KEY_ESC`(esc_arg=0x1b)，而 `KEY_ESC` 只有 edit.c 會
// 消費，且兩處 `switch (KEY_ESC_arg)` 都**沒有 default**（edit.c:3678、3764-3836）
// ⇒ 0x1b 不命中任何 case，pager／列表／選單／編輯器一律 no-op。保守優先。
//
// 不碰 ESC 組合鍵：ESC-L（跳行）、ESC-<數字>（讀暫存檔）這類的第二個位元組是
// **可列印字元**，不以 ESC 開頭 ⇒ 守門條件天然避開它們。

export const VK_NORMAL = 0;
export const VK_ESC = 1;
export const VK_CSI = 2;
export const VK_SS3 = 3;

const ESC = '\x1b';

// 送完 str 之後，server 端的 vtkbd 會停在哪個狀態。
//
// 只鏡像到「還缺不缺後續位元組」的程度——按鍵語意（KEY_UP／KEY_F1…）與我們無關。
// 逐條對應 vtkbd_process 的四個 case。
export function nextSendState(state, str) {
  let s = state === VK_ESC || state === VK_CSI || state === VK_SS3 ? state : VK_NORMAL;
  const data = str || '';
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i) & 0xff;
    switch (s) {
      case VK_ESC:
        // vtkbd.c:145-160
        if (c === 0x5b /* [ */) s = VK_CSI;
        else if (c === 0x4f /* O */) s = VK_SS3;
        else s = VK_NORMAL;
        break;
      case VK_SS3:
        // vtkbd.c:162-228：命中就回鍵、沒命中 break 到函式尾 → 兩條都回 NORMAL。
        s = VK_NORMAL;
        break;
      case VK_CSI:
        // vtkbd.c:230-306
        if (c === 0x1b) s = VK_ESC;              // 新 ESC 打斷，重開
        else if (c < 0x20 || c === 0x7f) s = VK_NORMAL; // 控制字元 → abort
        else if (c > 0x7e) s = VK_NORMAL;               // 非 ASCII → abort
        else if (c >= 0x40) s = VK_NORMAL;              // final byte 0x40–0x7E
        // 0x20–0x3F ＝ parameter／intermediate，續留 CSI
        break;
      default:
        s = c === 0x1b ? VK_ESC : VK_NORMAL;     // vtkbd.c:129-133
        break;
    }
  }
  return s;
}

// 送 str 之前的守門。回 { data, state }：data ＝真正該送上線的位元組，
// state ＝送完之後 server 會停在的狀態（呼叫端存回去，下次再帶進來）。
//
// 補的條件抓得很窄，**只有「server 停在 VK_ESC，而 str 開頭正是一個跳脫序列
// （ESC 後面接 `[` 或 `O`）」**才補。三種不補的情況各有理由：
//   - str 是**單獨一個 ESC**（連按兩下 Esc）：第二個 ESC 本來就會被第一個吃成
//     esc_arg 而自行化解，補了只是多一個 no-op KEY_ESC，狀態還是一樣懸空。
//   - str 以可列印字元開頭：那正是使用者的 ESC 組合鍵（ESC-L／ESC-數字），不可動。
//   - state 是 VK_CSI／VK_SS3：我們從不把一個跳脫序列拆成兩次送，真出現也不該
//     在中間插東西。
export function guardEscSequence(state, str) {
  const data = str || '';
  const needsGuard =
    state === VK_ESC &&
    data.charCodeAt(0) === 0x1b &&
    (data.charCodeAt(1) === 0x5b /* [ */ || data.charCodeAt(1) === 0x4f /* O */);
  const out = needsGuard ? ESC + data : data;
  return { data: out, state: nextSendState(state, out) };
}
