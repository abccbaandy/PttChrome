// 合成的新版說明選單畫面（離線 e2e 用，不連 PTT）。版型照 pttbbs
// mbbsd/psb.c#cmd_show_help_layers_inner：row 0 vs_header「【caption】…操作說明 (Help)」、
// row 1 反白欄位列、row 2.. 每列一項（`  (鍵) 名稱<補到 28 寬>  說明`，游標 `>` 在 col 0）、
// 每頁 rows-3 項、底列 footer（多頁時帶「[第 x/y 頁]」）。項目取自 2026-10-18 使用者
// 錄製檔（我的最愛按 h，同 tests/unit/fixtures/help_menu_rows.js），不含帳號資訊。
const { waitScreenSettled } = require('./replay');

const CAPTION = '我的最愛';
const ITEMS = [
  '(h/H) 說明                    顯示操作說明',
  '(a/i) 增加看板                輸入看板名稱加入最愛',
  '(d) 刪除                      從我的最愛移除項目',
  '(g) 新增目錄                  在我的最愛新增子目錄',
  '(M) 移動位置                  移動最愛項目順序',
  '(v/V) 已讀/未讀               標記看板為已讀/未讀',
  '(t) 標記                      標記看板項目',
  '(←/e/q) 回上層               離開看板列表',
  '(y) 列出全部                  切換顯示全部看板/我的最愛',
  '(→/Enter/r/l) 進入           進入選取的看板或目錄',
  '(s) 找看板                    搜尋全站看板名稱',
  '(/) 搜尋                      搜尋看板中文關鍵字',
  '(c) 新文章                    切換顯示看板編號或文章數',
  '(S) 排序                      切換看板排序方式',
  '(PgUp/P/b/^B) 上頁            向上翻頁',
  '(PgDn/Space/N/^F) 下頁        向下翻頁',
  '(L) 加分隔線                  新增分隔線或看板連結',
  '(T) 改目錄名                  修改最愛子目錄標題',
  '(K) 備份還原                  備份或還原我的最愛',
  '(m/z)                         將看板加入或移出最愛',
  '(*)                           反選全部標記',
  '(^D)                          刪除所有已標記項目',
  '(^A)                          將標記項目加入最愛',
  '(^E/^T)                       清除所有標記',
  '(↑/p/k)                      向上移動',
  '(↓/n/j)                      向下移動',
  '(0/Home)                      移至第一筆',
  '(End/$)                       移至最後一筆',
  '(1-9)                         輸入編號跳轉',
  '(^Y/^W)                       查詢目前位置',
  '(^S)                          搜尋目前列表看板',
  '(w)                           手動儲存閱讀記錄',
  '(^Z) 隨處切換(ZA)             快速切換到文章列表、分類、信箱、使用者名單等',
  '(^U) 線上使用者               查看線上使用者名單',
  '(^R) 回應水球                 即時回應剛收到的水球',
];

// 第 page 頁（1 起算），游標在全清單第 cursor 項（預設＝該頁第一項）。
async function drawHelpPage(page, pageNo, opts = {}) {
  const info = await page.evaluate(
    ({ CAPTION, ITEMS, pageNo, cursor, angel }) => {
      const u2b = (str) =>
        [...str]
          .map((ch) => {
            const c = ch.charCodeAt(0);
            return c < 0x80
              ? ch
              : String.fromCharCode(window.lib.u2bArray[2 * c]) +
                  String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
          })
          .join('');
      const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
      const rows = window.__app.buf.rows;
      const perPage = rows - 3;
      const total = Math.ceil(ITEMS.length / perPage);
      const base = (pageNo - 1) * perPage;
      const cur = cursor == null ? base : cursor;
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      const line = (s) => u2b(s + ' '.repeat(Math.max(0, 80 - width(s))));
      let d = '\x1b[H\x1b[2J';
      d += '\x1b[1;1H' + REV + line('【' + CAPTION + '】                    操作說明 (Help)') + OFF;
      d += '\x1b[2;1H' + REV + line('  按鍵 / 標籤                   功能說明') + OFF;
      for (let i = 0; i < perPage && base + i < ITEMS.length; ++i)
        d += '\x1b[' + (3 + i) + ';1H' + (base + i === cur ? '>' : ' ') + ' ' + u2b(ITEMS[base + i]);
      let left = ' 操作說明 ';
      if (total > 1) left += ' [第 ' + pageNo + '/' + total + ' 頁] (PgUp)上頁 (PgDn)下頁';
      left += ' (Enter)執行' + (angel ? ' (h)小天使' : '');
      const right = '(q/←)離開 ';
      d += '\x1b[' + rows + ';1H' + REV + u2b(left + ' '.repeat(80 - width(left) - width(right)) + right) + OFF;
      d += '\x1b[' + (3 + cur - base) + ';1H';
      window.__app.onData(d);
      return { perPage, total };
    },
    { CAPTION, ITEMS, pageNo, cursor: opts.cursor, angel: opts.angel !== false }
  );
  await waitScreenSettled(page, { 0: '操作說明 (Help)', 2: ITEMS[(pageNo - 1) * info.perPage] });
  return info;
}

// 離開說明選單之後的畫面（任何不是說明選單的畫面都行）。
async function drawOtherScreen(page) {
  await page.evaluate(() => {
    window.__app.onData('\x1b[H\x1b[2J\x1b[1;1Hsome other screen');
  });
  await page.waitForFunction(() => {
    const buf = window.__app.buf;
    return !buf.timerUpdate && !buf._settleTimer && buf.getRowText(0, 0, buf.cols).includes('some other screen');
  });
}

module.exports = { CAPTION, ITEMS, drawHelpPage, drawOtherScreen };
