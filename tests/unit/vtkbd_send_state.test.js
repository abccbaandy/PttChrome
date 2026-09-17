// 送出端鏡像 pttbbs vtkbd 的 ESC 狀態機。
//
// 守的是這個真實症狀（2026-09-16 錄製檔 ptt-debug-20260916-011413.json）：
// 關掉長推文輸入框後多按的那一下 Esc 送出**裸 ESC** → server 停在 VKSTATE_ESC →
// 接下來的 ← 的開頭 ESC 被當成 esc_arg 吃掉 → `[` 與 `D` 變成字面鍵 →
// `[` ＝ RELATE_PREV（more.c:130-136）⇒ 畫面跳到同主題的上一篇。
// 推導與檔案行號見 src/js/vtkbd_send_state.js 檔頭。
import {
  VK_NORMAL,
  VK_ESC,
  VK_CSI,
  VK_SS3,
  nextSendState,
  guardEscSequence,
} from "../../src/js/vtkbd_send_state";

describe("nextSendState：送完之後 server 停在哪", () => {
  it("裸 ESC 讓 server 停在半途（這就是地雷本身）", () => {
    expect(nextSendState(VK_NORMAL, "\x1b")).toBe(VK_ESC);
  });

  it("完整的 CSI 跳脫序列送完回 NORMAL", () => {
    for (const seq of ["\x1b[D", "\x1b[A", "\x1b[6~", "\x1b[5~", "\x1b[1~"])
      expect(nextSendState(VK_NORMAL, seq)).toBe(VK_NORMAL);
  });

  it("SS3（ESC O x）送完回 NORMAL", () => {
    expect(nextSendState(VK_NORMAL, "\x1bOA")).toBe(VK_NORMAL);
    // 沒命中任何 case 的 SS3 也會被 vtkbd 消掉一個位元組後回 NORMAL。
    expect(nextSendState(VK_NORMAL, "\x1bO?")).toBe(VK_NORMAL);
  });

  it("一般按鍵與文字不留狀態", () => {
    expect(nextSendState(VK_NORMAL, "21350\r\f")).toBe(VK_NORMAL);
    expect(nextSendState(VK_NORMAL, "\x03")).toBe(VK_NORMAL);
  });

  it("ESC 組合鍵：ESC 之後的可列印字元被吃成 esc_arg，狀態回 NORMAL", () => {
    expect(nextSendState(VK_ESC, "L")).toBe(VK_NORMAL);
    expect(nextSendState(VK_ESC, "1")).toBe(VK_NORMAL);
  });

  it("半截序列會被記住（CSI／SS3 中途）", () => {
    expect(nextSendState(VK_NORMAL, "\x1b[")).toBe(VK_CSI);
    expect(nextSendState(VK_NORMAL, "\x1b[1;5")).toBe(VK_CSI);
    expect(nextSendState(VK_NORMAL, "\x1bO")).toBe(VK_SS3);
    expect(nextSendState(VK_CSI, "D")).toBe(VK_NORMAL);
  });

  it("CSI 中途來的新 ESC 會重開 ESC 狀態（vtkbd.c:230-235）", () => {
    expect(nextSendState(VK_CSI, "\x1b")).toBe(VK_ESC);
  });

  it("CSI 中途的控制字元／非 ASCII 會 abort 回 NORMAL", () => {
    expect(nextSendState(VK_CSI, "\r")).toBe(VK_NORMAL);
    expect(nextSendState(VK_CSI, "\xa4")).toBe(VK_NORMAL);
  });
});

