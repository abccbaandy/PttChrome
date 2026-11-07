// P61：手機上 PTT 問「選一個」時，底部導覽上方浮出可點的選項（components/MobileToolbar）。
// 點一下＝替使用者在 PTT 的輸入欄打那個字＋⏎，跟自己用鍵盤回答完全一樣。
//
// **只認固定字樣，認不出就不出現**（docs/mobile.md「提問選項」）。每一種提問的字樣都出自
// upstream pttbbs 原始碼（3rd_script/pttbbs，Big5）：
//
//   postType   mbbsd/bbs.c#do_post：row 21「種類：1.問題 2.建議 …」＋ getdata(…, "(1-%d或不選)",
//              tmp_title, 3, LCECHO)。種類名是看板自己的 FN_POSTTYPE（最多 8 個、%4.4s 截字），
//              所以從畫面讀，不寫死。打數字＋⏎；只按 ⏎＝不選。
//   replyTarget mbbsd/bbs.c#do_generalboardreply 的三種 getdata(b_lines - 1, …)：
//              「▲ 回應至 (F)看板 (M)作者信箱 (B)二者皆是 (Q)取消？[F] 」
//              「▲ 回應至 (F)看板 (Q)取消？[F] 」
//              「▲ 無法回應至看板。 改回應至 (M)作者信箱 (Q)取消？[Q] 」
//              整句比對（表 REPLY_PROMPTS），一個字不同就不出現。
//   editorSave mbbsd/edit.c#write_file：vs_hdr("檔案處理")、row 1「[S]發文 (T)改標題 (A)放棄 (E)繼續
//              (R/W/D)讀寫刪暫存檔」、getdata(2, 0, "確定要儲存檔案嗎？ ", ans, 2, LCECHO)。
//              S 的字依種類是儲存／發文／發信；(U)上傳資料、(T)改標題 看設定有沒有。
//              R/W/D（暫存檔）不放：手機上幾乎用不到，要用照樣自己打。
//   yesNo      vtuikit.c#vans／getdata 的是非題，提示結尾是 [y/N]、[Y/n]、(y/N)、(Y/N)？[N] 這幾種
//              寫法（mbbsd 全部的 y/n 提示都是這個格式；例 xyz.c 離站「您確定要離開【 … 】嗎(Y/N)？[N]」）。
//
// 面板放哪：anchor 'bottom'（提問在下半部）⇒ 終端機整個往上排、讓出面板高度（同按鍵面板），提問列
// 才不會被蓋；'top'（提問在上半部，例：編輯器檔案處理在第 2 列）⇒ 不讓位，面板只蓋到下半部，
// 否則往上排會把提問推進 App Bar 後面。
//
// 共同條件：游標在 PTT 的輸入欄上（term_buf.isCursorOnInputField，vgetstring 的反白欄）、
// 而且欄位還是空的——使用者自己打了一半，就不替他加字。
// vgets 一律要 ⏎ 才收（vtuikit.c#vgetstring），所以送「字＋⏎」。

const REPLY_PROMPTS = Object.freeze([
  {
    text: '▲ 回應至 (F)看板 (M)作者信箱 (B)二者皆是 (Q)取消？[F]',
    items: [['f', '看板'], ['m', '作者信箱'], ['b', '二者皆是'], ['q', '取消']],
    def: 'f'
  },
  {
    text: '▲ 回應至 (F)看板 (Q)取消？[F]',
    items: [['f', '看板'], ['q', '取消']],
    def: 'f'
  },
  {
    text: '▲ 無法回應至看板。 改回應至 (M)作者信箱 (Q)取消？[Q]',
    items: [['m', '作者信箱'], ['q', '取消']],
    def: 'q'
  }
]);

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function item(send, label, opts) {
  const o = opts || {};
  return {
    send: send,
    // 按鈕上顯示的鍵（大寫字母、數字；空字串＝只按 ⏎）
    key: send ? send.toUpperCase() : '',
    label: label || '',
    labelKey: o.labelKey || '',
    isDefault: !!o.isDefault
  };
}

// 「種類：1.問題 2.建議 … 8.公告 (1-8或不選)」→ [{n, label}]；格式不符回 null。
// 種類名可能是英文或含空白（%4.4s 右靠補空白），所以照順序找「j.」，不用 split。
export function parsePostTypes(promptText) {
  const t = String(promptText || '');
  const m = /種類：(.*)\(1-([1-8])或不選\)\s*$/.exec(t);
  if (!m) return null;
  const body = m[1];
  const n = Number(m[2]);
  const out = [];
  let pos = 0;
  for (let j = 1; j <= n; ++j) {
    const tag = j + '.';
    const at = j === 1 ? body.indexOf(tag) : body.indexOf(' ' + tag, pos);
    if (at < 0) return null;
    const start = (j === 1 ? at : at + 1) + tag.length;
    if (j === 1 && body.slice(0, at).trim() !== '') return null;
    let end = body.length;
    if (j < n) {
      end = body.indexOf(' ' + (j + 1) + '.', start);
      if (end < 0) return null;
    }
    const label = body.slice(start, end).trim();
    if (!label) return null;
    out.push({ n: j, label: label });
    pos = end;
  }
  return out;
}

