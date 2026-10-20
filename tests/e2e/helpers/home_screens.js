// 首頁儀表板相關的合成畫面（離線 e2e 用，不連 PTT）。版型照 pttbbs：
//   我的最愛  ＝ board.c#brdlist_renderer：%7d%c%s（未讀是全形ˇ）＋板名(13)＋類別＋◎＋敘述(34)＋人氣＋板主
//   文章列表  ＝ bbs.c#readdoent：%7d 序號、空白、type（cell 8 的已讀標記）、推文數、日期、作者、標題
//   選看板    ＝ bbs.c#do_select 的 CompleteBoard prompt（row 1，article_search.BOARD_PROMPT）
// 主功能表在 helpers/main_menu.js。
const { waitScreenSettled } = require('./replay');

const REV = '\x1b[7m';
const OFF = '\x1b[0m';
const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
const padCells = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const at = (row, col) => '\x1b[' + row + ';' + (col || 1) + 'H';

// 畫面字串在 Node 組好（Unicode），頁面裡只把非 ASCII 轉成 Big5 再餵 onData。
async function feed(page, data) {
  await page.evaluate((data) => {
    let out = '';
    for (const ch of data) {
      const c = ch.charCodeAt(0);
      if (c < 0x80) {
        out += ch;
        continue;
      }
      out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
    }
    window.__app.onData(out);
  }, data);
}

// boards：[{ name, desc, unread }]，最多 20 個（一頁）。游標在第一列。
async function drawFavorites(page, boards) {
  let d = '\x1b[H\x1b[2J';
  d += at(1) + REV + padCells('【看板列表】                     批踢踢實業坊', 80) + OFF;
  d += at(2) + '[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助';
  d += at(3) + REV + padCells('   編號   看  板       類別   中   文   敘   述               人氣 板   主', 80) + OFF;
  boards.forEach((b, i) => {
    const head = String(i + 1).padStart(7, ' ') + ' ' + (b.unread ? 'ˇ' : '  ');
    const row = (i === 0 ? '>' + head.slice(1) : head) + b.name.padEnd(13, ' ') + '綜合 ◎' + padCells(b.desc, 34) + 'HOT someone';
    d += at(4 + i) + row;
  });
  d += at(24) + REV + padCells('  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀', 79) + OFF;
  d += at(4);
  await feed(page, d);
  await waitScreenSettled(page, { 0: '看板列表', 23: '(a)增加看板' });
}

// 一頁文章列表的板尾：entries ＝ [[num, mark], …] 由舊到新，下面接空白列（＝最新一篇
// 就是最後一筆）。游標停在最新一篇（讀完退回列表時 PTT 畫的樣子）。
async function drawArticleList(page, board, entries) {
  let d = '\x1b[H\x1b[2J';
  d += at(1) + REV + padCells('【板主:someone】   看板《' + board + '》', 80) + OFF;
  d += at(2) + '[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]精華區 [h]說明';
  d += at(3) + REV + padCells('   編號    日 期 作  者       文  章  標  題', 80) + OFF;
  const last = entries.length - 1;
  entries.forEach(([num, mark], i) => {
    const n = String(num).padStart(7, ' ');
    d += at(4 + i) + (i === last ? '>' + n.slice(1) : n) + ' ' + mark + ' 5 6/21 ' + 'someone'.padEnd(13, ' ') + '□ [閒聊] 測試' + num;
  });
  d += at(24) + ' 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ';
  d += at(4 + last);
  await feed(page, d);
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

// 主功能表上按 s 之後的「請輸入看板名稱」prompt（游標停在 row 1 的輸入欄）。
async function drawBoardPrompt(page) {
  const prompt = '請輸入看板名稱(按空白鍵自動搜尋)：';
  await feed(page, at(2) + '\x1b[K' + prompt + REV + ' '.repeat(20) + OFF + at(2, width(prompt) + 1));
  await waitScreenSettled(page, { 1: '請輸入看板名稱' });
}

module.exports = { drawFavorites, drawArticleList, drawBoardPrompt };
