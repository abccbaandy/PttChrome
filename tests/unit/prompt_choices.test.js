// @unit-env browser
// P61 手機提問選項（src/js/prompt_choices.js）：畫面由 upstream pttbbs 原始碼產生
// （tools/ptt-src-screens），經 app 自己的 AnsiParser → TermBuf，再跑認法。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import {
  promptChoices,
  promptChoicesFromBuf,
  promptChoicesSig,
  promptPanelFromBuf,
  parsePostTypes,
} from "../../src/js/prompt_choices";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import postFlowFx from "./fixtures/ptt_src_screens/post_flow.json";
import replyPromptFx from "./fixtures/ptt_src_screens/reply_prompt.json";
import editorFx from "./fixtures/ptt_src_screens/editor.json";
import goodbyeFx from "./fixtures/ptt_src_screens/goodbye.json";
import editorPromptFx from "./fixtures/ptt_src_screens/editor_prompt.json";
import searchPromptsFx from "./fixtures/ptt_src_screens/search_prompts.json";
import boardCompleteFx from "./fixtures/ptt_src_screens/board_complete.json";
import articlePromptsFx from "./fixtures/ptt_src_screens/article_prompts.json";
import articleListFx from "./fixtures/ptt_src_screens/article_list.json";
import aidMissFx from "./fixtures/ptt_src_screens/aid_miss.json";
import activitySlowFx from "./fixtures/ptt_src_screens/activity_slow.json";
import boardNoteFx from "./fixtures/ptt_src_screens/board_note.json";

beforeAll(() => loadBig5Tables());

function screenAt(fx, name) {
  const idx = fx.frames.findIndex((f) => f.name === name);
  if (idx < 0) throw new Error(`fixture 沒有名為 ${name} 的幀`);
  const buf = new TermBuf(fx.cols, fx.rows);
  buf.setView({ update() {}, updateCursorPos() {}, refreshCursorVisibility() {}, blinkOn: false });
  buf.useMouseBrowsing = false;
  const parser = new AnsiParser(buf);
  for (let i = 0; i <= idx; ++i) {
    parser.feed(fx.frames[i].bytes);
    if (i < idx) buf.notify();
  }
  buf.notify();
  clearTimeout(buf.timerUpdate);
  if (buf._settleTimer) clearTimeout(buf._settleTimer);
  return buf;
}

// 在輸入欄裡打字（模擬 PTT 的回顯：字寫進反白欄、游標右移）。
function typeInField(buf, ch) {
  const parser = new AnsiParser(buf);
  parser.feed("\x1b[30;47m" + ch);
}

const summary = (c) => c && c.items.map((i) => (i.key || "⏎") + (i.label ? " " + i.label : "") + (i.isDefault ? "*" : ""));

