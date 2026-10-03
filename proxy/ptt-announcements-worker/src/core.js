// PttCurrent 官方公告 → GitHub issue → Claude routine 的核心邏輯。
// 正式環境由本目錄的 Cloudflare Worker cron 每 6 小時跑（src/index.js）；本機可用
// `node scripts/ptt-announcements.mjs --dry-run` 跑同一份邏輯。設計與否決過的方案見
// docs/ptt-announcement-bot.md。
//
// 為什麼是 Worker 不是 GitHub Actions：ptt.cc 的 Cloudflare 對 Actions runner 的 IP
// 回 403（2026-10-02 實跑），本機與 Cloudflare 網路內則抓得到。
//
// 流程（sync）：
//   1. 抓 Atom feed，只留作者「系統」且標題以 [開發資訊] 開頭的 entry。
//      PTT 帳號不可能是中文的「系統」⇒ 只有站方內容會被交給 Claude 當規格。
//   2. 抓每篇全文（feed 的 content 只有前 5 行，標題也跟內文不同）。
//   3. 列出 label=ptt-announcement 的全部 issue（含 closed），用 body 第一行的
//      隱藏標記（aid＋內文 hash）去重。去重只認標記，不比標題。
//   4. 新 AID → 開 issue；hash 變了 → 更新 body＋reopen＋拿掉 claude-queued。
//      **hash 只能用內文算**：feed 的 <updated> 推文也會更新，不能拿來判斷修改。
//   5. open、沒有 claude-queued 的 issue → POST routine /fire 一次（多篇合成一次），
//      2xx 才加 claude-queued；失敗就丟錯，下一輪自動重試。
//
// 這個檔只能用 Web 標準 API ＋ `node:crypto`（Worker 開 nodejs_compat），不可 import
// 其他 node 模組或 repo 裡的檔案：wrangler 會把它打包進 Worker。
import { createHash } from "node:crypto";

export const FEED_URL = "https://www.ptt.cc/atom/PttCurrent.xml";
export const LABEL = "ptt-announcement";
export const QUEUED_LABEL = "claude-queued";
// bot 自己失敗時開的 issue（Worker cron 失敗只進 Cloudflare log，沒人會看）。
export const ERROR_LABEL = "ptt-announcement-bot-error";
const API = "https://api.github.com";
// GitHub 的 REST API 拒絕沒有 User-Agent 的請求，而 Worker 的 fetch 預設不帶。
const GH_UA = "ptt-announcements-worker";
// GitHub issue body 上限 65536 字元，留空間給標記與標頭。
export const MAX_BODY_CHARS = 60000;
const AID_RE = /M\.\d+\.A\.[0-9A-F]+/;

// 2026-10-02 用 git log 比對出「已經實作過」的公告（AID → commit）。這些 issue
// 一律建成 closed，不管有沒有帶 seed ⇒ 第一次執行不會把 Claude 叫去重看舊公告。
// 重跑是冪等的（已有標記的 AID 不會再建）。
export const SEED_HANDLED = {
  "M.1790734943.A.8D4": "35f6e4d",
  "M.1790697156.A.14E": "35f6e4d",
  "M.1790662175.A.563": "35f6e4d",
  "M.1790178013.A.9FB": "6675b68",
  "M.1789918206.A.BF3": "5596f76",
  "M.1789902495.A.1C6": "d9e09c8、2aaf041",
  "M.1789836427.A.6B9": "d9e09c8",
  "M.1789835221.A.6AC": "d9e09c8（刻意 no-op；分色渲染見 docs/handoff/sgr66-render.md）",
  "M.1789835206.A.7DE": "6e59941、d9e09c8",
  "M.1789835193.A.E46": "6e59941",
  "M.1789835163.A.633": "d9e09c8",
};

// 「抓到了但內容不對」（CLI exit 1）。和設定問題分開。
export class FetchError extends Error {}
// 缺 token／secret（CLI exit 2）。
export class ConfigError extends Error {}

// ---- 純函式 ----

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
  });
}

