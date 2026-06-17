import { detectFixableUrls } from '../../src/js/url_fix';

const fixedOf = text => detectFixableUrls(text).map(f => f.fixed);

describe('detectFixableUrls — repairs the 5 broken sample lines', () => {
  test('spaces around dots → collapsed', () => {
    expect(fixedOf('這裡有個多空白的連結：https://www . google .com/ 應該要被修好。'))
      .toEqual(['https://www.google.com/']);
  });

  test('missing scheme + broken file extension → fixed', () => {
    expect(fixedOf('這裡有個少 https 且副檔名斷開的圖片：www.example.com/someimage. png 請自動開圖。'))
      .toEqual(['https://www.example.com/someimage.png']);
  });

  test('space between host and path → fixed', () => {
    expect(fixedOf('這裡路徑開頭有空白：example.com /badpath.jpg 測試。'))
      .toEqual(['https://example.com/badpath.jpg']);
  });

  test('broken host dot + path, no scheme → fixed', () => {
    expect(fixedOf('還有這種很機車的斷開：google .tw/page 看看能不能搞定。'))
      .toEqual(['https://google.tw/page']);
  });

  test('already-valid URL → NOT reported / not broken', () => {
    expect(detectFixableUrls('原本就好的連結 https://yahoo.com 則不應該被弄壞。')).toEqual([]);
  });
});

describe('detectFixableUrls — false-positive guards', () => {
  test('CJK sentence with full-width period → none', () => {
    expect(detectFixableUrls('測試。下一句也沒問題，這只是中文。')).toEqual([]);
  });

  test('version-like ASCII dotted numbers → none', () => {
    expect(detectFixableUrls('版本 3.5 比 2.1 好，更新到 10.2 了。')).toEqual([]);
  });

  test('bare "www" mention without TLD → none', () => {
    expect(detectFixableUrls('他在 www 上面找不到答案')).toEqual([]);
  });

  test('double-space gap is not merged across a real word boundary → none', () => {
    expect(detectFixableUrls('買 apple  com 股票')).toEqual([]);
  });

  test('non-allowlisted exotic TLD is conservatively skipped', () => {
    expect(detectFixableUrls('連到 foo .zzunderined/x 看看')).toEqual([]);
  });

  test('plain valid scheme-full URL is left alone (handled by uriRegEx)', () => {
    expect(detectFixableUrls('see http://a.com/b here')).toEqual([]);
  });

  test('bare domain MENTION in parentheses → not linked (發信站 line)', () => {
    expect(detectFixableUrls('※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4')).toEqual([]);
  });

  test('whole 發信站/文章網址 pair → only nothing or already-valid, no bare-domain fix', () => {
    expect(detectFixableUrls('※ 文章網址: https://www.ptt.cc/bbs/Stock/M.123.html')).toEqual([]);
  });

  test('space-less scheme-less deep link (has path) → fixed (worth auto-open)', () => {
    expect(fixedOf('參考 example.com/img.jpg 這個')).toEqual(['https://example.com/img.jpg']);
  });

  test('scheme-less image link + spaced variant on same row → one deduped fix', () => {
    expect(fixedOf('中文ASDF i.imgur.com/ajHklmb.jpeg  測是 https:// i.imgur.com/ ajHklmb .jpeg'))
      .toEqual(['https://i.imgur.com/ajHklmb.jpeg']);
  });
});

describe('detectFixableUrls — shape & dedupe', () => {
  test('dedupe identical fixed within a row', () => {
    expect(fixedOf('www . a .com 和 www . a .com')).toEqual(['https://a.com'].map(() => 'https://www.a.com'));
  });

  test('each result has original + fixed, fixed carries a scheme', () => {
    const r = detectFixableUrls('圖：www.example.com/someimage. png 開圖');
    expect(r.length).toBeGreaterThan(0);
    for (const { original, fixed } of r) {
      expect(typeof original).toBe('string');
      expect(typeof fixed).toBe('string');
      expect(fixed).toMatch(/^(?:https?|ftp|telnet):\/\//);
      expect(fixed).not.toMatch(/\s/);
    }
  });
});
