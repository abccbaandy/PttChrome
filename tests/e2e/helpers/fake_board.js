// 頁面裡的假 PTT 文章列表（offline e2e 用）：照 pttbbs read.c 的翻頁規則回應列表按鍵，
// 讓列表好讀的凍結交易（游標同步腿、End／PgUp／跳號）能整段跑完。
//
// 只懂列表會用到的那幾個鍵（read.c）：
//   End    → 游標到最後一篇（read_cmd_end）
//   PgUp   → 游標到 top - p_lines、新頁從游標開始（read_cmd_pgup，頁與頁不重疊）
//   PgDn   → 游標往下一頁（read_cmd_pgdn）
//   Home   → 第 1 篇
//   ↑／↓   → 游標上下一篇
//   <數字>⏎ → 跳至第幾項（search_num），頁＝含那篇的那一頁
//   \f     → 重畫
// 回應在同一個 task 之後餵（不經 Playwright 往返）：凍結交易的窗口很短，從測試端等送出
// 再餵，機器一忙就超過窗口（list_landing_resume.offline.spec.js 同一個理由）。
// 已讀標記：編號 ≥ unreadFrom 是未讀 '+'，其餘已讀 ' '（第一篇未讀＝unreadFrom）。
// 畫面版型照 bbs.c#readdoent（%7d 序號、type 在 cell 8）。

// delayMs：每個回應晚多久到（模擬 PTT 的往返；讓「找的過程」長到看得見）。要小於列表
// 凍結交易的探針門檻（list_session CMD_PROBE_AFTER_MS 250ms），否則每一步都會先被補 \f 探。
async function installFakeBoard(page, { total, unreadFrom, cursor, delayMs = 0 }) {
  await page.evaluate(
    ({ total, unreadFrom, cursor, delayMs }) => {
      const P = 20; // 條目區 rows 4..23（24 列畫面）
      const TITLES = ['[問卦] 有沒有今天好冷的八卦', '[新聞] 颱風動態更新', 'Re: [問卦] 晚餐吃什麼', '[爆卦] 某某事件懶人包', '[閒聊] 週末去哪玩', '[問卦] 為什麼貓咪這麼可愛'];
      const markOf = (n) => (n >= unreadFrom ? '+' : ' ');
      const u2b = (str) => {
        let out = '';
        for (const ch of str) {
          const c = ch.charCodeAt(0);
          if (c < 0x80) {
            out += ch;
            continue;
          }
          out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        }
        return out;
      };
      const st = { cur: cursor, top: Math.floor((cursor - 1) / P) * P + 1, digits: '' };
      const clamp = (n) => Math.max(1, Math.min(total, n));
      const draw = () => {
        const REV = '\x1b[7m';
        const OFF = '\x1b[0m';
        let d = '\x1b[2J';
        d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Gossiping》'.padEnd(80)) + OFF;
        d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
        d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
        let curRow = 4;
        for (let i = 0; i < P; ++i) {
          const num = st.top + i;
          if (num > total) break;
          const isCur = num === st.cur;
          if (isCur) curRow = 4 + i;
          const head = isCur ? '>' + String(num).padStart(6) : String(num).padStart(7);
          d +=
            '\x1b[' + (4 + i) + ';1H' +
            u2b(head + ' ' + markOf(num) + ' ' + ((num % 7) + 1) + ' 11/14 user' + String(num % 97).padEnd(8) + ' □ ' + TITLES[num % TITLES.length]);
        }
        d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
        d += '\x1b[' + curRow + ';1H';
        window.__app.onData(d);
      };
      const setCur = (n) => {
        st.cur = clamp(n);
        if (st.cur < st.top || st.cur >= st.top + P) st.top = Math.floor((st.cur - 1) / P) * P + 1;
      };
      const KEYS = [
        ['\x1b[4~', () => {
          st.cur = total;
          st.top = Math.max(1, total - P + 1);
        }],
        ['\x1b[5~', () => {
          st.cur = clamp(st.top - P);
          st.top = st.cur;
        }],
        ['\x1b[6~', () => {
          st.top = clamp(st.top + P);
          st.cur = clamp(st.cur + P);
        }],
        ['\x1b[1~', () => setCur(1)],
        ['\x1b[A', () => setCur(st.cur - 1)],
        ['\x1b[B', () => setCur(st.cur + 1)],
        ['\x1bOA', () => setCur(st.cur - 1)],
        ['\x1bOB', () => setCur(st.cur + 1)]
      ];
      window.__fakeBoard = st;
      window.__fakeBoardKeys = [];
      const prev = window.__stubWSSent;
      window.__stubWSSent = (data) => {
        if (prev) prev(data);
        let s = String(data);
        let redraw = false;
        while (s.length) {
          const k = KEYS.find(([seq]) => s.startsWith(seq));
          if (k) {
            window.__fakeBoardKeys.push(k[0]);
            k[1]();
            s = s.slice(k[0].length);
            redraw = true;
            continue;
          }
          const ch = s[0];
          s = s.slice(1);
          if (ch >= '0' && ch <= '9') st.digits += ch;
          else if (ch === '\r' && st.digits) {
            window.__fakeBoardKeys.push(st.digits + '\r');
            setCur(Number(st.digits));
            st.digits = '';
            redraw = true;
          } else if (ch === '\f') redraw = true;
        }
        if (redraw) setTimeout(draw, delayMs);
      };
      draw();
    },
    { total, unreadFrom, cursor, delayMs }
  );
}

// 第一次 End 之後送出的跳號（'<編號>⏎'）。接管後的背景補頁也會動真游標（手機卡片一屏
// 放不滿就補頁），所以「跳到哪」看送了什麼，不看假 server 的游標最後停在哪。
function jumpsAfterEnd(page) {
  return page.evaluate(() => {
    const keys = window.__fakeBoardKeys || [];
    const i = keys.indexOf('\x1b[4~');
    return i < 0 ? [] : keys.slice(i + 1).filter((k) => /^\d+\r$/.test(k));
  });
}

// 使用者看到的游標那篇（列表好讀＝選取、原生＝游標列；同閱讀紀錄的書籤）。
function listCursorNum(page) {
  return page.evaluate(() => {
    const pos = window.__app.listSession.readingPosition();
    return pos ? pos.cursorNum : null;
  });
}

module.exports = { installFakeBoard, jumpsAfterEnd, listCursorNum };
