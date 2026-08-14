// issue #22 的靜態守護：終端機外層一旦出現 user-select: none，Firefox 的
// Selection.toString() 就會對整個終端機回傳空字串（選取自動複製寫進空字串、右鍵快速
// 搜尋關鍵字是空的、^C 複製空的），Chrome 卻完全正常 —— 沒裝 Firefox 的人改了也看不出來。
//
// 真行為守護在 tests/e2e/offline/selection.offline.spec.js（offline-firefox project）；
// 這裡只擋「有人手滑把那行加回去」，不需要瀏覽器。
import fs from 'node:fs';
import path from 'node:path';

const CSS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'css', 'main.css'),
  'utf8'
);

// 取某個選擇器的宣告區塊（註解會被先剝掉，才不會把註解裡的說明當成宣告）。
const ruleBody = (css, selector) => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = new RegExp(
    `(^|[},])\\s*${selector.replace(/[.#*]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'm'
  );
  const m = stripped.match(re);
  if (!m) throw new Error(`main.css 找不到規則 ${selector}`);
  return m[2];
};

const userSelectValues = (body) =>
  [...body.matchAll(/(?:-webkit-|-moz-|-ms-)?user-select\s*:\s*([\w-]+)/g)].map(
    (m) => m[1]
  );

describe('終端機的 user-select（issue #22）', () => {
  test('#BBSWindow 不得宣告 user-select（none 會讓 Firefox 的選取序列化成空字串）', () => {
    expect(userSelectValues(ruleBody(CSS, '#BBSWindow'))).toEqual([]);
  });

  test('.main 保有 user-select: text（標準屬性，不可只留 -webkit- 前綴）', () => {
    const values = userSelectValues(ruleBody(CSS, '.main, #easyReadingLastRow, #easyReadingReplyRow'));
    expect(values).toContain('text');
    expect(values).not.toContain('none');
  });
});
