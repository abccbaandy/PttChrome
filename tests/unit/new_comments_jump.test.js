// 列表「+N」徽章點一下＝開這篇並跳到新推文（src/js/new_comments.js#armJumpOnOpen、
// docs/new-comments.md「點徽章跳到新推文」）。開文照列表原本那一下，這裡只守「開文之後什麼時候
// 把視口捲過去、什麼時候作廢」：一個 byte 都不送，認不出就照舊停在文章開頭。
// real-input: tests/e2e/offline/mobile_list_cards.offline.spec.js（真 tap 徽章）
import {
  NewComments,
  NEW_COMMENTS_KEY,
  nextJumpStep,
  isListNewPushTarget,
  JUMP_ARM_MS,
  JUMP_BOUND_MS,
} from "../../src/js/new_comments";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

const push = (id, text, type = "推") => (type + " " + id + ": " + text).padEnd(67) + " 10/20 12:00";
const ARTICLE = [
  "作者  alice (Alice) 看板 Test",
  "標題  [閒聊] 測試",
  "",
  "內文",
  "--",
  "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4",
  "※ 文章網址: https://www.ptt.cc/bbs/Test/M.1700000000.A.ABC.html",
];
const withComments = (n) => ARTICLE.concat(Array.from({ length: n }, (_, i) => push("u" + i, "第 " + (i + 1) + " 則")));

describe("nextJumpStep（純決策）", () => {
  const base = { bound: false, armedInst: 1, inst: 1, pageState: 2, ageMs: 0 };
  test("還沒綁定：等下一篇文章出現才綁；同一篇（列表上還是上一篇的編號）不綁", () => {
    expect(nextJumpStep(base)).toBe("wait");
    expect(nextJumpStep({ ...base, pageState: 3 })).toBe("wait");
    expect(nextJumpStep({ ...base, inst: 2 })).toBe("wait"); // 還不在文章畫面
    expect(nextJumpStep({ ...base, inst: 2, pageState: 3 })).toBe("bind");
    expect(nextJumpStep({ ...base, armedInst: undefined, inst: 1, pageState: 3 })).toBe("bind");
  });
  test("還沒綁定：等太久（開文被拒、這一下根本沒開）⇒ 作廢", () => {
    expect(nextJumpStep({ ...base, ageMs: JUMP_ARM_MS + 1 })).toBe("drop");
  });
  const bound = { bound: true, boundInst: 2, inst: 2, pageState: 3, ageMs: 0, row: null, reachedEnd: false };
  test("已綁定：找到第一則新推文那一列 ⇒ 跳", () => {
    expect(nextJumpStep(bound)).toBe("wait");
    expect(nextJumpStep({ ...bound, row: 30 })).toBe("jump");
  });
  test("已綁定：換文章、離開文章、使用者自己捲了 ⇒ 作廢，不搶視口", () => {
    expect(nextJumpStep({ ...bound, row: 30, inst: 3 })).toBe("drop");
    expect(nextJumpStep({ ...bound, row: 30, pageState: 2 })).toBe("drop");
    expect(nextJumpStep({ ...bound, row: 30, userScrolled: true })).toBe("drop");
  });
  test("已綁定：讀到文末還是找不到（沒有新推文、沒有紀錄）⇒ 作廢；永遠等不到也有上限", () => {
    expect(nextJumpStep({ ...bound, reachedEnd: true })).toBe("drop");
    expect(nextJumpStep({ ...bound, ageMs: JUMP_BOUND_MS + 1 })).toBe("drop");
  });
});

test("isListNewPushTarget：只認徽章（含徽章裡面）", () => {
  const el = (hit) => ({ closest: (sel) => (sel === ".listNewPush" && hit ? {} : null) });
  expect(isListNewPushTarget(el(true))).toBe(true);
  expect(isListNewPushTarget(el(false))).toBe(false);
  expect(isListNewPushTarget(null)).toBe(false);
  expect(isListNewPushTarget({})).toBe(false);
});

