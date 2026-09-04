// 上傳浮層的渲染與「不可以被終端機吃掉」的守護。
//
// 這一層**不是 modal**（終端機要繼續收鍵盤），所以擋不住 pttchrome 的 mouse_*；
// 它靠的是 (a) 每個可點元素帶 nomouse_command（App.checkClass 認得），
// (b) pttchrome 的滑鼠入口先問 isUploadLayerTarget。少了 class 這條，點面板的
// 「插入」會順便在 PTT 上送出一次滑鼠動作。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ImageUploadPanel } from "../../src/components/ImageUploadPanel";
import {
  ImageUploadOverlay,
  uploadErrorText,
} from "../../src/components/ImageUploadOverlay";
import {
  isUploadLayerTarget,
  ImageUploadController,
} from "../../src/js/image_upload_controller";
import { setupI18n, i18n } from "../../src/js/i18n";

window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));

setupI18n();

const item = {
  url: "https://i.urusai.cc/shine.png",
  deleteUrl: "https://urusai.cc/del/abcd1234",
  filename: "shine.png",
  at: 1755000000000,
};

const mountPanel = (props = {}) =>
  render(
    <MantineProvider>
      <ImageUploadPanel
        history={[item]}
        onInsert={() => {}}
        onCopy={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        onClose={() => {}}
        {...props}
      />
    </MantineProvider>,
  );

describe("ImageUploadPanel", () => {
  test("列出紀錄（縮圖直接用圖床網址，不另存圖片內容）", () => {
    mountPanel();
    expect(screen.getByText("shine.png")).toBeTruthy();
    expect(document.querySelector(".ImageUploadPanel__Thumb").src).toBe(
      item.url,
    );
  });

  test("空清單顯示空狀態", () => {
    mountPanel({ history: [] });
    expect(screen.getByText(i18n("imageUpload_historyEmpty"))).toBeTruthy();
  });

  test("按插入會帶對的網址回來", () => {
    const onInsert = vi.fn();
    mountPanel({ onInsert });
    fireEvent.click(screen.getByText(i18n("imageUpload_insert")));
    expect(onInsert).toHaveBeenCalledWith(item.url);
  });

  test("有刪除連結時給一個外開的連結", () => {
    mountPanel();
    const a = screen.getByText(i18n("imageUpload_deleteLink"));
    expect(a.getAttribute("href")).toBe(item.deleteUrl);
    expect(a.getAttribute("target")).toBe("_blank");
  });

  test("每個可點元素都帶 nomouse_command（否則點面板會連帶操作到 PTT）", () => {
    mountPanel();
    const clickable = document.querySelectorAll(
      ".ImageUploadPanel button, .ImageUploadPanel a",
    );
    expect(clickable.length).toBeGreaterThan(0);
    for (const el of clickable) {
      expect(el.className).toContain("nomouse_command");
    }
  });
});

describe("ImageUploadOverlay", () => {
  const mountOverlay = (props) =>
    render(
      <MantineProvider>
        <ImageUploadOverlay
          dragging={false}
          uploading={null}
          notice={null}
          onOpenPanel={() => {}}
          onDismiss={() => {}}
          {...props}
        />
      </MantineProvider>,
    );

  test("拖曳中顯示遮罩，且遮罩不吃指標事件（drop 綁在 window 上）", () => {
    mountOverlay({ dragging: true });
    const zone = document.querySelector(".ImageUploadDropZone");
    expect(zone).toBeTruthy();
    expect(screen.getByText(i18n("imageUpload_dropHint"))).toBeTruthy();
  });

  test("上傳中顯示第幾張／共幾張", () => {
    mountOverlay({
      uploading: { index: 2, total: 3, filename: "b.png", percent: 40 },
    });
    expect(screen.getByText(/2\/3/)).toBeTruthy();
  });

  test("成功但不在推文列時，標題說的是『已複製』而不是『已插入』", () => {
    mountOverlay({
      notice: { type: "success", mode: "clipboard", urls: [item.url], failures: [] },
    });
    expect(screen.getByText(i18n("imageUpload_insertedClipboard"))).toBeTruthy();
  });

  // 第三種目的地：長推文輸入框開著時網址插進那個 Textarea（不是終端機、不是剪貼簿）。
  test("插進輸入框時標題說的是『已插入輸入框』", () => {
    mountOverlay({
      notice: { type: "success", mode: "target", urls: [item.url], failures: [] },
    });
    expect(screen.getByText(i18n("imageUpload_insertedTarget"))).toBeTruthy();
  });

  test("送進終端機時標題仍是『已插入』", () => {
    mountOverlay({
      notice: { type: "success", mode: "send", urls: [item.url], failures: [] },
    });
    expect(screen.getByText(i18n("imageUpload_insertedSend"))).toBeTruthy();
  });

  test("失敗逐筆列出檔名與原因", () => {
    mountOverlay({
      notice: {
        type: "error",
        mode: null,
        urls: [],
        failures: [{ name: "note.txt", reason: "type" }],
      },
    });
    expect(screen.getByText(/note\.txt/)).toBeTruthy();
  });
});

describe("uploadErrorText", () => {
  test("已知原因翻成文案", () => {
    expect(uploadErrorText("size")).toBe(i18n("imageUploadErr_size"));
  });

  test("HTTP 狀態碼保留原碼供回報", () => {
    expect(uploadErrorText("http_502")).toContain("http_502");
  });

  test("圖床自己的訊息原樣顯示（不吞掉伺服器說的話）", () => {
    expect(uploadErrorText("token invalid")).toBe("token invalid");
  });
});

describe("isUploadLayerTarget", () => {
  test("浮層內的元素回 true，終端機的元素回 false", () => {
    const layer = document.createElement("div");
    layer.id = "imageUploadReact";
    const btn = document.createElement("button");
    layer.appendChild(btn);
    const outside = document.createElement("span");
    document.body.appendChild(layer);
    document.body.appendChild(outside);
    expect(isUploadLayerTarget(btn)).toBe(true);
    expect(isUploadLayerTarget(outside)).toBe(false);
    expect(isUploadLayerTarget(null)).toBe(false);
  });
});

// 插入分派：長推文輸入框註冊自己當目標之後，網址就不可以再流進終端機
// （此時底下的畫面是文章列表，每個字元都會變成快捷鍵）。
describe("ImageUploadController 的插入目標", () => {
  const makeCore = () => ({
    buf: { pageState: 6, rows: 24, cols: 80, getRowText: () => "推 me: " },
    onPasteDone: vi.fn(),
    doCopy: vi.fn(),
    setModalOpen: vi.fn(),
  });

  test("註冊目標後插進目標，終端機一個字都收不到", () => {
    const core = makeCore();
    const c = new ImageUploadController(core);
    const insert = vi.fn();
    c.setInsertTarget({ insert });
    expect(c.insertUrls(["https://i.urusai.cc/a.png"])).toBe("target");
    expect(insert).toHaveBeenCalledWith("https://i.urusai.cc/a.png");
    expect(core.onPasteDone).not.toHaveBeenCalled();
    expect(core.doCopy).not.toHaveBeenCalled();
  });

  test("清掉目標後退回原本的決策（modal 中途關掉不可以往已卸載的 state 塞字）", () => {
    const core = makeCore();
    const c = new ImageUploadController(core);
    const target = { insert: vi.fn() };
    c.setInsertTarget(target);
    c.clearInsertTarget(target);
    expect(c.insertUrls(["https://i.urusai.cc/a.png"])).toBe("send");
    expect(core.onPasteDone).toHaveBeenCalled();
    expect(target.insert).not.toHaveBeenCalled();
  });

  test("清別人的目標不會把現任目標清掉", () => {
    const core = makeCore();
    const c = new ImageUploadController(core);
    const mine = { insert: vi.fn() };
    c.setInsertTarget(mine);
    c.clearInsertTarget({ insert: () => {} });
    expect(c.insertUrls(["https://i.urusai.cc/a.png"])).toBe("target");
    expect(mine.insert).toHaveBeenCalled();
  });
});
