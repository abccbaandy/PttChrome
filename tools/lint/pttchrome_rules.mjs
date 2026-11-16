// 本專案自己的 lint 規則（oxlint JS plugin，`.oxlintrc.json` 的 `jsPlugins` 載入；架構 review A5 步驟 c）。
//
// 原本這幾條是 tests/unit 裡「讀檔＋正規表示式」的靜態守護。改成走 AST 的理由：
//   - 註解、字串裡談到這些寫法不再誤判（regex 要各自剝註解，剝法每支不一樣）。
//   - regex 的盲點（`conn['send']`、`.call`、`switch (pageState) { case 3: }`）抓得到。
//   - 編輯器裡當下就紅，不用等 `yarn test:unit`。
// 規則只套 `src/**`（設定檔的 overrides），豁免的檔案也寫在設定檔，不寫在規則裡。
// 每條規則的守護自證在 tests/unit/lint_rules.test.js（RuleTester），設定沒被關掉也在那裡守。

// ---- 共用 ----

/** 成員存取的屬性名（`a.b`、`a['b']`）；取不到（計算值）回 null。 */
function propName(member) {
  if (!member || member.type !== "MemberExpression") return null;
  const p = member.property;
  if (!member.computed && p.type === "Identifier") return p.name;
  if (member.computed && p.type === "Literal" && typeof p.value === "string") return p.value;
  return null;
}

/** 識別字或成員存取的「名字」：`pageState` → pageState、`this.buf.pageState` → pageState。 */
function refName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ChainExpression") return refName(node.expression);
  return propName(node);
}

/** 數字字面值（含 `-1`）。 */
function isNumber(node) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "number") return true;
  return node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+") && isNumber(node.argument);
}

// ---- pageState 不寫魔術數字（原 tests/unit/page_state_constants.test.js 的 regex）----
// 「3 是文章、2 是列表」散在幾十個檔裡，PTT 改版要找受影響的判定時只能靠人記得 ⇒ 一律 PAGE_STATE.X。
// 名字以 pageState／PageState 結尾的變數或屬性：不准跟數字比、不准被賦數字、switch 不准 case 數字。

const PAGE_STATE_NAME = /[pP]ageState$/;
const isPageStateRef = (node) => {
  const n = refName(node);
  return !!n && PAGE_STATE_NAME.test(n);
};
const COMPARE = new Set(["===", "==", "!==", "!=", "<", "<=", ">", ">="]);
const PAGE_STATE_MSG = "pageState 不寫魔術數字，用 screen_model.js 的 PAGE_STATE.X（docs/screen-model.md）";

const noMagicPageState = {
  meta: { type: "problem", docs: { description: PAGE_STATE_MSG }, schema: [] },
  create(context) {
    const report = (node) => context.report({ node, message: PAGE_STATE_MSG });
    return {
      BinaryExpression(node) {
        if (!COMPARE.has(node.operator)) return;
        if ((isPageStateRef(node.left) && isNumber(node.right)) || (isNumber(node.left) && isPageStateRef(node.right)))
          report(node);
      },
      AssignmentExpression(node) {
        if (node.operator === "=" && isPageStateRef(node.left) && isNumber(node.right)) report(node);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier" && isPageStateRef(node.id) && isNumber(node.init)) report(node);
      },
      PropertyDefinition(node) {
        if (!node.computed && isPageStateRef(node.key) && isNumber(node.value)) report(node);
      },
      SwitchStatement(node) {
        if (!isPageStateRef(node.discriminant)) return;
        for (const c of node.cases) if (isNumber(c.test)) report(c);
      },
    };
  },
};

// ---- 送出只有 wire_send 一個出口（原 tests/unit/wire_send.test.js 第一條的 regex）----
// 傳輸層與 wire_send.js 以外，沒有人直接叫連線物件（收件者叫 conn／_conn）的送出方法；
// 閘門（prompt 開著不送、serializedOpHint…）都在原呼叫點，繞過出口等於繞過 A2 的使用權。

