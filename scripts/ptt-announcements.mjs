// PttCurrent 官方公告 → GitHub issue → Claude routine。
// 由 `.github/workflows/ptt-announcements.yml` 每 6 小時跑一次；沒有新公告就只抓
// 一次 feed、不寫任何東西、不叫 Claude（0 token）。設計與否決過的方案見
// docs/ptt-announcement-bot.md。
//
// 流程：
//   1. 抓 Atom feed，只留作者「系統」且標題以 [開發資訊] 開頭的 entry。
//      PTT 帳號不可能是中文的「系統」⇒ 只有站方內容會被交給 Claude 當規格。
//   2. 抓每篇全文（feed 的 content 只有前 5 行，標題也跟內文不同）。
//   3. 列出 label=ptt-announcement 的全部 issue（含 closed），用 body 第一行的
//      隱藏標記（aid＋內文 hash）去重。去重只認標記，不比標題。
//   4. 新 AID → 開 issue；hash 變了 → 更新 body＋reopen＋拿掉 claude-queued。
//      **hash 只能用內文算**：feed 的 <updated> 推文也會更新，不能拿來判斷修改。
//   5. open、沒有 claude-queued 的 issue → POST routine /fire 一次（多篇合成一次），
//      2xx 才加 claude-queued；失敗就讓 job 紅，下一輪自動重試。
//
// 用法：
//   node scripts/ptt-announcements.mjs            正常執行（需 GH_TOKEN）
//   node scripts/ptt-announcements.mjs --dry-run  只印計畫，不寫入（沒 token 也能跑）
//   node scripts/ptt-announcements.mjs --seed     照常建 issue 但不 fire（第一次執行用）
//   --repo owner/name                             預設取 GITHUB_REPOSITORY 或 git remote
//
// 環境變數：GH_TOKEN（issues:write）、CLAUDE_ROUTINE_FIRE_URL、CLAUDE_ROUTINE_TOKEN。
// exit code：0 正常（含沒有新公告）／1 抓取或解析失敗／2 設定問題（缺 token、secret）。
// **抓到的不是 Atom（Cloudflare challenge 是 HTML）一律 exit 1**，不可當成「沒有新公告」。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseRepoFromRemote } from "./ci-status.mjs";

export const FEED_URL = "https://www.ptt.cc/atom/PttCurrent.xml";
export const LABEL = "ptt-announcement";
export const QUEUED_LABEL = "claude-queued";
const API = "https://api.github.com";
// GitHub issue body 上限 65536 字元，留空間給標記與標頭。
export const MAX_BODY_CHARS = 60000;
const AID_RE = /M\.\d+\.A\.[0-9A-F]+/;

// 2026-10-02 用 git log 比對出「已經實作過」的公告（AID → commit）。這些 issue
// 一律建成 closed，不管有沒有帶 --seed ⇒ 就算第一次忘了帶 --seed，也不會把
// Claude 叫去重看舊公告。重跑是冪等的（已有標記的 AID 不會再建）。
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

// 「抓到了但內容不對」：exit 1。和設定問題（exit 2）分開。
export class FetchError extends Error {}

// ---- 純函式（unit 守護：tests/unit/ptt_announcements.test.js）----

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[k];
  });
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

