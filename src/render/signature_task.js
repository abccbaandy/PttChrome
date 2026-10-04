// 「內容簽章驅動的漸進式推論」任務。
//
// 純 JS renderer 沒有 useEffect，但三套裝置端 AI（圖說配對校正 / 裸網域複核 /
// URL 修復 gray 候選複核）都是同一個形狀：
//   enabled + 內容簽章 → 簽章變了才 abort 上一輪、跑新的一輪；逐筆回填、不擋畫面。
// 舊版是三段幾乎相同的 useEffect（deps = [enabled, sig]，cleanup 裡 abort）；
// 這裡抽成一個小物件，語意逐條對應：
//   sync(enabled, sig, collect)  ≈ effect 本體 + deps 比較
//   stop()                       ≈ 卸載時的 cleanup
//
// 「簽章相同就不重跑」是效能關鍵：好讀翻頁只是往後長，前面已經問過的候選 key 不變。
//
// run 回傳 Promise 時，任務會記帳：stats() ＝ { runs: 啟動過幾輪, inFlight: 還沒
// settle 的輪數 }（被 abort 的那輪也要等它的 Promise 收尾才算結束）。這是推論鏈唯一
// 的 idle 訊號 —— e2e 要證「沒有推論／推論都回來了」靠它，不靠固定睡眠。
export function createSignatureTask(run, options) {
  const onCancel = (options && options.onCancel) || null;
  let sig = null;
  let enabled = false;
  let controller = null;
  let cancelled = false;
  let runs = 0;
  let inFlight = 0;

  function abort() {
    cancelled = true;
    if (controller) controller.abort();
    controller = null;
    if (onCancel) onCancel();
  }

  return {
    // collect() 只有在真的要跑這一輪時才呼叫（簽章沒變就別白算 todo 清單）。
    sync(nextEnabled, nextSig, collect) {
      if (nextEnabled === enabled && nextSig === sig) return;
      // 上一輪還在跑就先收掉（等同舊版 effect 的 cleanup 先於下一次執行）。
      if (enabled) abort();
      enabled = nextEnabled;
      sig = nextSig;
      if (!enabled) return;
      const todo = collect();
      if (!todo || !todo.length) return;
      controller =
        typeof AbortController === "function" ? new AbortController() : null;
      cancelled = false;
      const myController = controller;
      runs++;
      const pending = run(todo, {
        signal: myController ? myController.signal : undefined,
        // 回填前先確認這一輪還沒被取消（舊版的 `if (cancelled) return`）。
        isCancelled: () => cancelled || controller !== myController,
      });
      if (pending && typeof pending.then === "function") {
        inFlight++;
        const done = () => {
          inFlight--;
        };
        pending.then(done, done);
      }
    },
    stats() {
      return { runs, inFlight };
    },
    stop() {
      if (enabled) abort();
      enabled = false;
      sig = null;
    },
  };
}
