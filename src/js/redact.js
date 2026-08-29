// 瀏覽器版隱私遮蔽 util（自 tests/e2e/tools/record-cassette.spec.js 的
// redactUser/redactIPs 移植，去 Buffer/env 依賴）。輸入輸出皆 latin1/一般字串，
// 等長替換 → byte/欄位對齊不變。debug 錄製下載前套用。
// **隱私遮蔽的唯一真相源**：cassette 錄製器（tests/e2e/tools/record-cassette.spec.js）
// 也 require 這裡，不得自帶第二份實作（守護 tests/unit/redact.test.js）。

// 等長遮蔽指定 id（防登入帳號 / 狀態列「我是<id>」洩漏）。
// 手動掃描而非單純 regex：id 是 ASCII token，右邊界須為「非英數 / 字串結尾」；
// 左邊界為「非英數 / 字串開頭」，或「Big5 尾位元組」——後者關鍵：「我是<id>」裡
// id 緊貼中文字的尾位元組可能像字母（如「是」0xAC4F 的 0x4F='O'），故再認
// 「前一位元組在 0x40-0x7E 且其前一位元組 ≥0x80(Big5 lead)」也算邊界。
export function redactUser(str, user) {
  if (!user || user === 'guest') return str;
  const isAlnum = (c) => c !== undefined && /[0-9A-Za-z]/.test(c);
  const u = user.toLowerCase();
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (str.substr(i, user.length).toLowerCase() === u) {
      const rightOk = !isAlnum(str[i + user.length]); // 含 undefined(結尾)
      const prev = str[i - 1];
      let leftOk = !isAlnum(prev); // 含 undefined(開頭)
      if (!leftOk) {
        const p = prev.charCodeAt(0);
        const p2 = str[i - 2];
        if (p >= 0x40 && p <= 0x7e && p2 !== undefined && p2.charCodeAt(0) >= 0x80)
          leftOk = true; // Big5 尾位元組
      }
      if (rightOk && leftOk) {
        out += 'x'.repeat(user.length);
        i += user.length;
        continue;
      }
    }
    out += str[i++];
  }
  return out;
}

// 遮 IPv4（「※ 發信站: …, 來自: <IP>」屬個資）。等長替換保欄位對齊。
export function redactIPs(str) {
  return str.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (m) => 'x'.repeat(m.length));
}

// 密碼等機密字串：不做邊界判斷，凡出現即等長遮蔽（密碼可能緊貼任何字元）。
export function redactSecret(str, secret) {
  if (!secret) return str;
  let out = str;
  let idx;
  while ((idx = out.indexOf(secret)) >= 0) {
    out = out.slice(0, idx) + 'x'.repeat(secret.length) + out.slice(idx + secret.length);
  }
  return out;
}

// 對一段文字套用所有遮蔽：id 列表（邊界式）＋ secret 列表（無邊界）＋ IPv4。
export function scrub(str, ids = [], secrets = []) {
  let out = str;
  for (const id of ids) out = redactUser(out, id);
  for (const s of secrets) out = redactSecret(out, s);
  return redactIPs(out);
}
