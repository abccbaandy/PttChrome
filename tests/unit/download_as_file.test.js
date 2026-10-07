// @unit-env browser
// util.js#downloadAsFile：一般瀏覽器走 Blob + a[download]；Android APK 的 WebView 不處理
// a[download]／blob: 下載（錄製檔／設定備份點了什麼都不會發生、也不報錯），必須改走
// bridge 'saveFile' 交給原生「儲存檔案」對話框（docs/android-app.md）。
import { downloadAsFile } from "../../src/js/util";

function installAndroid() {
  const listeners = [];
  const sent = [];
  window.__PTT_ANDROID__ = { version: "1", site: "wstelnet://127.0.0.1:1/bbs/t" };
  window.PttAndroid = {
    postMessage: str => sent.push(JSON.parse(str)),
    addEventListener: (type, fn) => {
      if (type === "message") listeners.push(fn);
    }
  };
  const respond = out =>
    listeners.forEach(fn => fn({ data: JSON.stringify(out) }));
  return { sent, respond };
}

let clickSpy;
beforeEach(() => {
  clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
});

afterEach(() => {
  clickSpy.mockRestore();
  delete window.__PTT_ANDROID__;
  delete window.PttAndroid;
});

test("browser: clicks an a[download] anchor with the filename", () => {
  downloadAsFile("ptt-debug-1.json", '{"a":1}');
  expect(clickSpy).toHaveBeenCalledTimes(1);
  expect(clickSpy.mock.contexts[0].download).toBe("ptt-debug-1.json");
});

test("Android APK: hands the content to the native saveFile bridge, no anchor", async () => {
  const { sent, respond } = installAndroid();
  const p = downloadAsFile("ptt-debug-1.json", '{"a":1}');
  expect(clickSpy).not.toHaveBeenCalled();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    op: "saveFile",
    filename: "ptt-debug-1.json",
    mime: "application/json",
    text: '{"a":1}'
  });
  respond({ id: sent[0].id, ok: true });
  await expect(p).resolves.toMatchObject({ ok: true });
});

test("Android APK: passes an explicit mime and never rejects on native failure", async () => {
  const { sent, respond } = installAndroid();
  const p = downloadAsFile("backup.json", "x", "text/plain");
  expect(sent[0].mime).toBe("text/plain");
  respond({ id: sent[0].id, ok: false, error: "cancelled" });
  await expect(p).resolves.toMatchObject({ ok: false });
});