// 剝到穩定為止：單輪剝除遇到巢狀／殘缺 tag 可能留下新的 tag 片段
// （CodeQL js/incomplete-multi-character-sanitization）。最終輸出另有 escapeHtml 把關。
export function stripTags(s) {
  let prev;
  let out = String(s);
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out;
}

const tagText = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1]).trim() : "";
};

// Atom feed → [{ title, url, aid, author, published }]。
// 不是 Atom、或一筆 entry 都沒有 ⇒ 丟 FetchError（Cloudflare challenge／維護頁），
// **不可以**回空陣列，那會被當成「沒有新公告」而永遠沉默。
export function parseFeed(xml) {
  const s = String(xml || "");
  if (!/<feed[^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(s)) {
    throw new FetchError(`feed 不是 Atom（開頭：${s.slice(0, 80).replace(/\s+/g, " ")}）`);
  }
  const entries = [];
  for (const [, e] of s.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const link = e.match(/<link[^>]*href="([^"]+)"/);
    const url = link ? decodeEntities(link[1]) : tagText(e, "id");
    const aid = (url.match(AID_RE) || [])[0] || null;
    const am = e.match(/<author>([\s\S]*?)<\/author>/);
    const author = am ? tagText(am[1], "name") : "";
    entries.push({ title: tagText(e, "title"), url, aid, author, published: tagText(e, "published") });
  }
  if (entries.length === 0) throw new FetchError("feed 是 Atom 但沒有任何 entry");
  return entries;
}

export function isOfficialAnnouncement(entry) {
  return !!entry && !!entry.aid && entry.author === "系統" && entry.title.startsWith("[開發資訊]");
}

const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// 文章頁 → { title, time, body, bodyHash }。
// - 範圍：`main-content` 開頭到 `※ 發信站` 之前。推文、`※ 編輯` 都在那之後
//   ⇒ 推文不影響 hash。
// - ptt.cc 的標頭有兩種輸出：一般是 article-metaline div，但 M.1790827526.A.744
//   這類是純文字（`作者  [系統] 看板  PttCurrent`）。兩種都先轉成「標頭行」再逐行解析。
// - hash＝標題＋去掉標頭後的內文。不含標頭行本身：同一篇文章若換了一種標頭輸出，
//   不應被當成內容修改而重新叫 Claude。
export function parseArticle(html) {
  const s = String(html || "");
  const open = s.match(/<div id="main-content"[^>]*>/);
  if (!open) throw new FetchError("文章頁找不到 main-content");
  let raw = s.slice(open.index + open[0].length);
  const sig = raw.indexOf("※ 發信站");
  if (sig >= 0) raw = raw.slice(0, sig);
  const text = decodeEntities(
    stripTags(
      raw
        .replace(
          /<span class="article-meta-tag">([^<]*)<\/span><span class="article-meta-value">([^<]*)<\/span>/g,
          (_, k, v) => `${k}  ${v}`,
        )
        .replace(/<\/div>/g, "\n"),
    ),
  )
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));

  const header = {};
  let i = 0;
  for (; i < text.length; i++) {
    const m = text[i].match(/^(作者|看板|標題|時間)\s+(.*)$/);
    if (!m) break;
    header[m[1]] = m[2].trim();
  }
  if (!header["標題"]) throw new FetchError("文章頁找不到標題行");
  const body = text.slice(i).join("\n").replace(/^\n+/, "").trimEnd();
  return {
    title: header["標題"],
    time: header["時間"] || "",
    body,
    bodyHash: sha16(`${header["標題"]}\n${body}`),
  };
}

const MARKER_RE = /^<!-- ptt-announcement aid=(M\.\d+\.A\.[0-9A-F]+) hash=([0-9a-f]{16}) -->/;

export function renderMarker(aid, bodyHash) {
  return `<!-- ptt-announcement aid=${aid} hash=${bodyHash} -->`;
}

