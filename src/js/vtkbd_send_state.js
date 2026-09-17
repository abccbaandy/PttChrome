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
// ---- 界線是「送出入口」，不是「位元組內容」（2026-09-17 反轉，勿改回去）----
//
// 這裡有兩個模式，預設是**機器模式**：
//
//   guardEscSequence(state, str)                   機器送出 → 懸空的 ESC 態一律化解
//   guardEscSequence(state, str, {userKey: true})  真鍵盤／IME → 保留 ESC 組合鍵
//
// telnet.js 據此分成 `send`/`convSend`（預設）與 `sendUserKey`/`convSendUserKey`，
// 而後兩個**只有 term_view._send / _convSend 會叫**（守護
// tests/unit/user_key_send_wiring.test.js）。送出到線路的全部出口只有五處：
// CommandQueue、App.sendData、anti-idle、App.setBBSCmd（以上機器）＋ term_view
// 那兩個（真鍵盤／IME）。新增送出路徑時預設就是安全的那一邊。
//
// 為什麼要反轉（2026-09-17 實錄，錄製檔 ptt-debug-20260917-012944.json）：
// 使用者關掉長推文輸入框後多按一下 Esc ⇒ server 停在 VKSTATE_ESC；下一次按 X，
// 探路送出的 `Q`（CommandQueue kind=longpush-aid，t=529）被吃成 esc_arg、回一個
// 在 pager 沒有消費者的 KEY_ESC ⇒ **畫面不動、零輸出**（t=529→1229 共 700ms 零
// recv，而該連線 RTT 只有 12ms）⇒ CommandQueue 的 soft timeout 送 \f 探針 ⇒
// 探針幀是完整文章畫面、expect 仍找不到 AID ⇒ 判成 miss ⇒ 使用者看到
// 「讀不到文章代碼（miss）」。舊守門對可列印字元開頭一律不補，正好漏掉這條。
//
// **不能改從源頭擋**（2026-09-17 在 offline e2e 實測過，不要再試一次）：
// term_view.js 的 shouldAcceptInput()（modalShown）看起來該擋得住「關框那一下」的
// Esc，實際上擋不住 —— Mantine Modal 的 Escape handler 比 term_view 的 keydown
// listener 先跑，等 term_view 那條跑到時 modalShown **已經翻成 false**（實測：
// window capture phase 的第一個 listener 量到的就是 false）。所以每一次用 Esc 關掉
// 長推文輸入框，都會有一個裸 ESC 上線；再加上「框關掉之後順手多按的那一下」
// （那時畫面上真的沒有彈窗，Esc 是合法的終端機輸入，沒有理由擋），懸空的 ESC 態
// 是常態而不是例外 —— 這正好解釋了「取消長推文之後立刻再按 X 特別容易觸發」。
// ⇒ 只能讓後續的程式化送出自己不要踩進去。
// 活證據：tests/e2e/offline/long_push.offline.spec.js 的「點底列的 (X)／(%) 推文
// 按鈕」第二輪 —— 它用 Escape 關框，第二輪的探路 X 前面因此必定帶一個化解用的 ESC。
//
// 化解是安全的 —— **KEY_ESC 的事件數補不補都一樣**：
//   不補：VK_ESC + '2' → '2' 被吃成 esc_arg ⇒ 1 個 KEY_ESC、0 個真鍵
//   補：  VK_ESC + ESC + '2' → ESC 被吃成 esc_arg ⇒ 1 個 KEY_ESC ＋ 真鍵 '2'
// 化解不可能製造出原本不會發生的 KEY_ESC，它只是把被吃掉的真鍵還回來。各畫面對
// 那一個 KEY_ESC 的反應（全部查證過 pttbbs source）：
//
//   pager／文章列表／選單   唯一消費者 edit.c 的兩處 switch(KEY_ESC_arg) 無 default ⇒ no-op
//   型別選單 vkey()         bbs.c:3001-3010 `!isdigit` → RECTYPE_DEFAULT（推）
//   vgetstring（內容／確認） vtuikit.c:1374 `c < ' '` → bell(); continue ⇒ 不吃字、不結束
//   vmsg ◆ 橫幅            vtuikit.c:447 `do { i = vkey(); } while (i == 0)` ⇒ **任何鍵都消橫幅**
//
// 最後一列是唯一有副作用的（ESC 消掉橫幅、原本的空白鍵落到底下的 pager＝下一頁），
// 但它**不可達**：VK_ESC 只可能來自使用者按的裸 Escape，而四個 queue owner 與
// setBBSCmd 的每一個 payload 最後一個位元組都不是 ESC（nextSendState 送完一律回
// VK_NORMAL，守護 tests/unit/long_push_flow.test.js），長推文送出全程又蓋著真 modal
// ⇒ term_view 整組噤聲。反過來說，**不化解**的後果是型別選單那一步的 '2' 被吃掉、
// 型別靜默變成「推」而畫面照樣推進 ⇒ 整段用錯的型別送出，使用者完全看不出來。
//
// 唯一的例外是 **str 本身就是單獨一個 ESC**：它會被前一個 ESC 吃成 esc_arg 自行
// 化解（狀態回 NORMAL），補了反而是「吃掉補的那個、留下 str 自己」＝新的懸空態。
//
// 不碰 ESC 組合鍵：ESC-L（跳行）、ESC-<數字>（讀暫存檔）這類的第二個位元組是
// **可列印字元**，不以 ESC 開頭 ⇒ **userKey 模式**的守門條件天然避開它們。

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
// opts.userKey === true ＝這一串是**使用者剛從鍵盤／IME 打出來的**，補的條件抓得
// 很窄：只有「server 停在 VK_ESC，而 str 開頭正是一個跳脫序列（ESC 後面接 `[`
// 或 `O`）」才補，好讓 ESC 組合鍵（ESC-L／ESC-數字）原封不動地過去。
//
// 預設（機器送出）則是**只要 server 停在 VK_ESC 就補**——那些位元組不可能是使用者
// ESC 組合鍵的第二個位元組，卻百分之百會被 esc_arg 吃掉或誤導進 CSI/SS3。
// 完整推導見檔頭「界線是送出入口」。
//
// 兩個模式都不補的情況：
//   - str 是**單獨一個 ESC**（連按兩下 Esc）：第二個 ESC 本來就會被第一個吃成
//     esc_arg 而自行化解，補了只是多一個 no-op KEY_ESC，狀態還是一樣懸空。
//   - state 是 VK_CSI／VK_SS3：我們從不把一個跳脫序列拆成兩次送，真出現也不該
//     在中間插東西。
export function guardEscSequence(state, str, opts) {
  const data = str || '';
  const startsEscSeq =
    data.charCodeAt(0) === 0x1b &&
    (data.charCodeAt(1) === 0x5b /* [ */ || data.charCodeAt(1) === 0x4f /* O */);
  const loneEsc = data.length === 1 && data.charCodeAt(0) === 0x1b;
  const needsGuard =
    state === VK_ESC &&
    data.length > 0 &&
    !loneEsc &&
    (opts && opts.userKey ? startsEscSeq : true);
  const out = needsGuard ? ESC + data : data;
  return { data: out, state: nextSendState(state, out) };
}