// 文章頁 → { title, time, text, bodyHash }。
// - 範圍：`main-content` 開頭到 `※ 發信站` 之前。推文、`※ 編輯` 都在那之後
//   ⇒ 推文不影響 hash。
// - ptt.cc 的標頭有兩種輸出：一般是 article-metaline div，但 M.1790827526.A.744
//   這類是純文字（`作者  [系統] 看板  PttCurrent`）。兩種都先轉成「標頭行」再逐行解析。
// - hash＝標題＋去掉標頭後的內文。不含標頭行本身：同一篇文章若換了一種標頭輸出，
//   不應被當成內容修改而重新叫 Claude。
export function parseArticle(html) {
  const s = String(html || "");
  const start = s.search(/<div id="main-content"[^>]*>/);
  if (start < 0) throw new FetchError("文章頁找不到 main-content");
  const open = s.slice(start).match(/<div id="main-content"[^>]*>/)[0];
  let raw = s.slice(start + open.length);
  const sig = raw.indexOf("※ 發信站");
  if (sig >= 0) raw = raw.slice(0, sig);
  const text = decodeEntities(
    raw
      .replace(
        /<span class="article-meta-tag">([^<]*)<\/span><span class="article-meta-value">([^<]*)<\/span>/g,
        (_, k, v) => `${k}  ${v}`,
      )
      .replace(/<\/div>/g, "\n")
      .replace(/<[^>]*>/g, ""),
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
  const lines = [
    renderMarker(aid, article.bodyHash),
    `原文：${url}`,
    `發布時間：${article.time}`,
    "",
  ];
  if (handledBy) lines.push(`已處理（seed）：${handledBy}`, "");
  lines.push(`<pre>${escapeHtml(body)}</pre>`);
  if (truncated) lines.push("", `（內文超過 ${MAX_BODY_CHARS} 字已截斷，全文見原文連結）`);
  return lines.join("\n");
}

// entries：feed 全部 entry；articles：aid → parseArticle 結果；issues：GitHub issue
// （state=all）。回傳要做的寫入。closed 的 issue 也算「已存在」。
export function planActions(entries, articles, issues) {
  const known = new Map();
  for (const iss of issues || []) {
    const mk = parseMarker(iss.body);
    if (mk && !known.has(mk.aid)) known.set(mk.aid, { ...mk, number: iss.number, state: iss.state });
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

// ---- I/O ----

class ConfigError extends Error {}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function gitRemote() {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new FetchError(`GET ${url} → ${res.status}`);
  return text;
}

async function gh(p, { method = "GET", body, ok = [] } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && !ok.includes(res.status)) {
    throw new Error(`${method} ${p} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 || !res.ok ? null : res.json();
}

async function listIssues(repo) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(
      `/repos/${repo}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`,
    );
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return out;
  }
}

async function main() {
  const dryRun = flag("dry-run");
  const seed = flag("seed");
  const repo =
    arg("repo") || process.env.GITHUB_REPOSITORY || parseRepoFromRemote(gitRemote());
  if (!repo) throw new ConfigError("找不到 GitHub repo，請用 --repo owner/name。");
  if (!dryRun && !process.env.GH_TOKEN) throw new ConfigError("缺 GH_TOKEN（或改用 --dry-run）。");

  const entries = parseFeed(await fetchText(FEED_URL));
  const official = entries.filter(isOfficialAnnouncement);
  console.log(`feed ${entries.length} 筆，官方 [開發資訊] ${official.length} 篇`);
  const articles = {};
  for (const e of official) articles[e.aid] = parseArticle(await fetchText(e.url));

  const issues = process.env.GH_TOKEN ? await listIssues(repo) : [];
  if (!process.env.GH_TOKEN) console.log("（沒有 GH_TOKEN：當作 repo 裡還沒有任何公告 issue）");
  const actions = planActions(entries, articles, issues);
  for (const a of actions) {
    console.log(
      a.kind === "create"
        ? `create ${a.aid}${a.closed ? "（closed）" : ""} ${a.title}`
        : `update #${a.number} ${a.aid} hash ${a.oldHash} → ${a.newHash}`,
    );
  }
  if (actions.length === 0) console.log("沒有新公告或修改");
  if (dryRun) {
    const fake = actions
      .filter((a) => a.kind === "create" && !a.closed)
      .map((a, i) => ({ number: -(i + 1), title: a.title, state: "open", labels: [LABEL] }));
    const t = pickFireTargets([...issues, ...fake]);
    console.log(t.length ? `會 fire：${t.map((i) => i.title).join("／")}` : "不會 fire");
    return 0;
  }

  if (actions.length) {
    for (const name of [LABEL, QUEUED_LABEL]) {
      await gh(`/repos/${repo}/labels`, { method: "POST", body: { name }, ok: [422] });
    }
  }
  for (const a of actions) {
    if (a.kind === "create") {
      const iss = await gh(`/repos/${repo}/issues`, {
        method: "POST",
        body: { title: a.title, body: a.body, labels: [LABEL] },
      });
      if (a.closed) {
        await gh(`/repos/${repo}/issues/${iss.number}`, {
          method: "PATCH",
          body: { state: "closed", state_reason: "completed" },
        });
      }
      console.log(`  → #${iss.number}`);
    } else {
      await gh(`/repos/${repo}/issues/${a.number}`, {
        method: "PATCH",
        body: { title: a.title, body: a.body, state: "open" },
      });
      await gh(`/repos/${repo}/issues/${a.number}/comments`, {
        method: "POST",
        body: {
          body: `公告內容已修改（hash ${a.oldHash} → ${a.newHash}），issue 內文已換成新全文；舊版見內文的編輯紀錄。`,
        },
      });
      await gh(`/repos/${repo}/issues/${a.number}/labels/${QUEUED_LABEL}`, {
        method: "DELETE",
        ok: [404],
      });
    }
  }

  const targets = pickFireTargets(actions.length ? await listIssues(repo) : issues);
  if (targets.length === 0) return 0;
  if (seed) {
    console.log(`seed 模式不 fire（待處理 ${targets.map((i) => `#${i.number}`).join(" ")}）`);
    return 0;
  }
  const fireUrl = process.env.CLAUDE_ROUTINE_FIRE_URL;
  const fireToken = process.env.CLAUDE_ROUTINE_TOKEN;
  if (!fireUrl || !fireToken) {
    throw new ConfigError("有待處理的 issue，但缺 CLAUDE_ROUTINE_FIRE_URL／CLAUDE_ROUTINE_TOKEN。");
  }
  const res = await fetch(fireUrl, {
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
  console.log(`fired ${targets.map((i) => `#${i.number}`).join(" ")} ${sessionUrl}`);
  for (const i of targets) {
    await gh(`/repos/${repo}/issues/${i.number}/labels`, {
      method: "POST",
      body: { labels: [QUEUED_LABEL] },
    });
    if (sessionUrl) {
      await gh(`/repos/${repo}/issues/${i.number}/comments`, {
        method: "POST",
        body: { body: `已交給 Claude routine：${sessionUrl}` },
      });
    }
  }
  return 0;
}

// 收尾不用 process.exit()（Windows 上 undici keep-alive 會讓 exit code 變 127），
// 理由同 ci-status.mjs#finish。
async function finish(code) {
  process.exitCode = code;
  try {
    await globalThis[Symbol.for("undici.globalDispatcher.1")]?.close?.();
  } catch {
    /* exitCode 已經設好 */
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().then(finish, (e) => {
    console.error(e.message);
    return finish(e instanceof ConfigError ? 2 : 1);
  });
}
