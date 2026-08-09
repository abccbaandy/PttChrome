// 設定面板「自動登入」分頁的 UI 契約（jsdom + @testing-library/react）。
// 這個分頁把原本散在「增強功能」（開關／重複登入／跳過歡迎，會上雲）與「本機設定」
// （帳號／密碼，local-only）兩處的自動登入設定集中起來，並補上 2FA 密鑰欄位。
//
// 這裡守的是三件對使用者的承諾：
//   1) 欄位空白時 placeholder 要說明「已交給密碼管理員」，不能讓人以為沒存成功；
//   2) 狀態文字要反映 localStorage 當下實際狀態（明文副本還在／已清掉／永遠不會清）；
//   3) **關閉設定頁時不會把密碼／密鑰從 localStorage 剝掉**——舊版在 store() 之後
//      立刻剝除，使用者若在瀏覽器提示按「不儲存」就兩邊都沒了。
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { PrefModal } from "../../src/components/ContextMenu/PrefModal";
import { setupI18n, i18n } from "../../src/js/i18n";
import {
  DEFAULT_PREFS,
  readValuesWithDefault,
} from "../../src/js/pref_storage";
import { packCredential } from "../../src/js/credential_pack";

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

const PREF_KEY = "pttchrome.pref.v1";
const SECRET = "ABCDEFGHIJKLMNOP";

// jsdom 沒有 matchMedia / ResizeObserver，Mantine 的 useMantineColorScheme 與
// Modal 會直接炸。最小 stub，與被測行為無關。
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
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
window.scrollTo = window.scrollTo || (() => {});

// 支援 Credential Management API 的瀏覽器（Chromium）。
const stored = [];
const installCredentialApi = () => {
  window.PasswordCredential = class PasswordCredential {
    constructor({ id, password, name }) {
      Object.assign(this, { id, password, name });
    }
  };
  navigator.credentials = {
    store: vi.fn(async (cred) => {
      stored.push(cred);
      return cred;
    }),
    get: vi.fn(async () => null),
  };
};
const removeCredentialApi = () => {
  delete window.PasswordCredential;
  delete navigator.credentials;
};

const openTab = (prefs = {}) => {
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS, ...prefs } }),
  );
  const onSave = vi.fn();
  render(
    <MantineProvider>
      <PrefModal
        show
        onSave={onSave}
        onReset={() => {}}
        debugMode={false}
        onDebugModeChange={() => {}}
      />
    </MantineProvider>,
  );
  fireEvent.click(
    screen.getByRole("tab", { name: i18n("options_autoLoginTab") }),
  );
  return onSave;
};

const field = (name) => document.querySelector(`[name="${name}"]`);
const closeDialog = () => fireEvent.click(screen.getByLabelText("Close"));

beforeAll(() => setupI18n());
beforeEach(() => {
  window.localStorage.clear();
  stored.length = 0;
  installCredentialApi();
});
afterEach(() => removeCredentialApi());

describe("自動登入分頁：欄位集中", () => {
  test("開關組與憑證組五個控制項都在這一頁", () => {
    openTab();
    const panelOf = (name) => field(name).closest('[role="tabpanel"]');
    const panel = panelOf("autoLogin");
    for (const name of [
      "autoLoginDupConn",
      "autoLoginSkipWelcome",
      "autoLoginUser",
      "autoLoginPassword",
      "autoLoginOtpSecret",
    ]) {
      expect(field(name)).toBeInTheDocument();
      expect(panelOf(name)).toBe(panel);
    }
  });

  // Mantine Tabs 預設 keepMounted，未選中的分頁仍在 DOM，所以「搬走了」只能用
  // 「落在哪個 tabpanel」來鎖（可見性那層守在 offline e2e）。
  test("已從增強功能／本機設定分頁搬走", () => {
    openTab();
    const panelOf = (name) => field(name).closest('[role="tabpanel"]');
    expect(panelOf("autoLoginUser")).not.toBe(panelOf("enableWorkMode"));
    expect(panelOf("autoLogin")).not.toBe(panelOf("blacklist"));
  });
});

