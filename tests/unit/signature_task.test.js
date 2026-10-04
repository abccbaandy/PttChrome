// 內容簽章驅動的漸進式推論任務（src/render/signature_task.js）。
//
// 三套裝置端 AI（圖說配對校正／裸網域複核／URL 修復 gray 候選複核）舊版各是一段
// useEffect，deps = [enabled, 內容簽章]，cleanup 裡 abort。純 JS 版沒有 effect，
// 這個小物件就是那套語意的具名版本。
//
// 守的兩件事都直接對應真實症狀：
//   - 簽章沒變不重跑 —— 好讀翻頁只是往後長，前面問過的候選 key 不變；重跑等於
//     每翻一頁就把整篇的推論重做一次（那正是裝置端模型最慢的部分）。
//   - 簽章變了要 abort 上一輪 —— 否則舊那輪的回填會蓋掉新的畫面狀態。
import { createSignatureTask } from "../../src/render/signature_task";

describe("createSignatureTask", () => {
  test("簽章不變不重跑；變了才跑下一輪", () => {
    const runs = [];
    const task = createSignatureTask((todo) => runs.push(todo));

    task.sync(true, "sig-a", () => ["a"]);
    expect(runs).toEqual([["a"]]);

    task.sync(true, "sig-a", () => ["a"]);
    expect(runs.length).toBe(1);

    task.sync(true, "sig-b", () => ["b"]);
    expect(runs).toEqual([["a"], ["b"]]);
  });

  test("todo 是空的就不啟動（也不留下狀態）", () => {
    let calls = 0;
    const task = createSignatureTask(() => ++calls);
    task.sync(true, "sig", () => []);
    expect(calls).toBe(0);
  });

  test("關掉時 abort 上一輪，且回報已取消", () => {
    const seen = [];
    const task = createSignatureTask((todo, ctx) => seen.push(ctx));

    task.sync(true, "sig", () => ["x"]);
    expect(seen[0].isCancelled()).toBe(false);
    expect(seen[0].signal.aborted).toBe(false);

    task.sync(false, null, () => []);
    expect(seen[0].isCancelled()).toBe(true);
    expect(seen[0].signal.aborted).toBe(true);
  });

  test("簽章換掉時，上一輪的回填必須被判定為已取消", () => {
    const seen = [];
    const task = createSignatureTask((todo, ctx) => seen.push(ctx));

    task.sync(true, "sig-a", () => ["a"]);
    task.sync(true, "sig-b", () => ["b"]);

    expect(seen.length).toBe(2);
    expect(seen[0].isCancelled()).toBe(true); // 舊那輪
    expect(seen[1].isCancelled()).toBe(false); // 新那輪
  });

  test("stop() 收掉進行中的一輪，並觸發 onCancel（殘留的計數不可留在畫面上）", () => {
    let cancels = 0;
    const seen = [];
    const task = createSignatureTask(
      (todo, ctx) => seen.push(ctx),
      { onCancel: () => ++cancels },
    );

    task.sync(true, "sig", () => ["x"]);
    task.stop();
    expect(cancels).toBe(1);
    expect(seen[0].isCancelled()).toBe(true);

    // stop 之後同一組 enabled/簽章要能重新啟動（不是永久卡死）。
    task.sync(true, "sig", () => ["x"]);
    expect(seen.length).toBe(2);
  });

  // stats() 是 e2e 唯一的推論 idle 訊號（取代「等 1500ms 證明沒推論」的觀察窗）：
  // runs 必須只算真的啟動的輪，inFlight 必須等 Promise 收尾（含被 abort 的那輪、
  // 含 reject）才歸零，否則 e2e 會在推論還在途時就斷言。
  test("stats()：runs 只算真的啟動的輪，inFlight 等 Promise 收尾才歸零", async () => {
    const resolvers = [];
    const task = createSignatureTask(
      () =>
        new Promise((resolve, reject) => resolvers.push({ resolve, reject })),
    );
    expect(task.stats()).toEqual({ runs: 0, inFlight: 0 });

    task.sync(false, "sig", () => ["x"]); // 關著 → 不啟動
    task.sync(true, "sig", () => []); // todo 空 → 不啟動
    expect(task.stats()).toEqual({ runs: 0, inFlight: 0 });

    task.sync(true, "sig-a", () => ["a"]);
    task.sync(true, "sig-b", () => ["b"]); // abort 上一輪，但它的 Promise 還沒收尾
    expect(task.stats()).toEqual({ runs: 2, inFlight: 2 });

    resolvers[0].reject(new Error("aborted"));
    await Promise.resolve();
    await Promise.resolve();
    expect(task.stats()).toEqual({ runs: 2, inFlight: 1 });

    resolvers[1].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(task.stats()).toEqual({ runs: 2, inFlight: 0 });
  });

  test("stats()：run 不回 Promise 時不記在途（同步完成）", () => {
    const task = createSignatureTask(() => undefined);
    task.sync(true, "sig", () => ["x"]);
    expect(task.stats()).toEqual({ runs: 1, inFlight: 0 });
  });
});
