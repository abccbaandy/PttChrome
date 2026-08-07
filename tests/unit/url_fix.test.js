import { detectFixableUrls } from '../../src/js/url_fix';

const fixedOf = text => detectFixableUrls(text).map(f => f.fixed);
const grayOf = text => detectFixableUrls(text).map(f => f.gray);

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

describe('detectFixableUrls — path 後單一空白 + 純數字尾段（X status ID 型態）', () => {
  test('slash 後空白 + 數字 ID → 修好', () => {
    expect(fixedOf('https://x.com/i/status/ 1933827730166178100'))
      .toEqual(['https://x.com/i/status/1933827730166178100']);
  });

  test('行尾帶多餘空白的變體 → 修好', () => {
    expect(fixedOf('https://x.com/i/status/ 1917164977988997361 '))
      .toEqual(['https://x.com/i/status/1917164977988997361']);
  });

  test('數字尾段後的第二個數字段不被併入', () => {
    expect(fixedOf('version https://a.com/ 123 456'))
      .toEqual(['https://a.com/123']);
  });

  test('slash 後空白 + 英文單字 → 不修（散文）', () => {
    expect(detectFixableUrls('see https://site.com/ here')).toEqual([]);
  });

  test('雙空白 + 數字 → 不併（真正的字距）', () => {
    expect(detectFixableUrls('看 https://a.com/  123 這個')).toEqual([]);
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

// 使用者回報：英文散文的「句號＋句首單字」與「作者打斷的裸網域」同形，因為
// it/in/to/me/us/be/la 這些 ccTLD 剛好也是英文單字。這類候選一律標 gray，消費端
// （Screen.jsx）預設不修，只有裝置端 AI 複核放行才會出現。
describe('detectFixableUrls — 句號誤判標成 gray（消費端預設不修）', () => {
  test('Call of Duty. It does not → gray', () => {
    const text = 'The goal was to match a modern Call of Duty. It does not.';
    expect(fixedOf(text)).toEqual(['https://Duty.It']);
    expect(grayOf(text)).toEqual([true]);
  });

  test('句號後接 In / To 也是同一類', () => {
    expect(grayOf('That was the best part. In fact I watched it twice.')).toEqual([true]);
    expect(grayOf('He never replied. To be fair he was busy.')).toEqual([true]);
  });

  test('縮寫加句號（the U.S. It was）同樣是 gray', () => {
    expect(grayOf('It happened in the U.S. It was on the news.')).toEqual([true]);
  });

  test('真的被打斷、但沒有路徑的裸網域也是 gray（形狀分不出來）', () => {
    expect(fixedOf('官網在這 www . a .com 記得去看')).toEqual(['https://www.a.com']);
    expect(grayOf('官網在這 www . a .com 記得去看')).toEqual([true]);
  });
});

describe('detectFixableUrls — 有 scheme 或有路徑者不受 AI 閘門影響（gray=false）', () => {
  test.each([
    ['https://www . google .com/ 應該要被修好', 'https://www.google.com/'],
    ['www.example.com/someimage. png 請自動開圖', 'https://www.example.com/someimage.png'],
    ['example.com /badpath.jpg 測試', 'https://example.com/badpath.jpg'],
    ['google .tw/page 看看', 'https://google.tw/page'],
    ['參考 example.com/img.jpg 這個', 'https://example.com/img.jpg'],
    ['https://x.com/i/status/ 1933827730166178100', 'https://x.com/i/status/1933827730166178100'],
  ])('%s', (text, fixed) => {
    expect(fixedOf(text)).toEqual([fixed]);
    expect(grayOf(text)).toEqual([false]);
  });
});

describe('detectFixableUrls — shape & dedupe', () => {
  test('dedupe identical fixed within a row', () => {
    expect(fixedOf('www . a .com 和 www . a .com')).toEqual(['https://a.com'].map(() => 'https://www.a.com'));
  });

  test('each result has original + fixed + host + gray, fixed carries a scheme', () => {
    const r = detectFixableUrls('圖：www.example.com/someimage. png 開圖');
    expect(r.length).toBeGreaterThan(0);
    for (const { original, fixed, host, gray } of r) {
      expect(typeof original).toBe('string');
      expect(typeof fixed).toBe('string');
      expect(typeof gray).toBe('boolean');
      expect(fixed).toMatch(/^(?:https?|ftp|telnet):\/\//);
      expect(fixed).not.toMatch(/\s/);
      expect(host).toBe('www.example.com');
    }
  });

  test('host 去掉 scheme、路徑與 port，並轉小寫', () => {
    expect(detectFixableUrls('看 Example.COM /a.jpg 這個')[0].host).toBe('example.com');
    expect(detectFixableUrls('連 a.com:8080 /x.png 看看')[0].host).toBe('a.com');
  });
});
