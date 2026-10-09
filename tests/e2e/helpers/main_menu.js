// 合成的選單畫面一整幀（離線 e2e 用，不連 PTT）。版型照 pttbbs mbbsd/menu.c#domenu：
// 標題列（redraw_title）、adbanner 的 ANSI 圖＋心情點播＋分隔線（header）、選單項
// `menu_column(20) 個空白 + 2 空白 + (X)desc`、游標 `>` 在 col 20、最後一列狀態列
// （show_status_bar）。主選單內容取自 2026-10 使用者錄製檔（tests/unit/fixtures/
// main_menu_rows.js 的同一份，留言者 id／帳號已換成佔位）；子選單是個人設定區
// （menu.c 的 userlist）。畫面固定 24 列：選單項從 row 13 起。
const { waitScreenSettled } = require('./replay');

const ART = [
  '┌────────┬───█────────────────────────┐  ',
  '│右繞佛塔        │     ██    在在所生處    遠離於八難                   │  ',
  '│   功德經 (節錄)│    ███     常生無難處    斯由右繞塔                 │  ',
  '├────────┘   ￣￣￣￣                                             │  ',
  '│                    ▍⊙  ⊙▋       儀貌常端正    富貴多財寶             │  ',
  '│                        λ               恒食大封邑    斯由右繞塔         │  ',
  '│                ▄▄▄▄▄▄▄▄▄                                        │  ',
  '│            ▄▄▄▄▄▄▄▄▄▄▄▄▄       色相淨微妙    見者皆欣仰     │  ',
  '│        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄         所住常安樂    斯由右繞塔 │  ',
  '└───▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄────────────────┘  ',
  'someuser想對大家說：得妙紫金色，相好莊嚴身，現作天人師，斯由右繞塔。',
  '───────── 上方為使用者心情點播留言區，不代表本站立場 ────────  ',
];

const MAIN_MENU = {
  title: '主功能表',
  items: [
    '(A)nnounce     【 精華公佈欄 】',
    '(F)avorite     【 我 的 最愛 】',
    '(C)lass        【 分組討論區 】',
    '(M)ail         【 私人信件區 】',
    '(T)alk         【 休閒聊天區 】',
    '(U)ser         【 個人設定區 】',
    '(X)yz          【 系統資訊區 】',
    '(P)lay         【 娛樂與休閒 】',
    '(N)amelist     【 編特別名單 】',
    '(G)oodbye         離開，再見…',
  ],
  cursor: 1, // (F)avorite
  status: ' 主選單   世界郵政日   10/9 週五 13:31 | someone | 線上24764人',
  right: '(h)說明 ',
};

// 子選單寬度不夠時 show_status_bar 剪掉「| 線上N人」並在右側加「(←)回到上層」。
const USER_MENU = {
  title: '個人設定',
  items: [
    '(U)Customize    個人化設定',
    '(I)nfo          設定個人資料與密碼',
    '(V)Login View   選擇進站畫面',
    '(M)y Files      【個人檔案】 (名片,簽名檔...)',
    '(L)My Logs      【個人記錄】 (最近上線...)',
    '(R)egister      新增帳號認證',
    '(2)FA           設定兩階段認證',
  ],
  cursor: 0,
  status: ' 個人設定 世界郵政日     10/9 週五 13:31 | someone',
  right: '(←)回到上層 (h)說明 ',
};

const FIRST_ITEM_ROW = 13;
const ART_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

async function drawMenu(page, menu) {
  await page.evaluate(
    ({ ART, menu, FIRST_ITEM_ROW }) => {
      const u2b = (str) => {
        let out = '';
        for (const ch of str) {
          const c = ch.charCodeAt(0);
          if (c < 0x80) {
            out += ch;
            continue;
          }
          out +=
            String.fromCharCode(window.lib.u2bArray[2 * c]) +
            String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        }
        return out;
      };
      const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
      const rows = window.__app.buf.rows;
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[H\x1b[2J';
      // 標題列整列同色（term_buf.setPageState 的 isUnicolor 判準）。
      const title = '【' + menu.title + '】';
      d += '\x1b[1;1H' + REV + u2b(title + ' '.repeat(80 - width(title))) + OFF;
      ART.forEach((t, i) => {
        d += '\x1b[' + (i + 2) + ';1H' + u2b(t);
      });
      menu.items.forEach((t, i) => {
        const cur = i === menu.cursor ? '>' : ' ';
        d += '\x1b[' + (FIRST_ITEM_ROW + i + 1) + ';1H' + ' '.repeat(20) + cur + ' ' + u2b(t);
      });
      // vbarlr：左段靠左、右段靠右，中間補空白，整列一個底色。
      const pad = 79 - width(menu.status) - width(menu.right);
      d += '\x1b[' + rows + ';1H' + REV + u2b(menu.status + ' '.repeat(pad) + menu.right) + OFF;
      d += '\x1b[' + (FIRST_ITEM_ROW + menu.cursor + 1) + ';21H';
      window.__app.onData(d);
    },
    { ART, menu, FIRST_ITEM_ROW }
  );
  await waitScreenSettled(page, { 0: menu.title, [FIRST_ITEM_ROW + menu.cursor]: menu.items[menu.cursor] });
  await page.waitForFunction(() => window.__app.buf.pageState === 1);
}

const drawMainMenu = (page) => drawMenu(page, MAIN_MENU);
const drawUserMenu = (page) => drawMenu(page, USER_MENU);

// 一張 pressanykey 畫面（pageState 5）：子選單的標題不在白名單，以前只能沿用這個 5。
async function drawPressAnyKey(page) {
  await page.evaluate(() => {
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
    const rows = window.__app.buf.rows;
    // term_buf._isPauseRow：「請按任意鍵繼續」不在 col 0（pressanykey 置中印）。
    window.__app.onData(
      '\x1b[H\x1b[2J\x1b[1;1Hsome screen\x1b[' + rows + ';1H' +
        '\x1b[7m' + u2b('                         請按任意鍵繼續') + '\x1b[m'
    );
  });
  await page.waitForFunction(() => window.__app.buf.pageState === 5);
}

module.exports = {
  drawMenu,
  drawMainMenu,
  drawUserMenu,
  drawPressAnyKey,
  MAIN_MENU,
  USER_MENU,
  FIRST_ITEM_ROW,
  ART_ROWS,
  CURSOR_ROW: FIRST_ITEM_ROW + MAIN_MENU.cursor,
  ITEMS: MAIN_MENU.items,
};
