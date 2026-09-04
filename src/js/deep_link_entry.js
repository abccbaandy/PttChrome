// Deep link 的瀏覽器接線：把 window 上會送進 { board, aid } 的每一條路徑都接到
// DeepLinkController。解析在 deep_link.js，排程在 deep_link_controller.js，這裡
// 只碰 window/location/history —— 所以 window 是注入的，unit test 給假的即可。
//
// 進來的路徑有三條：
//   1. 開站時的網址（外部程式點連結 → 新分頁）
//   2. hashchange（同一個分頁再貼一次連結，不重載、不用重新登入）
//   3. PWA launchQueue（已安裝成應用程式時，launch_handler: focus-existing 會
//      把連結交給既有視窗，**不重載頁面** ⇒ 第 1 條根本不會再跑，少了這條就
//      整個安裝情境失效）

import { parseDeepLink, stripDeepLink } from './deep_link';
import { isSelfNavigating } from './self_navigation';
import { createChannel, claimHandoff, serveHandoff } from './deep_link_channel';

// 開站前先問：已經有登入好的分頁可以接手嗎？回 Promise<{ target, taken }>。
//   target 為 null ⇒ 這次開站根本沒帶 deep link，什麼都沒問（也就沒有延遲）。
//   taken 為 true  ⇒ 別的分頁接下了，這一頁不要連線，顯示提示就好。
// 刻意在 connect() 之前做：接手成功卻已經連上 PTT 的話，等於白佔一個連線名額。
export function claimDeepLink(win) {
  const w = win || window;
  const target = parseDeepLink(w.location.href);
  if (!target) return Promise.resolve({ target: null, taken: false });
  const channel = createChannel(w);
  return claimHandoff(channel, target).then(taken => {
    if (channel && channel.close) channel.close();
    return { target: target, taken: taken };
  });
}

export function installDeepLink(app, win) {
  const w = win || window;

  // 消費掉網址上的 deep link。replaceState 是必要的：不清掉的話使用者按 F5
  // 會再跳一次，而那時他多半早就人在別篇文章了。
  // （replaceState 不會觸發 hashchange，不必擔心自我遞迴。）
  const consume = () => {
    // 本站自己造成的 history traversal（history_back_guard 補回 sentinel）會讓
    // fragment 變動而派發 hashchange —— 那是回音，不是「使用者又貼了一條連結」。
    // 少了這道判斷，按上一頁／滑鼠側鍵／觸控板左滑都會被拉回剛剛那篇文章
    // （2026-09-05 實機回報）。理由與窗口長度見 self_navigation.js，
    // 回歸鎖 tests/unit/back_guard_deep_link.test.js。
    if (isSelfNavigating()) return null;
    const href = w.location.href;
    const target = parseDeepLink(href);
    if (!target) return null;
    app.deepLinkController.request(target);
    if (w.history && w.history.replaceState) {
      try {
        w.history.replaceState(null, '', stripDeepLink(href));
      } catch (e) {
        // file:// 之類 replaceState 會 throw —— 跳轉本身不受影響，別擋住它。
      }
    }
    return target;
  };

  w.addEventListener('hashchange', consume);

  // 這一頁從現在起也可以當「既有分頁」，替之後開出來的新分頁接手。連線中就算
  // 有資格：還沒登入也沒關係，controller 會把目標收著等登入完成 —— 那仍然比讓
  // 使用者在新分頁重登一次好。
  serveHandoff(
    createChannel(w),
    () => app.connectState === 1,
    // source: 'handoff' —— 使用者的眼睛在**新開的那個**分頁上，這裡得主動出聲
    // （標題閃爍／系統通知／頁內橫幅）。見 DeepLinkController.request。
    target => app.deepLinkController.request(target, { source: 'handoff' })
  );

  if (w.launchQueue && w.launchQueue.setConsumer) {
    w.launchQueue.setConsumer(params => {
      const urls = (params && params.targetURL) ? [params.targetURL] : [];
      for (let i = 0; i < urls.length; ++i) {
        const target = parseDeepLink(urls[i]);
        if (target) app.deepLinkController.request(target);
      }
    });
  }

  return consume();
}

export default installDeepLink;
