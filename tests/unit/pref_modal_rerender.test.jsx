// @unit-env browser
// 設定頁改一格只重畫那一格（A7 第一步，docs/build-modernization.md「設定頁重畫」）。
//
// PrefModal 的 values 是一整個 state：改任何一個值整份元件重畫。勾選列（PrefCheckbox）
// 與灰字說明（PrefHint）包了 React.memo，props 沒變就跳過；這支測試數 Mantine
// Checkbox 的 render 次數，鎖住「點一格 ⇒ 只有被點的那格重畫」。
// 會讓它紅的改法：拿掉 memo、把 onCheckboxChange 改成每次 render 都換一個新函式、
// 在 <PrefCheckbox> 上傳 inline 物件／函式 prop。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";

const counter = vi.hoisted(() => ({ renders: new Map() }));

vi.mock("@mantine/core", async (importOriginal) => {
  const mod = await importOriginal();
  const Real = mod.Checkbox;
  const Counting = (props) => {
    counter.renders.set(props.name, (counter.renders.get(props.name) || 0) + 1);
    return <Real {...props} />;
  };
  return { ...mod, Checkbox: Object.assign(Counting, Real) };
});

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

vi.mock("../../src/js/prompt_api", () => ({
  promptApiAvailability: () => Promise.resolve("available"),
  ensurePromptApiModel: vi.fn(() => Promise.resolve("available")),
  destroyPromptApi: vi.fn(),
}));

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

test("勾一格：只有那一格的 Checkbox 重畫，其他勾選列不動", () => {
  render(
    <MantineProvider>
      <PrefModal
        show
        onSave={() => {}}
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("tab", { name: i18n("options_general") }));
  const box = document.querySelector('input[name="enablePicPreview"]');
  expect(box).not.toBeNull();
  const rowsBefore = counter.renders.size;
  // 一般分頁有八十幾個勾選列；這個數字太小代表計數包裝沒接上，測試會假綠。
  expect(rowsBefore).toBeGreaterThan(50);

  counter.renders.clear();
  fireEvent.click(box);
  expect(box).not.toBeChecked();

  // 快速搜尋分頁的三個內建項目 children 是 JSX（網址樣板的灰字），每次都是新元素 ⇒
  // memo 擋不住，只有三列，刻意不管。
  const rerendered = [...counter.renders.keys()].filter(
    (name) => !name.startsWith("quickSearchBuiltin-"),
  );
  // enablePicPreview 沒有子開關 ⇒ 除了它自己，一格都不該重畫。
  expect(rerendered).toEqual(["enablePicPreview"]);
});
