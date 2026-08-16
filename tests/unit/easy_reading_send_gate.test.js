// 好讀模式的送鍵閘門（EasyReading._send）。
//
// CommandQueue 的整個設計前提是「同時只有一個鍵在線上，回應由畫面內容判定」。
// 使用者的鍵盤早就被 term_view/pttchrome 的入口擋掉了；漏掉的是好讀**狀態機
// 自己送的鍵** —— 它繞過 queue 直接送。deep link 把兩者湊在一起就爆了。
//
// 兩個實測症狀（2026-08-16），同一個根因：
//   a) `#Steam/<aid>`（有進板畫面的看板）跳轉卡死：進板畫面是 pmore，與一篇
//      文章同形，好讀把公告當文章累積並送 PageDown → 餵掉進板畫面收尾的
//      pressanykey（mbbsd/bbs.c:4470-4477）→ 導航的 ← 永遠等不到它要的畫面。
//   b) 「複製本篇連結」複製完就跳出文章：落地後好讀正把文章自動翻到底，它的
//      PageDown 先關掉了 Q 資訊框、又把 pager 翻到 100%，於是 dismissPostInfo
//      送的空白鍵成了 pmore 的「離開」。
//
// 只擋 aidNavigation.active 不夠（b 不在導航中），只進 functionMode 也不夠：
// _onViewUpdated 處理 sendCommandAfterUpdate 那段沒有看 functionMode，進入鏡像
// 模式**之前**就排好的 PageDown 照樣送得出去。

import { EasyReading } from "../../src/js/easy_reading";

function harness({ active = false, inFlightKind = null } = {}) {
  const sent = [];
  return {
    ctx: {
      _core: { aidNavigation: { active }, commandQueue: { inFlightKind } },
      _view: { _send: d => sent.push(d) }
    },
    sent
  };
}

const send = (ctx, data) => EasyReading.prototype._send.call(ctx, data);

test("AID 導航進行中：好讀送出的鍵一律吞掉", () => {
  const h = harness({ active: true });
  send(h.ctx, "\x1b[6~"); // 自動翻頁
  send(h.ctx, ":42\r"); // gap 自癒的跳行
  expect(h.sent).toEqual([]);
});

test("REGRESSION：queue 有指令在飛就不送（複製連結的 Q／關框交易）", () => {
  // 這條就是「複製完跳出文章」的守護：active 是 false，但 deeplink-copy-info
  // 正在等它自己那一幀。
  const h = harness({ inFlightKind: "deeplink-copy-info" });
  send(h.ctx, "\x1b[6~");
  expect(h.sent).toEqual([]);
});

test("關框交易在飛時也不送", () => {
  const h = harness({ inFlightKind: "aid-post-info-dismiss" });
  send(h.ctx, "\x1b[6~");
  expect(h.sent).toEqual([]);
});

test("沒有交易在飛：照常送出（好讀的翻頁動力不能被誤殺）", () => {
  const h = harness();
  send(h.ctx, "\x1b[6~");
  expect(h.sent).toEqual(["\x1b[6~"]);
});

test("沒有 aidNavigation / commandQueue（測試替身）也不能炸", () => {
  const sent = [];
  const ctx = { _core: {}, _view: { _send: d => sent.push(d) } };
  send(ctx, "\x1b[6~");
  expect(sent).toEqual(["\x1b[6~"]);
});
