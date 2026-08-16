// 分頁之間的 deep link 交接（BroadcastChannel）。
//
// 目標：外面點連結時，如果使用者已經有一個登入好的分頁，就讓那個分頁去跳，不要
// 再開一個從頭登入。
//
// **瀏覽器的硬限制先講清楚**（不要以為這裡能解掉）：
//   1. 外部程式點 https 連結一定會開新分頁／新視窗，網頁攔不到。唯一的例外是
//      把站台安裝成 PWA（manifest 的 launch_handler: focus-existing），那條路
//      走 launchQueue，根本不會進到這個檔案。
//   2. 既有分頁沒有 user activation，window.focus() 叫不動自己。所以「接手」的
//      結果只能是：既有分頁默默跳好，新分頁顯示「請切回原本的分頁」。
//   3. 新分頁的 window.close() 只對「由 script 開出來的視窗」有效，外部點出來的
//      關不掉 —— 所以提示畫面是主要手段，close() 只是順便試。
//
// 協定（兩種訊息就夠）：
//   新分頁 → { t:'claim', id, target }
//   既有分頁 → { t:'ack', id }        （並且自己開始跳）
//
// **既有分頁一律同步 ack，中間不准有任何 setTimeout。**
// 使用者從外部程式點連結的那一刻，既有分頁必定是**背景分頁**，而 Chrome 對背景
// 分頁的 timer 節流到最少 1 秒（5 分鐘後更嚴格）。原本設計的「0..60ms 隨機退讓」
// 在真實環境會變成 1000ms+，新分頁早就逾時放棄 → 交接看起來像壞掉（實測
// 2026-08-16：新分頁照樣自己登入）。headless e2e 不節流，所以測不出來。
// message event 走的是 task queue 不是 timer，不受這個節流影響 —— 所以同步 ack
// 是唯一可靠的做法。
//
// 代價：兩個既有分頁同時在線時會**都**接下（各自的 answered 是空的，誰都還沒看到
// 對方的 ack）。後果溫和：兩個分頁各自跳到同一篇文章。拿它換「不會整個失效」是
// 划算的，而多數使用者只有一個 PTT 分頁。（Web Locks 能真互斥，但 lock 的生命
// 週期綁在 callback 上，要橫跨整個 claim 窗口得塞一個 sleep — 又繞回 timer。）

export const DEEP_LINK_CHANNEL = 'pttchrome-deeplink';

// 新分頁等 ack 的時間。既有分頁是同步回答的，所以這裡只需要涵蓋「訊息投遞 +
// 背景分頁被喚醒執行 task」的時間；600ms 已經很寬鬆，又短到沒人接手時使用者
// 感覺不出開站變慢。
const CLAIM_TIMEOUT_MS = 600;

export function createChannel(win) {
  const w = win || window;
  if (!w.BroadcastChannel) return null;
  try {
    return new w.BroadcastChannel(DEEP_LINK_CHANNEL);
  } catch (e) {
    return null;
  }
}

// 新分頁：問「有沒有人可以接手？」回傳 Promise<boolean>。
// false = 沒人接（含這個瀏覽器根本沒有 BroadcastChannel）→ 自己開站。
export function claimHandoff(channel, target, opts) {
  const o = opts || {};
  if (!channel || !target) return Promise.resolve(false);
  const setTimer = o.setTimeout || setTimeout;
  const clearTimer = o.clearTimeout || clearTimeout;
  const id = o.makeId
    ? o.makeId()
    : Math.random().toString(36).slice(2) + '-' + Date.now();

  return new Promise(resolve => {
    let timer = null;
    const onMessage = e => {
      const msg = e && e.data;
      if (msg && msg.t === 'ack' && msg.id === id) finish(true);
    };
    const finish = taken => {
      if (timer !== null) clearTimer(timer);
      timer = null;
      channel.removeEventListener('message', onMessage);
      resolve(taken);
    };
    channel.addEventListener('message', onMessage);
    timer = setTimer(() => finish(false), o.timeoutMs || CLAIM_TIMEOUT_MS);
    try {
      channel.postMessage({ t: 'claim', id: id, target: target });
    } catch (e) {
      finish(false);
    }
  });
}

// 既有分頁：開始接受交接請求。
//   canHandle() → 現在有沒有資格接（連線中才算；沒登入不要緊，controller 會
//                 把目標收著等登入，那仍然比開新分頁重登一次好）
//   onTarget(target) → 接下了，自己去跳
// 回傳一個解除註冊的函式。
export function serveHandoff(channel, canHandle, onTarget, opts) {
  void opts;
  if (!channel) return function() {};
  // 已經有人（含自己）回答過的 claim id：擋掉重播。BroadcastChannel 不會把訊息
  // 送回給發送端自己，所以自己送出的 ack 必須自己記下來。
  const answered = new Set();

  const onMessage = e => {
    const msg = e && e.data;
    if (!msg) return;
    if (msg.t === 'ack') {
      answered.add(msg.id);
      return;
    }
    if (msg.t !== 'claim' || !msg.target || answered.has(msg.id)) return;
    if (!canHandle()) return;
    answered.add(msg.id);
    try {
      channel.postMessage({ t: 'ack', id: msg.id });
    } catch (err) {
      return; // 送不出 ack 就別接：新分頁還在等，讓它自己開站
    }
    onTarget(msg.target);
  };

  channel.addEventListener('message', onMessage);
  return function() {
    channel.removeEventListener('message', onMessage);
  };
}
