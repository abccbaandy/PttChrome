// 好讀累積長頁的分塊（`div.screenChunk`＋`content-visibility: auto`）。
//
// 為什麼：超長文（破千頁）的成本大頭不是我們的 JS，是瀏覽器原生的 layout／paint／
// hit test —— 全部與 DOM 規模成正比（22000 行實測：每頁 update 12.5ms、PgDn p50
// 21.5ms、改設定 822ms，CPU profile 的 Blink 原生 7.6s 對 JS 1.4s）。把列每
// CHUNK_ROWS 列包成一塊並開 `content-visibility: auto`，離視窗遠的塊瀏覽器不排版、不
// 繪製、不建 LayoutObject ⇒ 每次操作成本與文章長度無關。DOM 仍是全文（Ctrl+F、
// 大範圍選取複製、scroll anchoring 都靠它）——**刻意不做虛擬捲動**：那得自己重寫
// 這三樣，違反「原生行為不准模擬」。完整量測與四引擎行為驗證：docs/easy-reading.md
// 「長頁分塊」。
//
// 只套在 `enhance.stableRows`（好讀累積長頁）。原生 24 列／列表視窗／functionMode
// 鏡像不分塊（理由同 stableRows：那些是活 buffer，而且只有 24 列）。
//
// ---- 不變量 ----
// 1. **節點一旦放進某塊就不再搬家**。塊的歸屬由節點身分決定，不是列號：反向讀取
//    （End）在接合點 J 插入新頁會讓之後的列號整批位移，若依列號分塊就得把節點搬到
//    別的塊 ⇒ 搬走捲動錨點 ⇒ scroll anchoring 當幀不補償（同 screen.js#_patchInto
//    的「不得搬動含錨點節點」）。新節點只會 append 進前一個節點所在的塊、或開一個新塊
//    插在兩塊之間；J 那一列一定開新塊（否則後續每頁都會插進同一塊的中段）。
// 2. **塊在 runtime 不寫會改變的 inline style**（scroll anchoring 的 suppression
//    trigger，同 inline_preview_slot.js 檔頭）。估計高度是靜態 CSS（main.css
//    `.screenChunk`），`auto` 關鍵字讓瀏覽器自己記每塊最後的實測高度。
// 3. 全量重建（改設定、AI 回填、接合）時**按順序沿用舊的塊元素**：同位置的塊裝回
//    大致相同的列，瀏覽器記住的高度仍然有效，視窗上方的閉塊不會因估計值失準而推走讀者。
// 4. 閉塊裡的元素 IntersectionObserver 幾乎不回報（四引擎實測），延遲開圖因此要塊來
//    補：塊進入預載邊界（1500px）就掛 `.screenChunkNear` 照常渲染 ⇒ 塊內 slot 自己的
//    observer 可信，掛載仍是逐張精準（不可改成「塊近了就整塊一起掛」：短文整篇只有
//    一塊，等於全部的圖一起載、永不卸載）；塊離開卸載邊界（6000px）就通知塊內 slot
//    卸載（slot.setChunkFar）——塊被跳過之後 slot 自己的 far 可能永遠停在「還在範圍內」。
// 5. Firefox 跨閉塊的 `Selection.toString()` 會漏字（實測 1.4 萬 vs 162 萬字）⇒ 選取
//    期間把與選取範圍相交的塊暫時展開（`.screenChunkOpen`，content-visibility:
//    visible），複製仍是瀏覽器原生的。由 selectionchange 驅動（原生 Ctrl+C 也涵蓋）。
// 6. **render 之後同一個 task 裡同步讀版面，新塊量到的是估計高度**（CHUNK_ROWS 列，
//    不是真高度）：塊照不照常渲染由瀏覽器在 rendering update（rAF 之後、paint 前）才
//    判定。這個狀態不會被畫出來，但程式讀得到 —— scrollHeight 灌水、`scrollTop =
//    scrollHeight` 落在假的底部、視窗內找不到捲動錨點 ⇒ 插頁當下不補償（實測 +2953，
//    paint 前才被 content-visibility 解鎖＋bottom_stick 修正）。現有的同步讀者都有人收尾：
//    EasyReading._scrollBottom（End 後由 bottom_stick 的 ResizeObserver 收尾）、
//    _restoreRowAnchor／_scrollToPageRow（先 renderChunksAround）。**新增「render 後同步
//    量座標、而且結果會拿去用」的程式碼**：先 renderChunksAround(el)，或改到下一幀量。
//    守護 tests/unit/screen_chunk_sync_layout.test.js（真 Chromium 鎖住這個瀏覽器事實）。
import { el } from "./dom";
import { offsetTopWithin } from "../js/scroll_anchor";
import { LAZY_MOUNT_MARGIN_PX, LAZY_UNMOUNT_MARGIN_PX } from "../js/lazy_media";