describe("upstream 產的提問畫面", () => {
  test("發文種類：讀出看板自己的 8 種＋不選（⏎）", () => {
    const c = promptChoicesFromBuf(screenAt(postFlowFx, "post"));
    expect(c.kind).toBe("postType");
    expect(summary(c)).toEqual([
      "1 問題", "2 建議", "3 討論", "4 心得", "5 閒聊", "6 請益", "7 情報", "8 公告", "⏎*",
    ]);
    expect(c.items.map((i) => i.send).join(",")).toBe("1,2,3,4,5,6,7,8,");
  });

  test("回文對象：F/M/B/Q，預設 F", () => {
    const c = promptChoicesFromBuf(screenAt(replyPromptFx, "reply"));
    expect(c.kind).toBe("replyTarget");
    expect(c.title).toBe("回應至");
    expect(summary(c)).toEqual(["F 看板*", "M 作者信箱", "B 二者皆是", "Q 取消"]);
  });

  test("編輯器檔案處理：S 發文（預設）／T 改標題／A 放棄／E 繼續編輯", () => {
    const c = promptChoicesFromBuf(screenAt(editorFx, "save-menu"));
    expect(c.kind).toBe("editorSave");
    expect(c.items[0].isDefault).toBe(true);
    expect(c.items.map((i) => i.send).join(",")).toMatch(/^s,(t,)?a,e$/);
    expect(c.items[0].label).toMatch(/^(儲存|發文|發信)$/);
  });

  test("離站確認（Y/N）？[N]：是／否，預設否；標題是提問本身", () => {
    const c = promptChoicesFromBuf(screenAt(goodbyeFx, "confirm"));
    expect(c.kind).toBe("yesNo");
    expect(c.title).toMatch(/^您確定要離開【.*】嗎$/);
    expect(c.items.map((i) => i.send + (i.isDefault ? "*" : ""))).toEqual(["y", "n*"]);
  });

  test("面板放哪：提問在下半部 ⇒ bottom（終端機讓位）；編輯器檔案處理在第 2 列 ⇒ top（不讓位）", () => {
    expect(promptChoicesFromBuf(screenAt(postFlowFx, "post")).anchor).toBe("bottom");
    expect(promptChoicesFromBuf(screenAt(replyPromptFx, "reply")).anchor).toBe("bottom");
    expect(promptChoicesFromBuf(screenAt(goodbyeFx, "confirm")).anchor).toBe("bottom");
    expect(promptChoicesFromBuf(screenAt(editorFx, "save-menu")).anchor).toBe("top");
  });

  test("不是選擇題的畫面不出現：列表、文章、離站前的主選單、編輯器搜尋 prompt", () => {
    expect(promptChoicesFromBuf(screenAt(postFlowFx, "list"))).toBeNull();
    expect(promptChoicesFromBuf(screenAt(replyPromptFx, "article"))).toBeNull();
    expect(promptChoicesFromBuf(screenAt(goodbyeFx, "menu"))).toBeNull();
    expect(promptChoicesFromBuf(screenAt(editorFx, "edit"))).toBeNull();
    for (const f of editorPromptFx.frames)
      expect(promptChoicesFromBuf(screenAt(editorPromptFx, f.name)), f.name).toBeNull();
  });

  test("使用者已經在欄位裡打了字 ⇒ 不出現（不替他加字）", () => {
    for (const [fx, name] of [[postFlowFx, "post"], [replyPromptFx, "reply"], [goodbyeFx, "confirm"]]) {
      const buf = screenAt(fx, name);
      expect(promptChoicesFromBuf(buf), name).not.toBeNull();
      typeInField(buf, "x");
      expect(promptChoicesFromBuf(buf), name).toBeNull();
    }
  });
});