const YES_NO_RE = /^(.*?)\s*[[(]([yY])\/([nN])[\])]\s*[？?]?\s*(?:\[([YyNn])\])?\s*[:：]?\s*$/;

// facts：{ promptText, fieldText, cursorRow, rows, rowTexts }（promptChoiceFacts 從 buf 取）。
// 回 null（不出現）或 { kind, title, titleKey, anchor, items: [{ send, key, label, labelKey, isDefault }] }。
export function promptChoices(facts) {
  const c = recognize(facts);
  if (!c) return null;
  const rows = facts.rows > 0 ? facts.rows : 24;
  c.anchor = facts.cursorRow < rows / 2 ? 'top' : 'bottom';
  return c;
}

function recognize(facts) {
  if (!facts || facts.fieldText !== '') return null; // 不在輸入欄、或已經打了字
  const prompt = norm(facts.promptText);
  if (!prompt) return null;
  const rows = facts.rowTexts || [];

  const types = parsePostTypes(facts.promptText);
  if (types) {
    return {
      kind: 'postType',
      title: '',
      titleKey: 'promptChoices_postType',
      items: types.map((t) => item(String(t.n), t.label)).concat([
        item('', '', { labelKey: 'promptChoices_none', isDefault: true })
      ])
    };
  }

  for (const r of REPLY_PROMPTS) {
    if (prompt !== r.text) continue;
    return {
      kind: 'replyTarget',
      title: prompt.replace(/\s*\(.*$/, '').replace(/^▲\s*/, ''),
      titleKey: '',
      items: r.items.map((p) => item(p[0], p[1], { isDefault: p[0] === r.def }))
    };
  }

  if (prompt === '確定要儲存檔案嗎？' && facts.cursorRow === 2 &&
      norm(rows[0]).indexOf('檔案處理') >= 0) {
    const m = /^[[(]S[\])](儲存|發文|發信)( \(U\)上傳資料)?( \(T\)改標題)? \(A\)放棄 \(E\)繼續 \(R\/W\/D\)讀寫刪暫存檔$/
      .exec(norm(rows[1]));
    if (m) {
      const items = [item('s', m[1], { isDefault: true })];
      if (m[3]) items.push(item('t', '改標題'));
      items.push(item('a', '放棄'), item('e', '繼續編輯'));
      return { kind: 'editorSave', title: prompt, titleKey: '', items: items };
    }
    return null;
  }

  const yn = YES_NO_RE.exec(prompt);
  if (yn) {
    let def = yn[4] ? yn[4].toLowerCase() : '';
    if (!def) {
      const yUp = yn[2] === 'Y';
      const nUp = yn[3] === 'N';
      if (yUp !== nUp) def = yUp ? 'y' : 'n';
    }
    const title = yn[1].trim();
    if (!title) return null;
    return {
      kind: 'yesNo',
      title: title,
      titleKey: '',
      items: [
        item('y', '', { labelKey: 'promptChoices_yes', isDefault: def === 'y' }),
        item('n', '', { labelKey: 'promptChoices_no', isDefault: def === 'n' })
      ]
    };
  }
  return null;
}

// 從 TermBuf 取本幀事實（每次現算，不快取：提問是「畫面剛變出來」的東西）。
export function promptChoiceFacts(buf) {
  if (!buf || typeof buf.inputFieldText !== 'function') return null;
  const fieldText = buf.inputFieldText();
  if (fieldText === null) return null;
  return {
    promptText: buf.inputPromptText(),
    fieldText: fieldText,
    cursorRow: buf.cur_y,
    rows: buf.rows,
    rowTexts: [buf.getRowText(0, 0, buf.cols), buf.getRowText(1, 0, buf.cols)]
  };
}

export function promptChoicesFromBuf(buf) {
  return promptChoices(promptChoiceFacts(buf));
}

// 兩次結果是不是同一組選項（工具列 context 比對、點下去前再驗一次都用它）。
export function promptChoicesSig(c) {
  if (!c) return '';
  return c.kind + '|' + c.anchor + '|' + c.title + '|' + c.titleKey + '|' +
    c.items.map((i) => i.send + ':' + i.label + ':' + i.labelKey + (i.isDefault ? '*' : '')).join(',');
}