export function parseMarker(issueBody) {
  const m = String(issueBody || "").match(MARKER_RE);
  return m ? { aid: m[1], bodyHash: m[2] } : null;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 全文用 <pre> 包並跳脫 < > &（不用 ``` ：原文可能含反引號）。**不收推文**：
// 推文是一般使用者寫的，不是規格，也是 prompt injection 的入口。
export function renderIssueBody({ aid, url, article, handledBy }) {
  let body = article.body;
  let truncated = false;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    truncated = true;
  }
  const lines = [renderMarker(aid, article.bodyHash), `原文：${url}`, `發布時間：${article.time}`, ""];
  if (handledBy) lines.push(`已處理（seed）：${handledBy}`, "");
  lines.push(`<pre>${escapeHtml(body)}</pre>`);
  if (truncated) lines.push("", `（內文超過 ${MAX_BODY_CHARS} 字已截斷，全文見原文連結）`);
  return lines.join("\n");
}

// entries：feed 全部 entry；articles：aid → parseArticle 結果；issues：GitHub issue
// （state=all）。回傳要做的寫入，舊公告在前。closed 的 issue 也算「已存在」。
export function planActions(entries, articles, issues) {
  const known = new Map();
  for (const iss of issues || []) {
    const mk = parseMarker(iss.body);
    if (mk && !known.has(mk.aid)) known.set(mk.aid, { ...mk, number: iss.number });
  }
  const actions = [];
  const seen = new Set();
  // feed 新的在前；反過來建，issue 編號才會跟發布順序一致。
  for (const e of entries.filter(isOfficialAnnouncement).reverse()) {
    if (seen.has(e.aid)) continue;
    seen.add(e.aid);
    const article = articles[e.aid];
    if (!article) throw new FetchError(`缺少 ${e.aid} 的全文`);
    const prev = known.get(e.aid);
    if (!prev) {
      const handledBy = SEED_HANDLED[e.aid];
      actions.push({
        kind: "create",
        aid: e.aid,
        title: article.title,
        body: renderIssueBody({ aid: e.aid, url: e.url, article, handledBy }),
        closed: !!handledBy,
      });
    } else if (prev.bodyHash !== article.bodyHash) {
      actions.push({
        kind: "update",
        aid: e.aid,
        number: prev.number,
        title: article.title,
        body: renderIssueBody({ aid: e.aid, url: e.url, article }),
        oldHash: prev.bodyHash,
        newHash: article.bodyHash,
      });
    }
  }
  return actions;
}

// 每個 action 會花掉的 GitHub 請求數（Worker 有 subrequest 上限，見 sync）。
export const actionCost = (a) => (a.kind === "create" ? (a.closed ? 2 : 1) : 3);
// fire 一次＝/fire＋每個 issue 加 label＋留言。
export const fireCost = (n) => 1 + 2 * n;

const labelNames = (iss) => (iss.labels || []).map((l) => (typeof l === "string" ? l : l.name));

// 要交給 Claude 的 issue：open、帶 ptt-announcement、沒帶 claude-queued。
export function pickFireTargets(issues) {
  return (issues || [])
    .filter((i) => !i.pull_request && i.state === "open")
    .filter((i) => {
      const names = labelNames(i);
      return names.includes(LABEL) && !names.includes(QUEUED_LABEL);
    })
    .sort((a, b) => a.number - b.number);
}

export function renderFireText(repo, targets) {
  return [
    `repo ${repo} 有 ${targets.length} 個待處理的 PttCurrent 公告 issue：`,
    ...targets.map((i) => `#${i.number} ${i.title} https://github.com/${repo}/issues/${i.number}`),
  ].join("\n");
}