const SEND_METHODS = new Set([
  "send",
  "convSend",
  "sendUserKey",
  "convSendUserKey",
  "sendNaws",
  "sendWillNaws",
  "sendTimingMark",
]);
const CONN_NAMES = new Set(["conn", "_conn"]);
const isConn = (node) => {
  const n = refName(node);
  return !!n && CONN_NAMES.has(n);
};
const CONN_MSG = "送給 PTT 一律走 src/js/wire_send.js（view._send／_convSend），不直接叫 conn 的送出方法（docs/wire-send.md）";

/** `conn.send`、`this.conn?.send`、`conn['send']` 這種「conn 的送出方法」本身。 */
function isConnSendMember(node) {
  if (node && node.type === "ChainExpression") node = node.expression;
  return !!node && node.type === "MemberExpression" && SEND_METHODS.has(propName(node)) && isConn(node.object);
}

const noDirectConnSend = {
  meta: { type: "problem", docs: { description: CONN_MSG }, schema: [] },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        // conn.send(x)／conn?.send(x)／conn['send'](x)
        if (isConnSendMember(callee)) return context.report({ node, message: CONN_MSG });
        // conn.send.call(conn, x)／.apply／.bind(...)()
        const via = propName(callee);
        if ((via === "call" || via === "apply" || via === "bind") && isConnSendMember(callee.object))
          context.report({ node, message: CONN_MSG });
      },
    };
  },
};

// ---- modalShown 是推導值，禁止直接賦值（CLAUDE.md「pttchrome.modalShown 是推導值」）----
// 一律走 App.setModalOpen(source, open)：手動兩邊維護時，關閉路徑中途 throw 就會「畫面上有對話框、
// app 卻以為沒有」⇒ 焦點永久被搶回 #t。唯一寫入點是 setModalOpen 本身（那兩行用 disable 註解標明）。

const MODAL_MSG = "modalShown 是推導值，不直接賦值；開關 modal 走 App.setModalOpen(source, open)";

const noModalShownAssign = {
  meta: { type: "problem", docs: { description: MODAL_MSG }, schema: [] },
  create(context) {
    const isModalShown = (node) => refName(node) === "modalShown" && node.type !== "Identifier";
    return {
      AssignmentExpression(node) {
        if (isModalShown(node.left)) context.report({ node, message: MODAL_MSG });
      },
      UpdateExpression(node) {
        if (isModalShown(node.argument)) context.report({ node, message: MODAL_MSG });
      },
    };
  },
};

// ---- 使用者資料的鍵名只寫在 user_data_keys.js（架構 review A10，docs/user-data.md）----
// 「這台機器存了哪些東西、哪些上雲、備份涵蓋哪些」要能從一張表回答；在別的檔案直接寫
// `'pttchrome.xxx.v1'` 就是一份總表看不到的資料。檔名（`pttchrome.jsx`）不是鍵名，放行。

const STORAGE_KEY_LITERAL = /^pttchrome\.[A-Za-z]/;
const SOURCE_FILE_NAME = /^pttchrome\.(m?js|jsx)\b/;
const STORAGE_KEY_MSG =
  "localStorage 鍵名只寫在 src/js/user_data_keys.js 的 STORAGE_KEYS（並補 USER_DATA 一列、docs/user-data.md 一行）";
const isStorageKeyText = (s) => typeof s === "string" && STORAGE_KEY_LITERAL.test(s) && !SOURCE_FILE_NAME.test(s);

const noStorageKeyLiteral = {
  meta: { type: "problem", docs: { description: STORAGE_KEY_MSG }, schema: [] },
  create(context) {
    return {
      Literal(node) {
        if (isStorageKeyText(node.value)) context.report({ node, message: STORAGE_KEY_MSG });
      },
      // `pttchrome.${name}.v1` 這種拼出來的鍵名：看開頭那一段。
      TemplateLiteral(node) {
        const head = node.quasis[0] && node.quasis[0].value.cooked;
        if (typeof head === "string" && (head === "pttchrome." || isStorageKeyText(head)))
          context.report({ node, message: STORAGE_KEY_MSG });
      },
    };
  },
};

export const rules = {
  "no-magic-page-state": noMagicPageState,
  "no-direct-conn-send": noDirectConnSend,
  "no-modal-shown-assign": noModalShownAssign,
  "no-storage-key-literal": noStorageKeyLiteral,
};

export default {
  meta: { name: "pttchrome" },
  rules,
};