describe("guardEscSequence（userKey：真鍵盤／IME 才有的 ESC 組合鍵保護）", () => {
  it("懸空 ESC ＋ 方向鍵 → 先補一個 ESC 化解", () => {
    const r = guardEscSequence(VK_ESC, "\x1b[D", { userKey: true });
    expect(r.data).toBe("\x1b\x1b[D");
    expect(r.state).toBe(VK_NORMAL);
  });

  it("懸空 ESC ＋ PageDown 同理", () => {
    expect(guardEscSequence(VK_ESC, "\x1b[6~", { userKey: true }).data).toBe(
      "\x1b\x1b[6~",
    );
  });

  it("懸空 ESC ＋ 可列印字元 ＝ 使用者的 ESC 組合鍵，一個位元組都不加", () => {
    const r = guardEscSequence(VK_ESC, "L", { userKey: true });
    expect(r.data).toBe("L");
    expect(r.state).toBe(VK_NORMAL);
  });

  it("NORMAL 狀態下的方向鍵原封不動（不可亂加）", () => {
    const r = guardEscSequence(VK_NORMAL, "\x1b[D", { userKey: true });
    expect(r.data).toBe("\x1b[D");
    expect(r.state).toBe(VK_NORMAL);
  });

  it("連按兩下 Esc：第二下化解第一下，狀態不累積", () => {
    const first = guardEscSequence(VK_NORMAL, "\x1b", { userKey: true });
    expect(first.data).toBe("\x1b");
    expect(first.state).toBe(VK_ESC);
    const second = guardEscSequence(first.state, "\x1b", { userKey: true });
    // 第二個 ESC 本來就會被第一個吃成 esc_arg ⇒ 不必也不該再補。
    expect(second.data).toBe("\x1b");
    expect(second.state).toBe(VK_NORMAL);
  });

  it("CSI 半途不補（我們從不把一個序列拆成兩次送）", () => {
    expect(guardEscSequence(VK_CSI, "\x1b[D", { userKey: true }).data).toBe(
      "\x1b[D",
    );
  });

  it("空字串不炸", () => {
    const r = guardEscSequence(VK_ESC, "", { userKey: true });
    expect(r.data).toBe("");
    expect(r.state).toBe(VK_ESC);
  });
});

// 預設模式＝機器送出（CommandQueue／setBBSCmd／anti-idle／sendData）。
// 那些位元組永遠不是使用者的 ESC 組合鍵的第二個位元組（組合鍵的 Esc 走真鍵盤、
// 不經過這些路徑），所以懸空的 ESC 態一律化解。
//
// 守的症狀（錄製檔 ptt-debug-20260917-012944.json#t=529）：使用者關掉長推文輸入框
// 後多按一下 Esc ⇒ server 停在 VKSTATE_ESC ⇒ 下一次按 X 探路送出的 `Q` 被吃成
// esc_arg、回一個在 pager 沒有消費者的 KEY_ESC ⇒ **畫面不動、零輸出** ⇒ 700ms 後
// CommandQueue 送 \f 探針 ⇒ 判成 miss ⇒「讀不到文章代碼（miss）」。
describe("guardEscSequence（預設＝機器送出，一律化解懸空的 ESC 態）", () => {
  it("懸空 ESC ＋ Q（探路取 AID）→ 補一個 ESC，Q 才到得了 pmore", () => {
    const r = guardEscSequence(VK_ESC, "Q");
    expect(r.data).toBe("\x1bQ");
    expect(r.state).toBe(VK_NORMAL);
  });

  it("懸空 ESC ＋ X／型別鍵／`[` 這種可列印機器鍵都要化解", () => {
    for (const keys of ["X", "1", "[", "]", "\r", " ", "\x03", "\f"])
      expect(guardEscSequence(VK_ESC, keys).data).toBe("\x1b" + keys);
  });

  it("懸空 ESC ＋ 跳脫序列：與 userKey 模式同結果，不會補兩次", () => {
    for (const seq of ["\x1b[D", "\x1b[6~", "\x1bOA"])
      expect(guardEscSequence(VK_ESC, seq).data).toBe(
        guardEscSequence(VK_ESC, seq, { userKey: true }).data,
      );
  });

  it("NORMAL 狀態下一個位元組都不加", () => {
    for (const keys of ["Q", "\x1b[D", "\x1b\x1b"]) {
      const r = guardEscSequence(VK_NORMAL, keys);
      expect(r.data).toBe(keys);
    }
  });

  it("單獨一個 ESC 不補：它本來就會被吃成 esc_arg 自行化解，補了反而留下新的懸空態", () => {
    const r = guardEscSequence(VK_ESC, "\x1b");
    expect(r.data).toBe("\x1b");
    expect(r.state).toBe(VK_NORMAL);
  });

  it("anti-idle 的 ESC ESC 補完之後狀態是乾淨的", () => {
    const r = guardEscSequence(VK_ESC, "\x1b\x1b");
    expect(r.state).toBe(VK_NORMAL);
  });

  it("CSI 半途不補（同 userKey）", () => {
    expect(guardEscSequence(VK_CSI, "\x1b[D").data).toBe("\x1b[D");
    expect(guardEscSequence(VK_SS3, "A").data).toBe("A");
  });

  it("空字串不炸", () => {
    const r = guardEscSequence(VK_ESC, "");
    expect(r.data).toBe("");
    expect(r.state).toBe(VK_ESC);
  });
});