// 每塊的列數（頂層節點數；合併推文塊算一個）。main.css `.screenChunk` 的估計高度
// （`contain-intrinsic-height: auto 100lh`）與它同值 —— 守護 tests/unit/screen_chunk.test.js。
export const CHUNK_ROWS = 100;
export const CHUNK_CLASS = "screenChunk";
export const CHUNK_OPEN_CLASS = "screenChunkOpen";
// 塊進入延遲開圖的預載邊界（LAZY_MOUNT_MARGIN_PX）⇒ 照常渲染（見不變量 4）。
export const CHUNK_NEAR_CLASS = "screenChunkNear";

const ROW_SEL = '[type="bbsrow"][srow]';

export function isScreenChunk(node) {
  return !!(
    node &&
    node.nodeType === 1 &&
    node.classList &&
    node.classList.contains(CHUNK_CLASS)
  );
}

// 視窗頂端（scrollTop＝st）附近的列節點，給「從上往下逐列量 offsetTop 找第一個看得到
// 的列」那幾個掃描用（term_view._captureRowAnchor／currentLineIndex）。分塊之後逐列
// 量會強迫視窗上方**每一個**閉塊排版（O(文章)），所以先以塊的盒子跳過整塊，只回傳
// 命中的那塊與下一塊的列。沒分塊時回傳全部（行為與改版前相同）。
export function rowsFromScrollTop(container, scroller, st) {
  const kids = container.children;
  let found = -1;
  let hasChunk = false;
  for (let i = 0; i < kids.length; ++i) {
    const k = kids[i];
    if (!isScreenChunk(k)) continue;
    hasChunk = true;
    if (offsetTopWithin(k, scroller) + k.offsetHeight > st) {
      found = i;
      break;
    }
  }
  if (!hasChunk) return container.querySelectorAll(ROW_SEL);
  if (found < 0) return [];
  const out = Array.from(kids[found].querySelectorAll(ROW_SEL));
  for (let i = found + 1; i < kids.length; ++i) {
    if (!isScreenChunk(kids[i])) continue;
    const more = kids[i].querySelectorAll(ROW_SEL);
    for (let j = 0; j < more.length; ++j) out.push(more[j]);
    break;
  }
  return out;
}

// 程式要把 `el` 捲進視窗**之前**呼叫：把它所在的塊與上下鄰塊立刻改成照常渲染
// （.screenChunkNear），之後量到的 offsetTop 才是真高度下的位置。
// 為什麼需要：全量重建（反向讀取接合）會按順序沿用塊元素、換上別的列，視窗所在的塊
// 在那一幀可能還是閉塊（以估計高度排版）；量完捲過去，下一幀它才真的渲染、高度變了
// ⇒ 內容位移（「End 之後黏在文末」還會照規則捲去新的底部，實測一次跳 5259px）。
// 之後塊的 observer 回報會照常接手這個 class（塊在視窗內 ⇒ 回報 near）。
export function renderChunksAround(el) {
  const ch = el && el.closest ? el.closest("." + CHUNK_CLASS) : null;
  if (!ch) return;
  const around = [ch.previousElementSibling, ch, ch.nextElementSibling];
  for (let i = 0; i < around.length; ++i)
    if (isScreenChunk(around[i])) around[i].classList.add(CHUNK_NEAR_CLASS);
}