// `wrangler secret put` 是手貼的：去掉前後空白與成對引號（routine token 另外去掉
// `Bearer ` 前綴，網頁上的 curl 範例就是帶前綴的那一串）。
export function cleanSecret(v) {
  return String(v || "")
    .trim()
    .replace(/^(["'])(.*)\1$/s, "$2")
    .trim();
}

// ---- I/O（fetch 由呼叫端注入：Worker 傳全域 fetch，unit test 傳假的）----

function makeClient({ fetch, env, limit }) {
  let used = 0;
  const call = async (url, init) => {
    if (used >= limit) throw new Error(`subrequest 超過上限 ${limit}`);
    used++;
    return fetch(url, init);
  };
  const text = async (url) => {
    const res = await call(url);
    const body = await res.text();
    if (!res.ok) throw new FetchError(`GET ${url} → ${res.status}`);
    return body;
  };
  const gh = async (p, { method = "GET", body, ok = [] } = {}) => {
    const res = await call(`${API}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GH_UA,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !ok.includes(res.status)) {
      throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
    }
    return res.status === 204 || !res.ok ? null : res.json();
  };
  return { call, text, gh, used: () => used, left: () => limit - used };
}

async function listIssues(gh, repo, label, state) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${repo}/issues?labels=${label}&state=${state}&per_page=100&page=${page}`);
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return out;
  }
}

// 跑一輪。回傳 { actions, deferred, fired }。
// - dryRun：只讀不寫（沒有 GH_TOKEN 也能跑，當作 repo 裡沒有 issue）。
// - seed：照常建 issue 但不 fire。
// - subrequestLimit：Cloudflare Workers 免費方案一次執行最多 50 個 subrequest。
//   寫入前先算預算，不夠就把剩下的 action 留到下一輪（冪等：靠標記去重），
//   而且**一定先保留 fire＋貼 label 的額度**：fire 成功卻沒貼上 claude-queued，
//   下一輪就會重複叫 Claude。
export async function sync({ fetch, env, log = () => {}, dryRun = false, seed = false, subrequestLimit = Infinity }) {
  const repo = env.GITHUB_REPO;
  if (!repo) throw new ConfigError("缺 GITHUB_REPO。");
  if (!dryRun && !env.GH_TOKEN) throw new ConfigError("缺 GH_TOKEN。");
  const c = makeClient({ fetch, env, limit: subrequestLimit });

  const entries = parseFeed(await c.text(FEED_URL));
  const official = entries.filter(isOfficialAnnouncement);
  log(`feed ${entries.length} 筆，官方 [開發資訊] ${official.length} 篇`);
  const articles = {};
  for (const e of official) articles[e.aid] = parseArticle(await c.text(e.url));

  const issues = env.GH_TOKEN ? await listIssues(c.gh, repo, LABEL, "all") : [];
  const actions = planActions(entries, articles, issues);
  for (const a of actions) {
    log(
      a.kind === "create"
        ? `create ${a.aid}${a.closed ? "（closed）" : ""} ${a.title}`
        : `update #${a.number} ${a.aid} hash ${a.oldHash} → ${a.newHash}`,
    );
  }
  if (actions.length === 0) log("沒有新公告或修改");

  // 之後的 fire 判斷用記憶體裡的 issue 狀態，不重新 list（省 subrequest）。
  const state = issues.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: labelNames(i) }));
  const pendingNow = () => pickFireTargets(state).length;

  if (dryRun) {
    let n = -1;
    for (const a of actions.filter((x) => x.kind === "create" && !x.closed)) {
      state.push({ number: n--, title: a.title, state: "open", labels: [LABEL] });
    }
    const t = pickFireTargets(state);
    log(t.length ? `會 fire：${t.map((i) => i.title).join("／")}` : "不會 fire");
    return { actions, deferred: [], fired: false };
  }

  const done = [];
  const deferred = [];
  for (const a of actions) {
    const opensOne = a.kind === "update" || !a.closed ? 1 : 0;
    const reserve = seed ? 0 : fireCost(pendingNow() + opensOne);
    if (deferred.length || c.left() < actionCost(a) + reserve) {
      deferred.push(a);
      continue;
    }
    if (a.kind === "create") {
      // labels 不存在時 GitHub 會自動建立，不必先 POST /labels。
      const iss = await c.gh(`/repos/${repo}/issues`, {
        method: "POST",
        body: { title: a.title, body: a.body, labels: [LABEL] },
      });
      if (a.closed) {
        await c.gh(`/repos/${repo}/issues/${iss.number}`, {
          method: "PATCH",
          body: { state: "closed", state_reason: "completed" },
        });
      }
      state.push({ number: iss.number, title: a.title, state: a.closed ? "closed" : "open", labels: [LABEL] });
      log(`  → #${iss.number}`);
    } else {
      await c.gh(`/repos/${repo}/issues/${a.number}`, {
        method: "PATCH",
        body: { title: a.title, body: a.body, state: "open" },
      });
      await c.gh(`/repos/${repo}/issues/${a.number}/comments`, {
        method: "POST",
        body: { body: `公告內容已修改（hash ${a.oldHash} → ${a.newHash}），issue 內文已換成新全文；舊版見內文的編輯紀錄。` },
      });
      await c.gh(`/repos/${repo}/issues/${a.number}/labels/${QUEUED_LABEL}`, { method: "DELETE", ok: [404] });
      const s = state.find((i) => i.number === a.number);
      Object.assign(s, { title: a.title, state: "open", labels: s.labels.filter((l) => l !== QUEUED_LABEL) });
    }
    done.push(a);
  }
  if (deferred.length) log(`subrequest 額度不夠，${deferred.length} 筆留到下一輪`);

  const targets = pickFireTargets(state);
  if (targets.length === 0) return { actions: done, deferred, fired: false };
  if (seed) {
    log(`seed 模式不 fire（待處理 ${targets.map((i) => `#${i.number}`).join(" ")}）`);
    return { actions: done, deferred, fired: false };
  }
  const fireUrl = cleanSecret(env.CLAUDE_ROUTINE_FIRE_URL);
  const fireToken = cleanSecret(env.CLAUDE_ROUTINE_TOKEN).replace(/^Bearer\s+/i, "");
  if (!fireUrl || !fireToken) {
    throw new ConfigError("有待處理的 issue，但缺 CLAUDE_ROUTINE_FIRE_URL／CLAUDE_ROUTINE_TOKEN。");
  }
  if (c.left() < fireCost(targets.length)) {
    log("subrequest 額度不夠 fire，留到下一輪");
    return { actions: done, deferred, fired: false };
  }
  const res = await c.call(fireUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fireToken}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: renderFireText(repo, targets) }),
  });
  const fired = await res.text();
  if (!res.ok) throw new Error(`routine fire → ${res.status} ${fired}`);
  let sessionUrl = "";
  try {
    sessionUrl = JSON.parse(fired).claude_code_session_url || "";
  } catch {
    /* 回應格式變了也不影響：fire 已成功 */
  }
  log(`fired ${targets.map((i) => `#${i.number}`).join(" ")} ${sessionUrl}`);
  for (const i of targets) {
    await c.gh(`/repos/${repo}/issues/${i.number}/labels`, { method: "POST", body: { labels: [QUEUED_LABEL] } });
    await c.gh(`/repos/${repo}/issues/${i.number}/comments`, {
      method: "POST",
      body: { body: sessionUrl ? `已交給 Claude routine：${sessionUrl}` : "已交給 Claude routine。" },
    });
  }
  return { actions: done, deferred, fired: true };
}