// ── 控制器：假 App（同 new_comments.test.js 的形狀）────────────────────────
function makeCore(storage) {
  let settled = null;
  const easyReading = {
    _enabled: true,
    _functionMode: false,
    _reverse: null,
    easyReadingReachedPageEnd: false,
    jumped: [],
    rendered: true,
    scrollToArticleRow(row) {
      if (!this.rendered) return false;
      this.jumped.push(row);
      return true;
    },
  };
  const core = {
    easyReading,
    buf: {
      cols: 80,
      pageState: 2,
      pageLines: [],
      getRowText: (r, s, e, lines) => lines[r],
      addEventListener: (name, fn) => name === "screenSettled" && (settled = fn),
    },
    view: { _articleBoard: "Test", _articleInstanceId: 5, chh: 20, mainDisplay: { scrollTop: 0 } },
    aidNavigation: {
      findLocalPostAid() {
        return core.buf.pageLines.some((t) => t.includes("文章網址")) ? { aid: "1ABCDEFG" } : null;
      },
    },
  };
  const nc = new NewComments(core, storage);
  // 開進一篇新文章（accumulatePageLines rebuild ⇒ instance id +1）
  const open = () => {
    core.view._articleInstanceId++;
    core.buf.pageState = 3;
    core.buf.pageLines = [];
    core.view.mainDisplay.scrollTop = 0;
  };
  const show = (lines, atEnd) => {
    core.buf.pageLines = lines;
    easyReading.easyReadingReachedPageEnd = !!atEnd;
    settled();
  };
  return { core, nc, open, show, easyReading };
}

const seeded = (seen) => {
  const st = memStorage();
  st.setItem(NEW_COMMENTS_KEY, JSON.stringify({ "test/1ABCDEFG": [seen, 1] }));
  return st;
};

describe("NewComments：點徽章 → 開文 → 載到那一列就捲過去", () => {
  test("讀過 3 則、現在 5 則 ⇒ 載到文末時捲到第 4 則那一列", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(3));
    nc.noteListClick({ closest: () => ({}) });
    open();
    show(ARTICLE.slice(0, 3)); // 第一頁：綁定這一篇
    expect(easyReading.jumped).toEqual([]);
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([ARTICLE.length + 3]);
    // 用掉就沒了：之後的 settle 不會再把視口拉回去
    show(withComments(5), true);
    expect(easyReading.jumped).toHaveLength(1);
  });

  test("好讀一口氣載完整篇（只剩一次 settle）⇒ 綁定與跳在同一次 settle 完成", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(3));
    nc.armJumpOnOpen();
    open();
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([ARTICLE.length + 3]);
  });

  test("點的是標題（不是徽章）⇒ 照舊從開頭讀；也會取消上一次還沒用掉的", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(3));
    nc.noteListClick({ closest: () => ({}) });
    nc.noteListClick({ closest: () => null });
    open();
    show(ARTICLE.slice(0, 3));
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([]);
  });

  test("沒有新推文 ⇒ 不捲、作廢（之後新長出來的推文也不會突然把視口拉走）", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(5));
    nc.armJumpOnOpen();
    open();
    show(ARTICLE.slice(0, 3));
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([]);
    expect(nc._jump).toBeNull();
  });

  test("載入途中使用者自己往下捲了 ⇒ 不搶視口", () => {
    const { core, nc, open, show, easyReading } = makeCore(seeded(3));
    nc.armJumpOnOpen();
    open();
    show(ARTICLE.slice(0, 3));
    core.view.mainDisplay.scrollTop = 200;
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([]);
  });

  test("使用者按了別的鍵（cancelJumpOnOpen）⇒ 作廢", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(3));
    nc.armJumpOnOpen();
    nc.cancelJumpOnOpen();
    open();
    show(ARTICLE.slice(0, 3));
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([]);
  });

  test("那一列還沒畫進 DOM ⇒ 留著，下一次 settle 再試", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(3));
    nc.armJumpOnOpen();
    open();
    show(ARTICLE.slice(0, 3));
    easyReading.rendered = false;
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([]);
    easyReading.rendered = true;
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([ARTICLE.length + 3]);
  });

  test("開到的不是下一篇就換文章了（[ ] 之類）⇒ 作廢，不跳到別篇", () => {
    const { nc, open, show, easyReading } = makeCore(seeded(3));
    nc.armJumpOnOpen();
    open();
    show(ARTICLE.slice(0, 3));
    open();
    show(withComments(5), true);
    expect(easyReading.jumped).toEqual([]);
  });

  test("這一下根本沒開文（等太久）⇒ 作廢；之後自己開的文章不跳", () => {
    vi.useFakeTimers();
    try {
      const { nc, open, show, easyReading } = makeCore(seeded(3));
      nc.armJumpOnOpen();
      show([]); // 還在列表上 settle
      vi.advanceTimersByTime(JUMP_ARM_MS + 1);
      show([]);
      open();
      show(ARTICLE.slice(0, 3));
      show(withComments(5), true);
      expect(easyReading.jumped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