// 塊現在照常渲染（預載邊界內／被選取展開）⇒ 塊內元素的 offsetTop 是真位置。其餘是
// 閉塊：讀塊內元素的版面會逼瀏覽器當場把整塊排版（分塊省下的成本又付回去），只量塊本身。
export function isChunkRendered(chunk) {
  return (
    chunk.classList.contains(CHUNK_NEAR_CLASS) ||
    chunk.classList.contains(CHUNK_OPEN_CLASS)
  );
}

// 存活中的 ChunkLayer（實務上只有一個）。readSelectionText 要在讀之前同步展開。
const liveLayers = new Set();

// 讀「目前選取的文字」的唯一入口（app 的複製／右鍵快速搜尋都走這裡）。
// 為什麼不能直接 getSelection().toString()：Firefox 對跨閉塊的選取會漏字。
// selectionchange 驅動的展開（不變量 5）是**非同步**的，而 copyOnSelect 在 mouseup
// 當下就讀 ⇒ 讀之前先同步展開＋強制排版。Firefox 實測（3000 行、11 塊）：選取當下
// 直接讀 30556 字；同步展開＋排版後 110085 字（完整）；不展開的話過一幀又掉回 90329。
export function readSelectionText() {
  let opened = false;
  for (const layer of liveLayers) if (layer.syncSelection()) opened = true;
  if (opened && document.body) void document.body.offsetHeight;
  const sel = window.getSelection();
  return sel ? sel.toString() : "";
}

export class ChunkLayer {
  constructor(container) {
    liveLayers.add(this);
    this.container = container;
    this._chunks = new Set(); // 目前掛著的塊
    this._open = new Set(); // 因選取而暫時展開的塊
    this._io = undefined; // { near, far } | null（環境沒有 IntersectionObserver）
    this._onSelectionChange = () => this.syncSelection();
    document.addEventListener("selectionchange", this._onSelectionChange);
  }

  get size() {
    return this._chunks.size;
  }

  _own(node) {
    return !!node && node.__chunkLayer === this;
  }

  _inChunk(node) {
    const p = node.parentNode;
    return !!p && p.__chunkLayer === this && p.parentNode === this.container;
  }

