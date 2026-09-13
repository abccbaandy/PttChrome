// DEC 2026 Synchronized Output（BSU/ESU）＝ **只擋畫面，不碰 settle**。
//
// 為什麼要做：PTT 2026-09 起 `mbbsd/pfterm.c` 把整個 `doupdate()` 包在
// `ESC[?2026h` … `ESC[?2026l` 之間（commit 961c6239）。一幀畫面若被 WebSocket
// 切成好幾塊送達，我們的 30ms `queueUpdate` debounce 會在中途先畫一次半幀
// ＝畫面撕裂。BSU/ESU 給了 server 明講的幀邊界，用它把中途那次畫面壓掉。
//
// 為什麼**不**拿 ESU 當 settle（這是本設計最重要的一條，別「優化」掉）：
//   1. 一個 logical page 對應**多個** `doupdate()`：mbbsd 有 51 處 `refresh()`，
//      而且 `dogetch()` 每次回去等按鍵前都會再叫一次（mbbsd/io.c:451-452）。
//   2. 且存在**零內容的 ESU**：`!ft.dirty` 早退路徑照樣吐完整 BSU/ESU 對
//      （pfterm.c:824-829）。⇒ ESU 的常態語意是「server 回去等鍵了」，
//      **不是**「這一頁畫完了」。
//   讓 ESU 推進 settle，`command_queue` 的 expect 會被空 frame 餵掉
//   （破 docs/easy-reading-list.md 不變量 2）。反過來「延遲」永遠安全：
//   docs/easy-reading.md 明載危險方向是**過早** settle。
//
// 「BSU 期間不 settle」不需要另外寫：settle 只在 `notify()` 武裝，而我們是在
// `queueUpdate()` 擋住 notify ⇒ BSU 期間的 server 寫入自然不武裝。
//
// 掛點刻意選 `queueUpdate()` 而不是 `notify()`：`queueUpdate` 是**所有 server
// 寫入路徑**的共同出口，而 `notify()` 另有**本地重繪**直呼者（easy_reading /
// list_session / board_list_session 的 _forceRedraw 系列）。本地重繪不可以被
// server 的 BSU 擋住。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";
const BSU = ESC + "[?2026h";
const ESU = ESC + "[?2026l";

