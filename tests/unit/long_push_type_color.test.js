// 長推文型別（推／噓／→）的配色，兩件事各守一邊：
//
//   1. 色碼必須**就是終端機的那一份**（term_buf.termColors 的 bright 槽位）。
//      浮層上的顏色與同一畫面上終端機畫出來的推文列一旦對不起來，使用者只會覺得
//      「怎麼跟 PTT 不一樣」，而這種偏差在 code review 看不出來。long_push.js 刻意
//      不 import term_buf（冷載入成本），所以一致性只能在這裡守。
//
//   2. key 集合必須與 PUSH_TYPE_KEY 一致。日後新增型別時漏掉顏色，UI 上是
//      undefined ⇒ 那一項靜默退回預設色。
//
// 顏色的出處是 pttbbs 原始碼，不是觀察畫面猜的：bbs.c:2822-2826 的 ctype_attr
// ＝ {ANSI_COLOR(1;33), ANSI_COLOR(1;31), ANSI_COLOR(1;37)}，即亮黃／亮紅／亮白，
// 同一組用在型別選單與輸入列前綴（bbs.c:2993 / :3085）。

import { PUSH_TYPE_KEY, PUSH_TYPE_COLOR } from "../../src/js/long_push";
import { termColors } from "../../src/js/term_buf";

// ANSI 的 1;3x ＝ bright 前景，色票索引 = 8 + x。
const BRIGHT = (x) => termColors[8 + x];

test("色碼就是終端機色票的 bright 槽位（ctype_attr 的 1;33 / 1;31 / 1;37）", () => {
  expect(PUSH_TYPE_COLOR.push).toBe(BRIGHT(3)); // 1;33 亮黃 #ffff00
  expect(PUSH_TYPE_COLOR.boo).toBe(BRIGHT(1)); // 1;31 亮紅 #ff0000
  expect(PUSH_TYPE_COLOR.arrow).toBe(BRIGHT(7)); // 1;37 亮白 #ffffff
});

test("每個型別都有顏色（新增型別時不會靜默漏掉）", () => {
  expect(Object.keys(PUSH_TYPE_COLOR).sort()).toEqual(
    Object.keys(PUSH_TYPE_KEY).sort(),
  );
});

test("三色互不相同（選項要一眼分得出來）", () => {
  const values = Object.values(PUSH_TYPE_COLOR);
  expect(new Set(values).size).toBe(values.length);
});