  // 把 `nodes`（逐列對齊，null＝不佔版面）排進塊裡。`stale`＝上一幀有、這一幀不要的
  // 節點（screen.js#_buildNodes 收集）。`stop`＝第一個尾端浮層（塊一律排在它前面）。
  // `junction`＝反向讀取的接合點列號（那一列一定開新塊），沒有就是 null。
  // `from`＝nodes[0, from) 與上一幀相同且都已在塊裡（screen.js 的前沿快路徑）⇒ 只走
  // 尾段，每頁成本與文章長度無關。
  patch(nodes, stale, stop, junction, from = 0) {
    const c = this.container;
    // 1. 容器直系、不是塊的節點＝上一幀的原生／列表列（或列表視口），一律移除。
    for (let k = c.firstChild; k && k !== stop;) {
      const next = k.nextSibling;
      if (!this._own(k)) k.remove();
      k = next;
    }
    // 2. 不要的舊節點移出所屬的塊（其餘節點原地不動）。
    for (let i = 0; i < stale.length; ++i) {
      const n = stale[i];
      const p = n.parentNode;
      if (p && p.__chunkLayer === this) {
        p.removeChild(n);
        --p.__rows;
      }
    }
    // 3. 這一幀有沒有沿用任何節點。沒有＝全量重建 ⇒ 按順序沿用舊的塊元素（不變量 3）。
    let kept = from > 0;
    for (let i = 0; !kept && i < nodes.length; ++i) {
      if (nodes[i] && this._inChunk(nodes[i])) {
        kept = true;
        break;
      }
    }
    const spare = [];
    if (!kept) {
      for (let k = c.firstChild; k && k !== stop; k = k.nextSibling) {
        if (!this._own(k)) continue;
        if (k.firstChild) k.replaceChildren();
        k.__rows = 0;
        spare.push(k);
      }
    }
    let spareAt = 0;
    // 4. 逐列就位。沿用的節點不碰；新節點接在前一個節點後面。
    // 接合點的界線落在「列號 ≥ J 的第一個節點」：J 那一列可能不佔版面（黑名單整列
    // 移除 ⇒ null），只看 row === J 會漏切 ⇒ tail 黏進 head 的塊，之後每頁都插進塊中段。
    let prev = null;
    for (let row = from - 1; row >= 0 && !prev; --row) prev = nodes[row];
    let boundary = junction != null && junction >= from;
    for (let row = from; row < nodes.length; ++row) {
      const n = nodes[row];
      if (!n) continue;
      const atJunction = boundary && row >= junction;
      if (atJunction) boundary = false;
      if (this._inChunk(n)) {
        prev = n;
        continue;
      }
      let chunk = prev ? prev.parentNode : null;
      if (chunk && prev.nextSibling) {
        // 塊的中段：沿用的節點夾著新節點（例：推文 run 首列重建）。原位插入，不搬
        // 任何既有節點；這塊可能因此略超過 CHUNK_ROWS，無妨。
        chunk.insertBefore(n, prev.nextSibling);
        ++chunk.__rows;
      } else if (chunk && chunk.__rows < CHUNK_ROWS && !atJunction) {
        chunk.appendChild(n);
        ++chunk.__rows;
      } else if (
        this._canPrepend(
          chunk ? chunk.nextSibling : c.firstChild,
          spareAt < spare.length,
        )
      ) {
        // 接不進前一塊（滿了／接合點界線）但下一塊還有空間：插在它的開頭（它的第一個
        // 節點就是下一個沿用的節點，次序正確、不搬任何既有節點）。反向讀取每頁都插在
        // 接合點，沒有這條就是每頁一個 22 列的小塊，而每塊的估計高度是 CHUNK_ROWS 列
        // ⇒ 視窗上方的總高被灌成好幾倍（實測 3000 行時 scrollHeight 40 萬 px），捲軸失真。
        chunk = chunk ? chunk.nextSibling : c.firstChild;
        chunk.insertBefore(n, chunk.firstChild);
        ++chunk.__rows;
      } else {
        const ref = chunk ? chunk.nextSibling : c.firstChild;
        if (spareAt < spare.length) {
          // 全量重建：按順序沿用，它本來就排在這個位置上。
          chunk = spare[spareAt++];
        } else {
          chunk = this._createChunk();
          c.insertBefore(chunk, ref && ref.parentNode === c ? ref : stop);
        }
        chunk.appendChild(n);
        chunk.__rows = 1;
      }
      this._seedSlots(n, chunk);
      prev = n;
    }
    // 5. 空掉的塊收掉。
    for (let k = c.firstChild; k && k !== stop;) {
      const next = k.nextSibling;
      if (this._own(k) && !k.__rows) this._dropChunk(k);
      k = next;
    }
  }

  // 新節點可不可以插在塊 `k` 的開頭。只插進**閉塊**（不在預載邊界內、沒被選取展開）：
  // 閉塊受尺寸約束，內容變了高度也不變 ⇒ 版面零變化。照常渲染中的塊（多半就是讀者
  // 所在的那一塊）往開頭插列，Chromium 的 scroll anchoring 實測只補償一部分（插 22 列
  // 1034px 只補 885px）⇒ 那種情況照舊開新塊插在兩塊之間。
  _canPrepend(k, fresh) {
    return (
      !fresh &&
      this._own(k) &&
      k.__rows > 0 &&
      k.__rows < CHUNK_ROWS &&
      !k.classList.contains(CHUNK_NEAR_CLASS) &&
      !k.classList.contains(CHUNK_OPEN_CLASS)
    );
  }

