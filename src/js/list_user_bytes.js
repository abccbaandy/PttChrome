'use strict';

// 列表好讀（文章列表／看板列表）底下，**使用者送出的 byte 該怎麼處置**的決策層。
// 純函式，零 DOM、零網路、零 state 寫入。守護 tests/unit/list_user_bytes.test.js。
//
// ---- 為什麼需要這一層（2026-09-19「Ctrl+X 轉錄轉到別篇」之後補的結構性止血）----
//
// 列表好讀的本地導覽（T1）是**零網路**的：↑↓ 只動 `_selectedNum`，server 的真游標
// 原地不動，而背景 prefetch 還會主動送 `<編號>\r` 把真游標搬到緩衝邊界
// ⇒ **「選取在 A、真游標在 B」是常態而不是例外**。所以任何「對真游標那一列動作」
// 的鍵（read_comms 裡 needitem=1 的每一顆：^X cross_post、^Q my_query、^A
// show_filename、^E manage_post、'%' recommend…，見 docs/pttbbs-screen-protocol.md
// §11.7）在代送之前一定要先跑 cursor-sync 腿。
//
// 舊架構把「有沒有跑 sync 腿」交給**每個按鍵分派點自己 opt-in**，而
// `term_view.onKeyDown` 對「session 沒接手」只有一種表達方式（不 preventDefault），
// 它卻同時承載兩種語意：
//   (a) 這顆鍵歸瀏覽器／app，PTT 不該收到任何 byte；
//   (b) 放行給原生鍵盤路徑送出去。
// 被歸到 (a) 卻**實際上沒有 handler 接手**的鍵，會靜默退化成 (b) ＝繞過 sync 腿裸送。
// 這個形狀已經復發四次：
//   12b  Shift+Insert（貼上要貼兩次）
//   12c  Caps Lock / F2（畫面跑掉）
//   2026-09-13  ^Q（查詢作者跑去別篇）
//   2026-09-19  ^X（轉錄轉到別篇）—— 最嚴重：連原生鏡像都不切，好讀畫面完全不動
//               而 server 已經對別篇開了轉錄流程。
//
// ⇒ 治本＝把 sync 從呼叫點的 opt-in 改成**線路出口的 fail-closed**：
// `term_view._send` / `_convSend`（真鍵盤／IME 的唯一出口，見
// `vtkbd_send_state.js` 檔頭與 tests/unit/user_key_send_wiring.test.js）送出之前先問
// 這一層。形狀刻意照抄 2026-09-17 立的同一條先例——**界線是送出入口，不是位元組內容**。
// 好處是**新增送字路徑預設就是安全的那一邊**，不必記得去補 sync。
//
// ---- 這一層只管**使用者來源**的 byte（2026-09-20 更正）----
//
// 本檔原本寫的是「`term_view._send` 是全專案**唯一**的 byte 出口」。那是錯的，而且是
// 承重的錯：機器狀態機（好讀的自動翻頁／gap 自癒／整頁重繪）當時也走 `view._send`，
// 於是這道守門把它們一起接手了。兩個實測症狀：
//
//   a) 從好讀列表進文章，第一次自動翻頁固定卡 ~620ms＋每篇閃一次假的
//      「開啟文章中，請稍候…」。文章落地那一瞬間 owner 還是 article-list、state 還是
//      `opening` ⇒ 判 SWALLOW ⇒ 好讀的 PageDown 零 byte 上線，只剩 watchdog 能救。
//      實錄 ptt-debug-20260920-023652，完整推導見 `docs/easy-reading.md`「送鍵閘門」。
//   b) 在好讀列表上開設定頁再關掉 ⇒ 被踢到原生鏡像。`switchToEasyReadingMode` 末尾
//      那個 `^L` 整頁重繪是無條件的，在 `active` + `buffer` 下判 ADOPT ⇒
//      `_beginPassthroughBytes` ⇒ `_enterFunctionMode()`（連 cache 一起丟，不變量 15）。
//      守護 tests/e2e/offline/pref_close_in_list.offline.spec.js。
//
// ⇒ 機器 byte 走**另一個入口** `App.sendMachineBytes`（`conn.send`，機器 ESC 模式），
// 不經這一層。分類學與完整出口清單見 `vtkbd_send_state.js` 檔頭。「機器 byte 要不要
// 跑 cursor-sync 腿」的答案永遠是否：那一腿存在的理由是「使用者看到的選取 ≠ server
// 真游標」，而機器送的鍵不對應任何選取。

export const ADOPT = 'adopt'; // session 接手：走 _beginPassthroughBytes（含 sync 腿）
export const SWALLOW = 'swallow'; // 吞掉＋提示：序列化交易在途，不准搶線路
export const PASS = 'pass'; // 不干涉：照原樣上線

// renderMode: 'native' | 'buffer' | 'frozen'（session 的 _renderMode，已含所有權窗）
// state:      session 的狀態機狀態
//
// 分支與 list_session.onKeyDown / board_list_session._busyHint 的既有守門**同源**，
// 不是另一套判斷——那兩處是「按鍵進來時」的守門，這裡是「byte 要上線時」的守門，
// 條件必須一致，否則同一個情境走兩條路會得到兩種行為。
export function decideUserBytes({ renderMode, state }) {
  // 原生鏡像：使用者看到的就是 server 的真實 24 列，選取即真游標，沒有東西要保護。
  if (renderMode !== 'buffer' && renderMode !== 'frozen') return PASS;
  // 序列化開文在途（sub-second）：放行會與 jump/enter 序列競態（typeahead，協定 §2）。
  if (state === 'opening') return SWALLOW;
  // 凍結畫面背後有交易（sync 腿／leave／jump）在飛：同上。
  if (state === 'functionMode' && renderMode === 'frozen') return SWALLOW;
  // 正常好讀中：這就是「選取 ≠ 真游標」的那個狀態，必須經 sync 腿。
  if (state === 'active') return ADOPT;
  // idle／suspended／cleanup：session 沒在管這張畫面（理論上 renderMode 也不會是
  // buffer/frozen）。判不準就不要搶——fail-closed 是針對「確定歸我」的情況，
  // 對不確定的情況硬接手只會製造新的靜默 bug。
  return PASS;
}

export default decideUserBytes;
