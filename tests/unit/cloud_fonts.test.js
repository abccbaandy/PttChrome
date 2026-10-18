// 雲端 session 的字型對齊 CI（scripts/cloud-fonts.mjs）。容器多了 DejaVu ⇒ monospace 落到
// DejaVu Sans Mono ⇒ screen_sanity 格線在雲端必紅、CI 卻綠。鎖的是：排除設定檔的內容、冪等、
// 沒有 DejaVu 的環境不寫，以及兩個呼叫端都有接（新環境的 Setup script、快取環境的 SessionStart hook）。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureCiFontParity, fontConfXml, REJECT_DIRS } from "../../scripts/cloud-fonts.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function fakeFs(existing = {}, dirs = REJECT_DIRS) {
  const files = { ...existing };
  return {
    files,
    existsSync: (p) => dirs.includes(p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    mkdirSync: () => {},
    writeFileSync: (p, s) => {
      files[p] = s;
    },
  };
}

test("排除的是 DejaVu（rejectfont），不是刪套件", () => {
  const xml = fontConfXml();
  expect(xml).toMatch(/<rejectfont>/);
  expect(xml).toContain("<glob>/usr/share/fonts/truetype/dejavu/*</glob>");
});

test("有 DejaVu ⇒ 寫一次；再跑一次不重寫（冪等）", () => {
  const f = fakeFs();
  expect(ensureCiFontParity({ fsImpl: f, confPath: "/c.conf" })).toBe("written");
  expect(f.files["/c.conf"]).toBe(fontConfXml());
  expect(ensureCiFontParity({ fsImpl: f, confPath: "/c.conf" })).toBe("present");
});

test("沒有 DejaVu 的環境（CI image）⇒ 什麼都不寫", () => {
  const f = fakeFs({}, []);
  expect(ensureCiFontParity({ fsImpl: f, confPath: "/c.conf" })).toBe("absent");
  expect(f.files).toEqual({});
});

test("兩個呼叫端都有接：cloud-setup.sh（新環境）與 SessionStart hook（快取環境）", () => {
  const setup = read("../../scripts/cloud-setup.sh")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  expect(setup).toMatch(/node scripts\/cloud-fonts\.mjs/);
  const hook = read("../../scripts/check-remote-commits.mjs");
  expect(hook).toMatch(/import \{ ensureCiFontParity \} from '\.\/cloud-fonts\.mjs'/);
  expect(hook).toMatch(/ensureCiFontParity\(\)/);
});