function makeBuf() {
  const buf = new TermBuf(80, 24);
  const updates = [];
  buf.setView({
    update() {
      updates.push(buf.cur_y);
    },
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  buf._testUpdates = updates;
  return buf;
}

function row(buf, r) {
  return buf.getRowText(r, 0, buf.cols).replace(/\s+$/, "");
}

// 產生第 n 列（1-based）的內容寫入。
function paintRow(n) {
  return ESC + "[" + n + ";1H" + "ROW" + String(n).padStart(2, "0");
}
function paintRows(from, to) {
  let s = "";
  for (let n = from; n <= to; ++n) s += paintRow(n);
  return s;
}

describe("TermBuf DEC 2026 synchronized update", () => {
  beforeAll(() => {
    loadBig5Tables();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 本體：一幀被切兩塊送達時，BSU 必須壓掉中途那次重繪。
  test("跨 feed 的 BSU 擋住中途重繪，ESU 後一次到齊", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);

    parser.feed(BSU + paintRows(1, 12));
    vi.advanceTimersByTime(100); // 遠超過 30ms debounce
    expect(buf._testUpdates.length).toBe(0); // 半幀一次都不准畫
    expect(buf.changed).toBe(true); // 但內容確實已經寫進 buffer

    parser.feed(paintRows(13, 24) + ESU);
    vi.advanceTimersByTime(10);
    expect(buf._testUpdates.length).toBe(1); // 一次到齊
    expect(row(buf, 0)).toBe("ROW01");
    expect(row(buf, 23)).toBe("ROW24");
  });

  // 對照組：沒有 BSU/ESU 就會畫半幀（證明上面那條測到的是真東西）。
  test("對照組：沒有 BSU/ESU 時中途就會畫出半幀", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);

    parser.feed(paintRows(1, 12));
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(1); // 半幀被畫出來了
  });

  // 這一對是 DEC 2026 對**正確性**（不只是視覺）的實際好處，成對出現才有意義。
  //
  // 閘門擋的是 queueUpdate，而 `_armSettleTimer()` 的唯一呼叫點在 notify() 裡
  // ⇒ BSU 期間 server 的寫入既不重繪、**也不武裝 settle**。
  // 這正好消掉協定文件不變量 P6 那一類危險：「半畫幀的 footer 是上一頁的舊值，
  // 游標也還沒 park」—— 過去只要一幀的位元組跨過 >SETTLE_MS 的間隔，settle 就會
  // 落在半畫幀上，好讀／list_session 讀到的是上一頁的行號。
  // **注意這只解掉「這一幀完整了嗎」，沒有解掉「這是回應的最後一幀嗎」**
  //（一個按鍵對應多個 doupdate ⇒ 那題仍然只有 SETTLE_MS 答得出來，見檔頭）。
  test("BSU 期間不 settle（半畫幀不會被當成完整回應）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    let settles = 0;
    buf.addEventListener("screenSettled", () => {
      settles += 1;
    });

    parser.feed(BSU + paintRows(1, 12));
    vi.advanceTimersByTime(200); // 遠超過 30ms notify + 50ms settle
    expect(settles).toBe(0);
  });

  test("對照組：沒有 BSU 時半畫幀真的會 settle（上一條擋掉的就是這個）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    let settles = 0;
    buf.addEventListener("screenSettled", () => {
      settles += 1;
    });

    parser.feed(paintRows(1, 12));
    vi.advanceTimersByTime(200);
    expect(settles).toBeGreaterThan(0);
  });

  // 零回歸主鎖：同一串 bytes，開／關 gating 的結果必須逐字相同。
  test("開關 gating 的最終畫面／游標／settle 快照完全一致", () => {
    const bytes =
      BSU + ESC + "[2J" + paintRows(1, 24) + ESC + "[24;80H" + ESU;

    const a = makeBuf();
    new AnsiParser(a).feed(bytes);
    vi.advanceTimersByTime(300);

    const b = makeBuf();
    b.syncUpdateEnabled = false;
    new AnsiParser(b).feed(bytes);
    vi.advanceTimersByTime(300);

    for (let r = 0; r < 24; ++r) expect(row(a, r)).toBe(row(b, r));
    expect(a.cur_x).toBe(b.cur_x);
    expect(a.cur_y).toBe(b.cur_y);
    expect([...a.settleSnapshot.changedRows].sort()).toEqual(
      [...b.settleSnapshot.changedRows].sort()
    );
  });

  test("ESU 不提早 settle：仍要等滿 SETTLE_MS，且只發一次", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    let settles = 0;
    buf.addEventListener("screenSettled", () => {
      settles += 1;
    });

    parser.feed(BSU + paintRows(1, 24) + ESU);
    vi.advanceTimersByTime(10);
    expect(settles).toBe(0); // ESU 本身不是 settle

    vi.advanceTimersByTime(300);
    expect(settles).toBe(1);
  });

  test("零內容 sync frame 不產生 settle（PTT 每次等鍵都會吐一對）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(paintRows(1, 24));
    vi.advanceTimersByTime(300);
    const snap1 = buf.settleSnapshot;

    parser.feed(BSU + ESU);
    parser.feed(BSU + ESU);
    parser.feed(BSU + ESU);
    vi.advanceTimersByTime(300);

    expect(buf.settleSnapshot).toBe(snap1);
  });

  test("BSU 沒有 ESU 時，保險絲仍會把畫面補出來", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);

    parser.feed(BSU + paintRows(1, 12));
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(0);

    vi.advanceTimersByTime(300); // 越過 SYNC_SAFETY_MS
    expect(buf._testUpdates.length).toBe(1);
    expect(buf.inSyncUpdate).toBe(false);
    expect(row(buf, 0)).toBe("ROW01");

    // 遲到的 ESU 是 no-op，不得再觸發一次。
    const n = buf._testUpdates.length;
    parser.feed(ESU);
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(n);
  });

  test("BSU 重入（連續兩個 BSU）只畫一次且不卡住", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(BSU + BSU + paintRows(1, 24) + ESU);
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(1);
    expect(buf.inSyncUpdate).toBe(false);
  });

  test("落單的 ESU（重連收到後半句）是 no-op，畫面照常", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(ESU + paintRows(1, 24));
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(1);
    expect(row(buf, 0)).toBe("ROW01");
  });

  test("resetTerminalModes() 解除卡住的 BSU（重連路徑）", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(BSU);
    expect(buf.inSyncUpdate).toBe(true);

    buf.resetTerminalModes();
    expect(buf.inSyncUpdate).toBe(false);

    parser.feed(paintRow(1));
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(1);
    expect(row(buf, 0)).toBe("ROW01");
  });

  // 設計重點：本地重繪（好讀的 _forceRepaint / _forceRedraw）走 notify() 直呼，
  // 不經過 queueUpdate ⇒ 不可以被 server 的 BSU 擋住。
  test("BSU 期間的本地重繪（notify 直呼）仍然畫得出來", () => {
    const buf = makeBuf();
    const parser = new AnsiParser(buf);
    parser.feed(BSU + paintRows(1, 12));
    expect(buf._testUpdates.length).toBe(0);

    buf.notify(); // 本地重繪路徑
    expect(buf._testUpdates.length).toBe(1);
  });

  test("kill switch：syncUpdateEnabled=false 退回舊行為", () => {
    const buf = makeBuf();
    buf.syncUpdateEnabled = false;
    const parser = new AnsiParser(buf);

    parser.feed(BSU + paintRows(1, 12));
    vi.advanceTimersByTime(100);
    expect(buf._testUpdates.length).toBe(1); // 照舊畫半幀
    expect(buf.inSyncUpdate).toBe(false);
  });
});
