// 圖片上傳（urusai）的決策層。這裡守的是「網址會被送去哪」與「什麼檔案會被擋下」，
// 不是 HTTP 細節——後者在 tests/e2e/offline/image_upload.offline.spec.js。
import {
  MAX_UPLOAD_BYTES,
  buildUploadFormData,
  decideInsertMode,
  formatInsertText,
  parseUploadResponse,
  pickUploadFiles,
  validateFile,
} from "../../src/js/image_upload";

const fakeFile = (name, type, size) => ({ name, type, size });

describe("validateFile", () => {
  test("圖片檔通過", () => {
    expect(validateFile(fakeFile("a.png", "image/png", 1024))).toEqual({
      ok: true,
    });
  });

  test("非圖片檔擋下（PTT 貼影片沒有 client 會播，50MB 上傳成本卻是真的）", () => {
    expect(validateFile(fakeFile("a.txt", "text/plain", 10))).toEqual({
      ok: false,
      reason: "type",
    });
    expect(validateFile(fakeFile("a.mp4", "video/mp4", 10))).toEqual({
      ok: false,
      reason: "type",
    });
  });

  test("超過 50MB 擋下（urusai 的單檔上限）", () => {
    expect(
      validateFile(fakeFile("big.png", "image/png", MAX_UPLOAD_BYTES + 1)),
    ).toEqual({ ok: false, reason: "size" });
    expect(
      validateFile(fakeFile("edge.png", "image/png", MAX_UPLOAD_BYTES)),
    ).toEqual({ ok: true });
  });

  test("空值不炸（拖進來的東西不一定是 File）", () => {
    expect(validateFile(null).ok).toBe(false);
    expect(validateFile({}).ok).toBe(false);
  });
});

