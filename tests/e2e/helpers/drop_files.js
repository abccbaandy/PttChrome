// 拖放上傳要用的實體檔案（real_input.js#dragFiles 的檔案來源）。
//
// 路徑必須是純 ASCII：沒設 locale（LANG/LC_ALL 空，雲端容器、部分 Docker/WSL）時，
// Chromium 對非 ASCII 檔案路徑的 CDP 拖放照樣派發 dragenter/dragover/drop，但
// dataTransfer.types 是空的（沒有 Files）⇒ app 不亮遮罩，拖放 spec 整批紅。
// 以前寫在 test.info().outputPath() 底下，那個目錄名來自 spec 標題（含中文）就中了。
// ⇒ 每次呼叫各開一個 os.tmpdir() 下的 mkdtemp 目錄（offline 是 fullyParallel，不可共用）。
// 守護：tests/unit/e2e_drop_files.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function writeDropFiles(names) {
  for (const name of names) {
    if (!/^[\x20-\x7e]+$/.test(name)) {
      throw new Error(`拖放檔名必須是純 ASCII（非 ASCII 路徑在沒設 locale 的環境會讓 dataTransfer 收不到 Files）：${name}`);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pttchrome-drop-'));
  return names.map((name) => {
    const p = path.join(dir, 'drop-' + name);
    fs.writeFileSync(p, /\.txt$/.test(name) ? 'hello' : PNG_BYTES);
    return p;
  });
}

module.exports = { writeDropFiles };