  // 離開分塊模式（這一幀不是好讀累積長頁）：只做記帳，節點的移除由呼叫端的
  // _patchInto 清理迴圈負責（塊不在新的 nodes 裡 ⇒ 被移除）。
  release() {
    for (const k of this._chunks) this._unobserve(k);
    this._chunks.clear();
    this._open.clear();
  }

  destroy() {
    liveLayers.delete(this);
    document.removeEventListener("selectionchange", this._onSelectionChange);
    this.release();
    if (this._io) {
      this._io.near.disconnect();
      this._io.far.disconnect();
    }
    this._io = null;
  }

  _createChunk() {
    const chunk = el("div", { class: CHUNK_CLASS });
    chunk.__chunkLayer = this;
    chunk.__rows = 0;
    // 遠近未知：far=false ⇒ 延遲開圖照 slot 自己的判斷，等 observer 的首次回報。
    chunk.__far = false;
    this._chunks.add(chunk);
    const io = this._observers();
    if (io) {
      io.near.observe(chunk);
      io.far.observe(chunk);
    }
    return chunk;
  }

  _dropChunk(chunk) {
    this._unobserve(chunk);
    this._chunks.delete(chunk);
    this._open.delete(chunk);
    chunk.remove();
  }

  _unobserve(chunk) {
    if (!this._io) return;
    this._io.near.unobserve(chunk);
    this._io.far.unobserve(chunk);
  }

  // 與 inline_preview_slot 的 slot 層 observer 同一組邊界與 root（`.main`；理由見該檔
  // 「root 不可省略」）。
  _observers() {
    if (this._io !== undefined) return this._io;
    if (typeof IntersectionObserver !== "function") {
      this._io = null;
      return null;
    }
    const root = this.container.closest(".main") || null;
    const dispatch = (kind) => (entries) => {
      for (let i = 0; i < entries.length; ++i) {
        const chunk = entries[i].target;
        if (!this._chunks.has(chunk)) continue;
        if (kind === "near") {
          // 預載邊界內的塊照常渲染 ⇒ 塊內 slot 自己的 observer 回報可信（不變量 4）。
          chunk.classList.toggle(CHUNK_NEAR_CLASS, entries[i].isIntersecting);
        } else {
          chunk.__far = !entries[i].isIntersecting;
          this._syncChunkSlots(chunk);
        }
      }
    };
    this._io = {
      near: new IntersectionObserver(dispatch("near"), {
        root,
        rootMargin: LAZY_MOUNT_MARGIN_PX + "px 0px",
      }),
      far: new IntersectionObserver(dispatch("far"), {
        root,
        rootMargin: LAZY_UNMOUNT_MARGIN_PX + "px 0px",
      }),
    };
    return this._io;
  }

  _syncChunkSlots(chunk) {
    for (let n = chunk.firstChild; n; n = n.nextSibling)
      this._seedSlots(n, chunk);
  }

  _seedSlots(node, chunk) {
    const slots = node.__slots;
    if (!slots) return;
    for (let i = 0; i < slots.length; ++i) {
      if (slots[i].setChunkFar) slots[i].setChunkFar(chunk.__far);
    }
  }

  // 不變量 5。只動 class，不寫 inline style。回傳這一次有沒有新展開任何一塊。
  syncSelection() {
    if (!this._chunks.size && !this._open.size) return false;
    const sel =
      typeof document.getSelection === "function"
        ? document.getSelection()
        : null;
    const want = new Set();
    if (sel && !sel.isCollapsed) {
      for (let i = 0; i < sel.rangeCount; ++i) {
        const r = sel.getRangeAt(i);
        if (!r.intersectsNode(this.container)) continue;
        for (const k of this._chunks) if (r.intersectsNode(k)) want.add(k);
      }
    }
    for (const k of this._open) {
      if (want.has(k)) continue;
      k.classList.remove(CHUNK_OPEN_CLASS);
    }
    let opened = false;
    for (const k of want) {
      if (this._open.has(k)) continue;
      k.classList.add(CHUNK_OPEN_CLASS);
      opened = true;
    }
    this._open = want;
    return opened;
  }
}