describe("pickUploadFiles", () => {
  test("被擋下的要帶理由回來（不可以靜默少傳一張）", () => {
    const { accepted, rejected } = pickUploadFiles([
      fakeFile("ok.png", "image/png", 100),
      fakeFile("note.txt", "text/plain", 100),
      fakeFile("huge.jpg", "image/jpeg", MAX_UPLOAD_BYTES + 1),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(rejected).toEqual([
      { name: "note.txt", reason: "type" },
      { name: "huge.jpg", reason: "size" },
    ]);
  });

  test("沒有檔案時回空（null/undefined 不炸）", () => {
    expect(pickUploadFiles(null)).toEqual({ accepted: [], rejected: [] });
  });
});

describe("parseUploadResponse", () => {
  const success = JSON.stringify({
    status: "success",
    message: "uploaded",
    data: {
      id: "shine",
      r18: "0",
      filename: "urusai.png",
      url_preview: "https://i.urusai.cc/shine",
      url_direct: "https://i.urusai.cc/shine.png",
      url_delete: "https://urusai.cc/del/abcd1234",
      mime: "image/png",
    },
  });

  test("成功時取 url_direct（帶副檔名的才會被好讀模式自動開圖）", () => {
    const r = parseUploadResponse(success, 200);
    expect(r.ok).toBe(true);
    expect(r.url).toBe("https://i.urusai.cc/shine.png");
    expect(r.previewUrl).toBe("https://i.urusai.cc/shine");
    expect(r.deleteUrl).toBe("https://urusai.cc/del/abcd1234");
    expect(r.filename).toBe("urusai.png");
  });

  test("status 不是 success → 失敗並帶回伺服器的說法", () => {
    const r = parseUploadResponse(
      JSON.stringify({ status: "error", message: "token invalid" }),
      200,
    );
    expect(r.ok).toBe(false);
    expect(r.message).toBe("token invalid");
  });

  test("data 缺 url_direct → 失敗（不可以回一個 undefined 網址去打字）", () => {
    const r = parseUploadResponse(
      JSON.stringify({ status: "success", data: { id: "x" } }),
      200,
    );
    expect(r.ok).toBe(false);
    expect(r.url).toBeUndefined();
  });

  test("非 JSON（Cloudflare 錯誤頁之類）→ 帶 HTTP 狀態碼", () => {
    const r = parseUploadResponse("<html>502</html>", 502);
    expect(r).toEqual({ ok: false, message: "http_502" });
  });
});

describe("decideInsertMode", () => {
  test("編輯文章（pageState 6）→ 直接送進終端機", () => {
    expect(decideInsertMode({ pageState: 6, lastRowText: "" })).toBe("send");
  });

  // bbs.c#recommend 的 prompt 是 sprintf("%s%s%s %s:", ctype_attr, ctype, RESET, myid)，
  // ctype = 推／噓／→ 三種（型別選單按 1/2/3）。只認 → 的話，最常用的「推」一律
  // 掉到 clipboard ⇒ 使用者看到的症狀就是「上傳完都說不在推文框」。
  test.each([
    ["推 someuser: ", "推"],
    ["噓 someuser: ", "噓"],
    ["→ someuser: ", "→"],
  ])("推文輸入列（型別符 %s）→ 直接送進終端機", (lastRowText) => {
    expect(decideInsertMode({ pageState: 0, lastRowText })).toBe("send");
  });

  test("id 後補空白對齊（aligncmt 板）仍算輸入列", () => {
    expect(
      decideInsertMode({ pageState: 0, lastRowText: "推 someuser  : " }),
    ).toBe("send");
  });

  test("型別選單不算輸入列 → 只複製（vkey 只吃 1 byte，送網址會被吃掉首字）", () => {
    expect(
      decideInsertMode({
        pageState: 0,
        lastRowText:
          "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? ",
      }),
    ).toBe("clipboard");
  });

  test("確認列不算輸入列 → 只複製（ans 只吃 1 字元，送網址＝非 y ＝整則取消）", () => {
    expect(
      decideInsertMode({
        pageState: 0,
        lastRowText: "推 someuser: 已經打好的內容            確定[y/N]:",
      }),
    ).toBe("clipboard");
  });

  test("擋人／冷卻橫幅不算輸入列 → 只複製", () => {
    expect(
      decideInsertMode({
        pageState: 0,
        lastRowText: " ◆ 本板禁止快速連續推文，請再等 20 秒      [按任意鍵繼續]",
      }),
    ).toBe("clipboard");
  });

  test("已完成的推文（尾端有時間戳）不算輸入列 → 只複製", () => {
    expect(
      decideInsertMode({
        pageState: 3,
        lastRowText: "→ someuser: 這是一則推文                    08/20 12:34",
      }),
    ).toBe("clipboard");
    expect(
      decideInsertMode({
        pageState: 3,
        lastRowText: "推 someuser: 這是一則推文                    08/20 12:34",
      }),
    ).toBe("clipboard");
  });

  test("看板列表／閱讀畫面 → 只複製（送字等於亂按指令）", () => {
    expect(
      decideInsertMode({
        pageState: 2,
        lastRowText: "  文章選讀  (y)回應(X%)推文(h)說明(←)離開 ",
      }),
    ).toBe("clipboard");
    expect(decideInsertMode({ pageState: 0, lastRowText: "" })).toBe(
      "clipboard",
    );
  });
});

describe("formatInsertText", () => {
  test("多檔以空白分隔，一次插入", () => {
    expect(formatInsertText(["https://a/1.png", "https://a/2.png"])).toBe(
      "https://a/1.png https://a/2.png",
    );
  });

  test("空值濾掉（失敗的那張不該留下空格）", () => {
    expect(formatInsertText([null, "https://a/1.png", ""])).toBe(
      "https://a/1.png",
    );
    expect(formatInsertText([])).toBe("");
  });
});

describe("buildUploadFormData", () => {
  test("token 留空仍照送欄位（與官方 curl 範例一致），r18 固定 0", () => {
    const form = buildUploadFormData(new Blob(["x"]), {});
    expect(form.get("token")).toBe("");
    expect(form.get("r18")).toBe("0");
    expect(form.get("file")).toBeTruthy();
  });

  test("有 token 時帶上（圖片才會歸在使用者的 urusai 帳號下）", () => {
    const form = buildUploadFormData(new Blob(["x"]), { token: "abc123" });
    expect(form.get("token")).toBe("abc123");
  });
});