describe("欄位反映 localStorage 實際狀態", () => {
  test("本機有值就顯示出來", () => {
    openTab({
      autoLoginUser: "testuser",
      autoLoginPassword: "secretpass",
      autoLoginOtpSecret: SECRET,
    });
    expect(field("autoLoginUser").value).toBe("testuser");
    expect(field("autoLoginPassword").value).toBe("secretpass");
    expect(field("autoLoginOtpSecret").value).toBe(SECRET);
  });

  // 空白 ≠ 沒存成功：placeholder 必須講清楚是誰在保管。
  test.each([
    ["autoLoginUser", "placeholder_autoLoginUser"],
    ["autoLoginPassword", "placeholder_autoLoginPassword"],
    ["autoLoginOtpSecret", "placeholder_autoLoginOtpSecret"],
  ])("%s 留空時顯示說明用的 placeholder", (name, key) => {
    openTab();
    expect(field(name).value).toBe("");
    expect(field(name)).toHaveAttribute("placeholder", i18n(key));
  });

  test("不支援密碼管理員時不給 placeholder（本機就是唯一保管處）", () => {
    removeCredentialApi();
    openTab();
    expect(field("autoLoginPassword")).not.toHaveAttribute("placeholder");
  });
});

describe("狀態說明與清除鈕", () => {
  test("本機無資料 → 說明由密碼管理員提供", () => {
    openTab();
    expect(
      screen.getByText(i18n("options_autoLoginLocalStatus_none")),
    ).toBeInTheDocument();
  });

  test("本機還有明文副本 → 說明會自動清除", () => {
    openTab({ autoLoginUser: "testuser" });
    expect(
      screen.getByText(i18n("options_autoLoginLocalStatus_pending")),
    ).toBeInTheDocument();
  });

  test("不支援密碼管理員 → 說明明文會一直保留", () => {
    removeCredentialApi();
    openTab({ autoLoginUser: "testuser" });
    expect(
      screen.getByText(i18n("options_autoLoginLocalStatus_plaintext")),
    ).toBeInTheDocument();
  });

  test("更新方式的說明有渲染出來", () => {
    openTab();
    expect(
      screen.getByText(i18n("tooltip_autoLoginUpdate")),
    ).toBeInTheDocument();
  });

  test("清除鈕清空三個欄位，且清完後反灰", () => {
    openTab({
      autoLoginUser: "testuser",
      autoLoginPassword: "secretpass",
      autoLoginOtpSecret: SECRET,
    });
    const btn = document.querySelector("#autoLoginClearLocalBtn");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(field("autoLoginUser").value).toBe("");
    expect(field("autoLoginPassword").value).toBe("");
    expect(field("autoLoginOtpSecret").value).toBe("");
    expect(btn).toBeDisabled();
  });

  test("本機本來就沒東西時清除鈕反灰", () => {
    openTab();
    expect(document.querySelector("#autoLoginClearLocalBtn")).toBeDisabled();
  });
});

