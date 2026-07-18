import { App } from './pttchrome';
import { setupI18n, i18n } from './i18n';
import { getQueryVariable, proxySiteFromPrefs } from './util';
import { readValuesWithDefault } from './pref_storage';
import { pageArticleNums } from './comment_parse';
import { registerOnCloudValues, startIfPreviouslySignedIn } from './pref_sync';
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
  }

  (process.env.DEVELOPER_MODE ? import('../components/DeveloperModeAlert')
    .then(({DeveloperModeAlert}) => new Promise((resolve, reject) => {
      const container = document.getElementById('reactAlert')
      const onDismiss = () => {
        unmountFrom(container)
        resolve()
      }
      renderInto(container, <MantineRoot><DeveloperModeAlert onDismiss={onDismiss} /></MantineRoot>)
    })) : Promise.resolve()
  ).then(() => {
    // connect. Priority: ?site override (off by default, see vite.config.js ALLOW_SITE_IN_QUERY)
    // -> user proxy from prefs -> the built-in DEFAULT_SITE.
    const prefs = readValuesWithDefault();
    app.connect(
      (process.env.ALLOW_SITE_IN_QUERY && getQueryVariable('site'))
      || proxySiteFromPrefs(prefs)
      || process.env.DEFAULT_SITE);
    // TODO: Call onSymFont for font data when it's implemented.
    console.log("load pref from storage");
    app.onValuesPrefChange(prefs);
    // Cloud prefs (Firestore) arrive later — and keep arriving via the
    // realtime listener — and are re-applied on top; no-op unless the user
    // enabled sync by signing in before (see pref_sync.js). The callback is
    // registered unconditionally so a sign-in from PrefModal reaches the app
    // too; registering alone never loads Firebase.
    registerOnCloudValues(values => app.onValuesPrefChange(values));
    startIfPreviouslySignedIn();
    app.setInputAreaFocus();
    document.getElementById('BBSWindow').style.display = '';
    app.onWindowResize();
  })
}

function loadTable(url) {
  return fetch(url).then(response => {
    if (!response.ok)
      throw new Error('loadTable failed: ' + response.statusText + ': ' + url);
    return response.arrayBuffer();
  });
}

function loadResources() {
  Promise.all([
    loadTable(b2uTableUrl),
    loadTable(u2bTableUrl)
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