describe("字樣比對：認不出就不出現", () => {
  const facts = (promptText, extra) => Object.assign({ promptText, fieldText: "", cursorRow: 22, rowTexts: ["", ""] }, extra);

  test("發文種類：看板自訂的種類名（英文、少於 8 個）", () => {
    expect(parsePostTypes("種類：1.  QA 2.Talk 3.新聞 (1-3或不選)")).toEqual([
      { n: 1, label: "QA" }, { n: 2, label: "Talk" }, { n: 3, label: "新聞" },
    ]);
    expect(summary(promptChoices(facts("種類：1.問 (1-1或不選)")))).toEqual(["1 問", "⏎*"]);
  });

  test("發文種類：編號跳號、數量對不上、沒有「種類：」⇒ null", () => {
    expect(parsePostTypes("種類：1.問題 3.討論 (1-2或不選)")).toBeNull();
    expect(parsePostTypes("種類：1.問題 2.建議 (1-3或不選)")).toBeNull();
    expect(parsePostTypes("1.問題 2.建議 (1-2或不選)")).toBeNull();
    expect(parsePostTypes("種類：1. 2.建議 (1-2或不選)")).toBeNull();
  });

  test("回文：三種固定字樣都認得；改一個字就不認", () => {
    expect(summary(promptChoices(facts("▲ 回應至 (F)看板 (Q)取消？[F] ")))).toEqual(["F 看板*", "Q 取消"]);
    expect(summary(promptChoices(facts("▲ 無法回應至看板。 改回應至 (M)作者信箱 (Q)取消？[Q] ")))).toEqual([
      "M 作者信箱", "Q 取消*",
    ]);
    expect(promptChoices(facts("▲ 回應至 (F)看板 (X)別的 (Q)取消？[F] "))).toBeNull();
  });

  test("編輯器檔案處理：標題列不是「檔案處理」、選項列格式不符、不在第 2 列 ⇒ null", () => {
    const ok = { cursorRow: 2, rowTexts: ["【 檔案處理 】", "[S]儲存 (A)放棄 (E)繼續 (R/W/D)讀寫刪暫存檔"] };
    expect(summary(promptChoices(facts("確定要儲存檔案嗎？ ", ok)))).toEqual(["S 儲存*", "A 放棄", "E 繼續編輯"]);
    // upstream be3ce30：V 也是存檔，row 1 寫成 [S/V]（新舊並存都要認）
    const sv = { ...ok, rowTexts: [ok.rowTexts[0], "[S/V]發文 (T)改標題 (A)放棄 (E)繼續 (R/W/D)讀寫刪暫存檔"] };
    expect(summary(promptChoices(facts("確定要儲存檔案嗎？ ", sv)))).toEqual([
      "S 發文*", "T 改標題", "A 放棄", "E 繼續編輯",
    ]);
    expect(promptChoices(facts("確定要儲存檔案嗎？ ", { ...ok, rowTexts: ["別的", ok.rowTexts[1]] }))).toBeNull();
    expect(promptChoices(facts("確定要儲存檔案嗎？ ", { ...ok, rowTexts: [ok.rowTexts[0], "(S)存檔 (Z)別的"] }))).toBeNull();
    expect(promptChoices(facts("確定要儲存檔案嗎？ ", { ...ok, cursorRow: 5 }))).toBeNull();
  });

  test("是非題：各種寫法與預設", () => {
    const def = (p) => promptChoices(facts(p)).items.filter((i) => i.isDefault).map((i) => i.send).join("");
    expect(def("確定要離開嗎? [y/N]: ")).toBe("n");
    expect(def("要使用小天使匿名回覆嗎？ [Y/n]: ")).toBe("y");
    expect(def("要將文章鎖定嗎(y/N)?")).toBe("n");
    expect(def("您確定要離開【 批踢踢實業坊 】嗎(Y/N)？[N] ")).toBe("n");
    expect(def("你確定嗎 (Y/N)")).toBe("");
    expect(promptChoices(facts("確定要離開嗎? [y/N]: ")).title).toBe("確定要離開嗎?");
  });

  test("是非題字樣不在結尾、只有括號沒有題目、或欄位不是空的 ⇒ null", () => {
    expect(promptChoices(facts("(y/N) 之後還有字："))).toBeNull();
    expect(promptChoices(facts("[y/N]: "))).toBeNull();
    expect(promptChoices(facts("確定嗎? [y/N]: ", { fieldText: "y" }))).toBeNull();
    expect(promptChoices(facts("確定嗎? [y/N]: ", { fieldText: null }))).toBeNull();
    expect(promptChoices(null)).toBeNull();
  });

  test("sig：同一組選項相同、不同提問不同", () => {
    const a = promptChoices(facts("確定要離開嗎? [y/N]: "));
    const b = promptChoices(facts("確定要離開嗎? [y/N]: "));
    const c = promptChoices(facts("確定要刪除嗎? [y/N]: "));
    expect(promptChoicesSig(a)).toBe(promptChoicesSig(b));
    expect(promptChoicesSig(a)).not.toBe(promptChoicesSig(c));
    expect(promptChoicesSig(null)).toBe("");
  });
});