// Worker cron 失敗只會進 Cloudflare 的 log ⇒ 開一個 issue 讓人看得到（GitHub 會寄通知）。
// 已有 open 的錯誤 issue 就不再開（每 6 小時一封太吵）；恢復正常時自動關掉。
// 自己的 GitHub 請求失敗（例如 PAT 過期）就放棄，只剩 Cloudflare log。
export async function reportStatus({ fetch, env, error, log = () => {} }) {
  if (!env.GH_TOKEN || !env.GITHUB_REPO) return;
  const { gh } = makeClient({ fetch, env, limit: 4 });
  const repo = env.GITHUB_REPO;
  try {
    const open = await listIssues(gh, repo, ERROR_LABEL, "open");
    if (error && open.length === 0) {
      await gh(`/repos/${repo}/issues`, {
        method: "POST",
        body: {
          title: "PttCurrent 公告 bot 執行失敗",
          body: `Worker cron 執行失敗，恢復後會自動關閉。\n\n\`\`\`\n${String(error.message || error).slice(0, 2000)}\n\`\`\``,
          labels: [ERROR_LABEL],
        },
      });
    } else if (!error && open.length) {
      await gh(`/repos/${repo}/issues/${open[0].number}`, {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      });
    }
  } catch (e) {
    log(`回報狀態失敗：${e.message}`);
  }
}
