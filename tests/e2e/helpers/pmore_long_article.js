// 離線開一篇合成的超長文（pmore 模擬器餵畫面，內容全合成、不含任何真實文章）並進好讀。
// 給「需要很多個長頁分塊（render/screen_chunk.js）」的 spec 用：選取跨塊、每頁成本曲線。
// 第 n 行的文字：n < FIRST_COMMENT 是 `article line n`，之後是推文 `comment n`
// （同作者連三則、每 40 則一張圖片連結）。
const fs = require('fs');
const path = require('path');
const { bootOffline } = require('./replay');

const SIM_SRC = fs.readFileSync(path.join(__dirname, 'pmore_sim.js'), 'utf8');
const FIRST_COMMENT = 60;

async function installLongArticleSim(page, { total, latencyMs = 5 }) {
  await page.evaluate(
    ({ src, total, firstComment, latencyMs }) => {
      const module = { exports: {} };
      new Function('module', 'exports', src)(module, module.exports);
      const { createPmoreSim } = module.exports;
      const authors = ['alice', 'bob', 'carol', 'dave', 'erin'];
      const lineText = (n) => {
        if (n < firstComment) return `article line ${n}`;
        const who = authors[Math.floor(n / 3) % authors.length];
        const body = n % 40 === 0 ? `https://i.imgur.com/long${n}.png` : `comment ${n}`;
        return `${n % 3 === 0 ? '推' : '→'} ${who}: ${body}`.padEnd(66) + '09/25 10:00';
      };
      const sim = createPmoreSim({ total, rows: window.__app.buf.rows, lineText });
      const u2b = (str) => {
        let out = '';
        for (const ch of str) {
          const c = ch.charCodeAt(0);
          if (c < 0x80) { out += ch; continue; }
          out += String.fromCharCode(window.lib.u2bArray[2 * c]) +
                 String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        }
        return out;
      };
      const encode = (f) => {
        let d = '\x1b[H\x1b[2J';
        f.texts.forEach((t, i) => { if (t) d += '\x1b[' + (i + 1) + ';1H' + u2b(t); });
        return d + '\x1b[' + (f.cursor.y + 1) + ';' + (f.cursor.x + 1) + 'H';
      };
      const KEYS = /^(\x1b\[[1456]~|:\d+\r)$/;
      const wire = [];
      window.__stubWSSent = (s) => {
        if (!KEYS.test(s)) return;
        wire.push(s);
        setTimeout(() => {
          const resp = sim.press(wire.shift());
          if (resp) resp.frames.forEach((f) => window.__app.onData(encode(f)));
        }, latencyMs);
      };
      window.__app.onData(encode(sim.screen()));
    },
    { src: SIM_SRC, total, firstComment: FIRST_COMMENT, latencyMs }
  );
}

// 開機 → 套 prefs → 進好讀 → 讀完整篇。read：'end'＝按 End（反向讀取，最快把整篇
// 累積進來）；'forward'＝一路捲到底讓預讀往後接（量前向累積用）。onReady 在進好讀
// 之後、開始累積之前呼叫（插量測用）。
async function openLongArticle(page, ptt, { total, prefs, read = 'end', onReady } = {}) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, Object.assign({ enableEasyReadingList: false }, prefs));
  await installLongArticleSim(page, { total });
  await page.waitForFunction(() => window.__app.buf.pageState === 3);
  await page.evaluate(() => window.__app.easyReading.enterEasyReading());
  await page.waitForFunction(() => window.__app.view.useEasyReadingMode && window.__app.buf.pageLines.length > 0);
  if (onReady) await onReady();
  if (read === 'end') {
    await page.keyboard.press('End');
  } else {
    // 讀者一路停在文末：預讀照常往後接（程式設 scrollTop，瀏覽器自己發 scroll 事件）。
    await page.evaluate(() => {
      const m = document.querySelector('.main');
      const stick = () => {
        if (window.__app.easyReading.easyReadingReachedPageEnd) return;
        m.scrollTop = m.scrollHeight;
        requestAnimationFrame(stick);
      };
      requestAnimationFrame(stick);
    });
  }
  await page.waitForFunction(
    () => !window.__app.easyReading._reverse && window.__app.easyReading.easyReadingReachedPageEnd,
    null, { timeout: 120000 }
  );
}

module.exports = { installLongArticleSim, openLongArticle, FIRST_COMMENT };