// P62（開鍵盤輸入）／P63（繼續）：同一個面板的另外兩種內容。
describe("promptPanelFromBuf（P61＋P62＋P63）", () => {
  const ALL = { mobilePromptChoices: true, mobilePromptKeyboard: true, mobileAnyKeyContinue: true };
  const shape = (c) =>
    c && {
      kind: c.kind,
      anchor: c.anchor,
      title: c.title,
      items: c.items.map((i) => [i.labelKey || i.label, i.action || JSON.stringify(i.send), i.enter]),
    };

  test("P61 認得的選擇題優先；P61 關掉才退成「開鍵盤輸入」", () => {
    const buf = screenAt(goodbyeFx, "confirm");
    expect(promptPanelFromBuf(buf, ALL).kind).toBe("yesNo");
    const p = promptPanelFromBuf(buf, { ...ALL, mobilePromptChoices: false });
    expect(p.kind).toBe("typeInput");
    // 預設 [N]：空答案＝不做（screen_dismiss.emptyAnswerCommits false）⇒ ^C 取消安全，放取消。
    expect(p.items.map((i) => i.labelKey)).toEqual(["promptChoices_keyboard", "promptChoices_cancel"]);
  });

  test("搜尋標題：開鍵盤（不送 byte）＋取消（^C、不補 ⏎），標題是提問本身", () => {
    expect(shape(promptPanelFromBuf(screenAt(searchPromptsFx, "title"), ALL))).toEqual({
      kind: "typeInput",
      anchor: "bottom",
      title: "搜尋標題:",
      items: [
        ["promptChoices_keyboard", "keyboard", true],
        ["promptChoices_cancel", JSON.stringify("\x03"), false],
      ],
    });
  });

  test("選看板（提問在上半部）⇒ anchor top；打了字也還在（只是開鍵盤，不替人加字）", () => {
    expect(promptPanelFromBuf(screenAt(boardCompleteFx, "board"), ALL).anchor).toBe("top");
    expect(promptPanelFromBuf(screenAt(boardCompleteFx, "typed"), ALL).kind).toBe("typeInput");
  });

  test("空答案也會做事的提問（pmore 搜尋沿用上次關鍵字）⇒ 只有開鍵盤，不放取消", () => {
    const p = promptPanelFromBuf(screenAt(articlePromptsFx, "search"), ALL);
    expect(p.items.map((i) => i.labelKey)).toEqual(["promptChoices_keyboard"]);
  });

  test("請按任意鍵繼續（離站、AID 找不到、限速通知）⇒ 繼續＝空白、不補 ⏎", () => {
    for (const [fx, name, anchor] of [
      [goodbyeFx, "pause", "bottom"],
      [aidMissFx, "not-found", "bottom"],
      [activitySlowFx, "read-slow", "top"],
    ]) {
      expect(shape(promptPanelFromBuf(screenAt(fx, name), ALL)), name).toEqual({
        kind: "anyKey",
        anchor,
        title: "",
        items: [["promptChoices_continue", JSON.stringify(" "), false]],
      });
    }
  });

  test("整頁通知（字在最上面、下面空白）⇒「繼續」不讓位，標題與理由不被推進 App Bar 後面", () => {
    for (const [fx, name] of [[activitySlowFx, "board-slow"], [activitySlowFx, "read-slow"], [boardNoteFx, "note"]])
      expect(promptPanelFromBuf(screenAt(fx, name), ALL).anchor, name).toBe("top");
    // 列表上的 vmsg：整頁都是字 ⇒ 照舊讓位（橫幅那列才看得到）
    expect(promptPanelFromBuf(screenAt(aidMissFx, "not-found"), ALL).anchor).toBe("bottom");
  });

  test("一般列表沒有提問 ⇒ null", () => {
    expect(promptPanelFromBuf(screenAt(articleListFx, "list"), ALL)).toBeNull();
  });

  test("各自的開關關掉就不出現", () => {
    const none = { mobilePromptChoices: false, mobilePromptKeyboard: false, mobileAnyKeyContinue: false };
    expect(promptPanelFromBuf(screenAt(searchPromptsFx, "title"), { ...ALL, mobilePromptKeyboard: false })).toBeNull();
    expect(promptPanelFromBuf(screenAt(goodbyeFx, "pause"), { ...ALL, mobileAnyKeyContinue: false })).toBeNull();
    expect(promptPanelFromBuf(screenAt(goodbyeFx, "confirm"), none)).toBeNull();
    expect(promptPanelFromBuf(null, ALL)).toBeNull();
  });

  test("sig 分得出三種面板、也分得出送不送 ⏎", () => {
    const a = promptPanelFromBuf(screenAt(searchPromptsFx, "title"), ALL);
    const b = promptPanelFromBuf(screenAt(goodbyeFx, "pause"), ALL);
    const c = promptPanelFromBuf(screenAt(goodbyeFx, "confirm"), ALL);
    const sigs = new Set([a, b, c].map(promptChoicesSig));
    expect(sigs.size).toBe(3);
    expect(promptChoicesSig(a)).toBe(promptChoicesSig(promptPanelFromBuf(screenAt(searchPromptsFx, "title"), ALL)));
  });
});