// 瀏覽器密碼管理員會對「登入表單形狀」的內容自動填入、並跳出儲存提示。實測災情：
// 密鑰欄用 type=password 時，Chrome 把整頁判成登入表單，抓 autoLoginDupConn 那顆
// Select 當帳號、密鑰當密碼 → 跳出「使用者名稱：刪除其他連線 (Y)」的假儲存提示，
// 並開始自動填入（那會讓「欄位空白＝已交給密碼管理員」的說明完全失真）。
describe("不被瀏覽器密碼管理員誤判成登入表單", () => {
  test("密鑰欄不是 password 型別（整頁只留一個真正的密碼欄）", () => {
    openTab();
    // 沒寫 type 的 <input> 其 DOM property 就是 "text"，故看 property 而非 attribute。
    expect(field("autoLoginOtpSecret").type).toBe("text");
    expect(
      document.querySelectorAll('.PrefModal input[type="password"]'),
    ).toHaveLength(1);
  });

  // new-password 是 Chrome「這是變更密碼表單，別自動填」的標準訊號。
  test("密碼欄標 autocomplete=new-password", () => {
    openTab();
    expect(field("autoLoginPassword")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });

  test("沒切到這一頁時整組欄位不在 DOM（免得使用者沒在看也被自動填）", () => {
    window.localStorage.setItem(
      PREF_KEY,
      JSON.stringify({ values: { ...DEFAULT_PREFS } }),
    );
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
    // 尚未點「自動登入」分頁
    expect(field("autoLoginUser")).toBeNull();
    expect(field("autoLoginPassword")).toBeNull();
    expect(field("autoLoginOtpSecret")).toBeNull();

    fireEvent.click(
      screen.getByRole("tab", { name: i18n("options_autoLoginTab") }),
    );
    expect(field("autoLoginUser")).toBeInTheDocument();
  });
});

describe("2FA 密鑰欄位", () => {
  test("風險揭露與說明文字都有渲染", () => {
    openTab();
    expect(
      screen.getByText(i18n("tooltip_autoLoginOtpSecretRisk")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(i18n("tooltip_autoLoginOtpSecret")),
    ).toBeInTheDocument();
  });

  test("格式錯誤時顯示錯誤訊息", () => {
    openTab();
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: "ABCD0EFG" },
    });
    expect(
      screen.getByText(i18n("tooltip_autoLoginOtpSecretInvalid")),
    ).toBeInTheDocument();
  });

  test("格式正確時不顯示錯誤訊息", () => {
    openTab();
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: SECRET },
    });
    expect(
      screen.queryByText(i18n("tooltip_autoLoginOtpSecretInvalid")),
    ).not.toBeInTheDocument();
  });

  test("貼上整段 otpauth:// 網址，失焦後變成純 base32", () => {
    openTab();
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: `otpauth://totp/testuser?secret=${SECRET}&issuer=PTT` },
    });
    fireEvent.blur(field("autoLoginOtpSecret"));
    expect(field("autoLoginOtpSecret").value).toBe(SECRET);
  });
});

describe("關閉設定頁：儲存路徑", () => {
  // ★ 回歸守護：舊版 storeCredentialAndStrip 在 store() 後立刻把密碼清成 ""，
  // 使用者在瀏覽器提示按「不儲存」就兩邊都沒了。
  test("寫回 localStorage 的內容仍含密碼與密鑰（不再提早剝除）", () => {
    openTab({ autoLogin: true });
    fireEvent.change(field("autoLoginUser"), { target: { value: "testuser" } });
    fireEvent.change(field("autoLoginPassword"), {
      target: { value: "secretpass" },
    });
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: SECRET },
    });
    closeDialog();

    const v = readValuesWithDefault();
    expect(v.autoLoginUser).toBe("testuser");
    expect(v.autoLoginPassword).toBe("secretpass");
    expect(v.autoLoginOtpSecret).toBe(SECRET);
  });

  test("有密鑰時交給密碼管理員的是打包後的字串", () => {
    openTab({ autoLogin: true });
    fireEvent.change(field("autoLoginUser"), { target: { value: "testuser" } });
    fireEvent.change(field("autoLoginPassword"), {
      target: { value: "secretpass" },
    });
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: SECRET },
    });
    closeDialog();

    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("testuser");
    expect(stored[0].password).toBe(packCredential("secretpass", SECRET));
  });

  test("沒密鑰時交給密碼管理員的是裸密碼（舊版也讀得懂）", () => {
    openTab({ autoLogin: true });
    fireEvent.change(field("autoLoginUser"), { target: { value: "testuser" } });
    fireEvent.change(field("autoLoginPassword"), {
      target: { value: "secretpass" },
    });
    closeDialog();

    expect(stored[0].password).toBe("secretpass");
  });

  // 只有密鑰組不出 PasswordCredential；改由 auto_login 在下次登入成功後補存。
  test("只填密鑰不呼叫 store()，但值仍寫進 localStorage", () => {
    openTab({ autoLogin: true });
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: SECRET },
    });
    closeDialog();

    expect(stored).toHaveLength(0);
    expect(readValuesWithDefault().autoLoginOtpSecret).toBe(SECRET);
  });

  test("關閉時 otpauth:// 網址也會被正規化後才寫入", () => {
    const onSave = openTab({ autoLogin: true });
    fireEvent.change(field("autoLoginOtpSecret"), {
      target: { value: `otpauth://totp/u?secret=${SECRET}&issuer=PTT` },
    });
    closeDialog();

    expect(readValuesWithDefault().autoLoginOtpSecret).toBe(SECRET);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ autoLoginOtpSecret: SECRET }),
    );
  });
});
