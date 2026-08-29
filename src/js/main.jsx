import { App } from './pttchrome';
import { setupI18n, i18n } from './i18n';
import { getQueryVariable, proxySiteFromPrefs } from './util';
import { readValuesWithDefault } from './pref_storage';
import { pageArticleNums } from './comment_parse';
import { registerOnCloudValues, startIfPreviouslySignedIn } from './pref_sync';
import { installDeepLink, claimDeepLink } from './deep_link_entry';
import { parseDeepLink } from './deep_link';
import { renderInto, unmountFrom } from './react_root';
import { MantineRoot } from '../components/MantineRoot';
import b2uTableUrl from '../conv/b2u_table.bin?url';
import u2bTableUrl from '../conv/u2b_table.bin?url';

function startApp() {
  // Build identity first thing: lets a user/console dump prove which bundle
  // is actually running (stale deploy / cached JS debugging).
  console.info(
    "pttchrome build " +
      process.env.GIT_COMMIT +
      " (" +
      process.env.BUILD_TIME +
      ")"
  );
  setupI18n();

  const app = new App();
  // Expose the app for e2e inspection only in developer/dev builds.
  if (process.env.DEVELOPER_MODE) {
    window.__app = app;
    window.__readPrefs = readValuesWithDefault; // e2e dynamic pref lookup
    window.__i18n = i18n; // e2e locale-independent label lookup (UI behavior tests)
    // Cassette recorder: pick jump anchors with the SAME cursor-digit recovery
    // the runtime uses (bufferEdgeNum over pageArticleNums), so recorded jump
    // nums match what ListSession will actually send during replay.
    window.__pageArticleNums = pageArticleNums;
    // e2e 要驗「產出的分享連結指向哪一篇」。連結是檔名形式（#<Board>/M.…html），
    // 肉眼比對不了 AID，所以把合約的解析端本身開出去讓測試呼叫。
    window.__parseDeepLink = parseDeepLink;
  }

  // 外部連結（#<Board>/<AID>）進來的話，先問問看有沒有已經登入好的分頁可以
  // 接手。沒帶 deep link 就是一個已 resolve 的 Promise，開站流程完全不變。
  //
  // dev build 刻意**不再**擋一層 Developer Mode modal：那個 modal 會把 connect()
  // 延後到使用者按掉為止，讓 dev 與正式版的 boot 時序不一致 —— deep link 這種
  // 「開站當下就要消費 URL」的功能在 dev 下量到的行為因此不可信。
  claimDeepLink().then(({ target, taken }) => {
    if (taken) return showHandoffTaken(target, bootstrap);
    bootstrap();
  });

  function bootstrap() {
    // connect. Priority: ?site override (off by default, see vite.config.mjs ALLOW_SITE_IN_QUERY)
    // -> user proxy from prefs -> the built-in DEFAULT_SITE.
    const prefs = readValuesWithDefault();
    app.connect(
      (process.env.ALLOW_SITE_IN_QUERY && getQueryVariable('site'))
      || proxySiteFromPrefs(prefs)
      || process.env.DEFAULT_SITE);
    console.log("load pref from storage");
    app.onValuesPrefChange(prefs);
    // Cloud prefs (Firestore) arrive later — and keep arriving via the
    // realtime listener — and are re-applied on top; no-op unless the user
    // enabled sync by signing in before (see pref_sync.js). The callback is
    // registered unconditionally so a sign-in from PrefModal reaches the app
    // too; registering alone never loads Firebase.
    registerOnCloudValues(values => app.onValuesPrefChange(values));
    startIfPreviouslySignedIn();
    // 外部連結 → 登入後自動跳到那篇文章。必須在 connect() 之後才接：目標可能比
    // 登入早到，controller 會先收著。
    installDeepLink(app);
    app.setInputAreaFocus();
    document.getElementById('BBSWindow').style.display = '';
    app.onWindowResize();
  }
}

// 別的分頁接下了這個 deep link：這一頁不連線（不然白佔一個 PTT 連線名額），
// 只留一則說明。window.close() 對外部程式開出來的分頁無效，所以那只是順手一
// 試，真正的出口是「改在這個分頁開啟」。
function showHandoffTaken(target, bootstrap) {
  const container = document.getElementById('reactAlert');
  return import('../components/DeepLinkHandoffAlert').then(({ DeepLinkHandoffAlert }) => {
    const onStayHere = () => {
      unmountFrom(container);
      bootstrap();
    };
    renderInto(container,
      <MantineRoot><DeepLinkHandoffAlert target={target} onStayHere={onStayHere} /></MantineRoot>);
    try {
      window.close();
    } catch (e) {}
  });
}

function loadTable(url) {
  return fetch(url).then(response => {
    if (!response.ok)
      throw new Error('loadTable failed: ' + response.statusText + ': ' + url);
    return response.arrayBuffer();
  });
}

// 終端機字型（SymMingLiu，bundled webfont）。**格線正確性的前置條件**：ASCII 的
// advance 必須是 0.5em 才等於 term_view 的 chw。Mac 沒有 local MingLiu ⇒ 字型落地前
// 每一列的寬度都是錯的，而 #cursor 的欄位算術（cur_x * chw）不會跟著錯 ⇒ 游標對不上
// 該格（症狀：推文時游標戳出反白輸入匡）。
//
// 逾時就照跑：字型問題絕對不可以擋住連線。字型 API 不存在（極舊環境）同理。
function loadTerminalFont() {
  const TIMEOUT_MS = 3000;
  try {
    if (typeof document === 'undefined' || !document.fonts)
      return Promise.resolve();
    // 尺寸只是查詢用的 face 描述，實際字級由 term_view 寫 inline style。
    return Promise.race([
      document.fonts.load('26px SymMingLiu'),
      new Promise(resolve => setTimeout(resolve, TIMEOUT_MS))
    ]).catch(e => {
      console.log('loadTerminalFont failed (continuing): ' + e);
    });
  } catch (e) {
    return Promise.resolve();
  }
}

function loadResources() {
  Promise.all([
    loadTable(b2uTableUrl),
    loadTable(u2bTableUrl),
    loadTerminalFont()
  ]).then(function(binData) {
    window.lib = window.lib || {};
    window.lib.b2uArray = new Uint8Array(binData[0]);
    window.lib.u2bArray = new Uint8Array(binData[1]);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startApp);
    } else {
      startApp();
    }
  }, function(e) {
    console.log('loadResources failed: ' + e);
  });
}

loadResources();
