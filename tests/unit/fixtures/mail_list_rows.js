// 信件列表（Ctrl+Z m）的畫面文字：upstream pttbbs 原始碼產生的畫面
// （ptt_src_screens/mail_list.json 的 "mail" 幀，假帳號、假信），24 列。
// mail_card.test.js 另有一支直接從該 fixture 的位元組重建，確認兩者一致。
export const MAIL_LIST_ROWS = [
  "【郵件選單】                       新批踢踢                                     ",
  "[→]讀信 [z]信件夾 [~]資源回收筒 [/]搜尋 [a]找作者 []]主題 [O]站外信 [w]丟水球  ",
  "  編號   日 期 作 者          信  件  標  題               [外信:開] (大小:0篇) ",
  "     1 + 10/01 alice          ◇ 第一封信                                       ",
  "     2 + 10/02 bob            R: 第一封信                                       ",
  ">    3 + 10/03 carol          ◇ 站方通知                                       ",
  ...Array(17).fill(" ".repeat(80)),
  " 信件列表  (^P)寄信 (y)回信 (x)轉寄 (d)刪信 (v)全部已讀       (←)離開 (h)說明  ",
];
export const MAIL_HEADER_ROW = 2;
export const MAIL_ITEM_ROWS = [3, 4, 5];
