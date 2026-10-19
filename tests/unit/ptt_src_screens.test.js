// @unit-env browser
// Spike：畫面位元組由 **upstream pttbbs 原始碼本身**產生（編譯 mbbsd 物件檔＋假 SHM／
// 假使用者的 driver 直接呼叫 Read()，不架站、不登入），經 app 自己的 AnsiParser →
// TermBuf 落格子，再跑本專案的畫面判定與列表解析器。手抄排版（ptt_vcol_list_layout）
// 的 row 1 是自己寫的，抓不到 upstream 在 row 1 加指令說明列（72718d5）這類改動；
// 這裡的每一個位元組都是 upstream 程式碼吐的。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { classifyListScreen } from "../../src/js/list_session";
import { boardEntryArms } from "../../src/js/board_note_skip";
import {
  parseListArticleNum,
  parseListAuthor,
  subjectOfListText,
} from "../../src/js/comment_parse";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import articleList from "./fixtures/ptt_src_screens/article_list.json";

loadBig5Tables();

function paint({ cols, rows, bytes }) {
  const buf = new TermBuf(cols, rows);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  new AnsiParser(buf).feed(bytes);
  buf.updateCharAttr();
  return buf;
}

const rowTexts = (buf) =>
  Array.from({ length: buf.rows }, (_, y) => buf.getRowText(y, 0, buf.cols));

// tools/ptt-src-screens/seed.tsv：Test 板 5 篇。fixture 由該目錄的 generate.sh 重產
// （產自 pttbbs 3b8596b9）。置底那篇目前畫成一般編號：driver 的假 SHM 還沒設置底數。
const SEED = [
  { num: 1, owner: "alice", subject: "[問題] 第一篇測試文章" },
  { num: 2, owner: "bob", subject: "[問題] 第一篇測試文章" },
  { num: 3, owner: "carol", subject: "[新聞] 轉錄的新聞" },
  { num: 4, owner: "dave", subject: "[公告] 版規" },
  { num: 5, owner: "SYSOP", subject: "[公告] 置底公告" },
];

describe("upstream pttbbs 產的文章列表畫面", () => {
  const buf = paint(articleList);
  const texts = rowTexts(buf);

  test("整幀判成文章列表", () => {
    const cls = classifyListScreen({
      rowTexts: texts,
      rows: buf.rows,
      curX: buf.cur_x,
      curY: buf.cur_y,
      // 同 easy_reading.js／board_note_skip.js 的呼叫端
      row0Reversed: buf.isUnicolor(0, 0, 29),
      row2Reversed: buf.isUnicolor(2, 0, buf.cols - 10),
    });
    expect(cls.kind).toBe("clean-list");
  });

  test("列表列解析出種子資料的編號／作者／標題", () => {
    SEED.forEach((a, i) => {
      const t = texts[3 + i];
      expect(parseListArticleNum(t)).toBe(a.num);
      expect(parseListAuthor(t)).toBe(a.owner.toLowerCase()); // 解析器刻意轉小寫
      expect(subjectOfListText(t)).toContain(a.subject);
    });
  });

  test("在文章列表按 ⏎ 開文不會被當成進板而 arm（72718d5）", () => {
    expect(boardEntryArms(texts, "\r")).toBe(false);
  });
});
