# 离线重放测试（byte cassette）

把会过期的「特定文章」e2e 素材永久化：录一次真实 PTT 的 byte 流 → 之后不连网确定性重放并断言。
解决 `tests/e2e/*.spec.js` 依赖特定文章（过期就 `test.skip`、回归失守）的问题。

## 为什么不是单一静态快照
好读模式是**互动式翻页**：靠 `EasyReading._send('\x1b[6~')`（`src/js/easy_reading.js:82,318`）主动向 server 要下一页，
逐页累进 `termBuf.pageLines`（`src/js/term_view.js:814 accumulatePageLines` + `comment_parse.findPageOverlap` 去重）。
「第一则推文消失 / 楼号错位」是跨页累积产生 → 必须忠实重放逐页节奏。

## 架构（单一录制源，两层消费）
```
一次真实录制(guest) → recorder
   ├─ tests/e2e/cassettes/<name>.json        → Layer1 Playwright 离线重放（真浏览器/真渲染）
   └─ tests/unit/fixtures/replay/<name>.page.json → Layer2 jest 纯逻辑（node, 秒级）
```
- **注入点**：stub `window.WebSocket`（不连网、吞 send）让 app 离线 boot；把 cassette 每页 recv 喂回
  `App.onData`（`src/js/pttchrome.js:252`，= 真实 parser→termBuf→`<Screen>`）；以好读自己送出的
  `\x1b[6~`/`\x1b[4~` 当「放下一页」门控。见 `tests/e2e/helpers/replay.js`。
- **Layer1**：产出真实 DOM → 可跑现有全部断言（翻页回归 / 楼层 / 黑名单 / pusher / 列表）。
- **Layer2**：用 *真实* `findPageOverlap` 从「每页文字快照」重建累积（镜像 accumulatePageLines），
  纯 node 守护去重 off-by-one + FloorCounter + blacklist。见 `tests/unit/replay_fixture.test.js`。

## 档案格式
cassette（`tests/e2e/cassettes/<name>.json`）：
```
{ meta:{mode:"article"|"list", board, recordedAs:"guest", pages, commentCount, firstCommentAuthor},
  cols:80, rows:24,
  steps:[ {on:"start",recv:"<base64 latin1>"}, {on:"pagedown",recv:...}, ... {on:"end",recv:...}? ] }
```
- `recv` = 录制时 `App.onData` 收到的 post-telnet bytes（Big5+ANSI），latin1 逐字节 base64。
- player 立即喂所有 `start`；之后每侦测到 `\x1b[6~`→喂下一 `pagedown`、`\x1b[4~`→喂 `end`。
- `list` 模式只有单一 `start`（pageState 2 列表画面），重放时 `easyReading:false`。

fixture（`tests/unit/fixtures/replay/<name>.page.json`）：
```
{ meta, pageScreens:[[24列settled文字],...], golden:{comments[], commentCount, firstCommentAuthor} }
```

## 录制（一次性，连真实 PTT）
环境变量：`RECORD_MODE`(article|list)、`RECORD_BOARD`、`RECORD_NAME`、`RECORD_MAX_PAGES`(预设 12，0=不限)、
`RECORD_SEARCH`(article：'/' 标题搜寻指定文章，过期则抛错)、`RECORD_END`(article：加录 End→原生的 'end' step)、
`RECORD_ALLOW_LOGIN`(用 env 帐密登入)、`RECORD_REDACT_EXTRA`("id1,id2" 额外要等长遮蔽的 id，
用于 Fw 转录文「※ 转录者: <自己另一个 id>」≠ 登入帐号的情形)。
```
# 指定文章（如黃仁勳那篇 #1g8znzQ3，golden 首推 bluebird5566）+ 加录 End 场景
$env:RECORD_ALLOW_LOGIN="1"; $env:RECORD_MODE="article"; $env:RECORD_BOARD="Stock"
$env:RECORD_SEARCH="黃仁勳喊話增產成功"; $env:RECORD_NAME="stock-huang"; yarn record:cassette
# article（最新一篇）+ End step（供 End→原生 测试）
$env:RECORD_ALLOW_LOGIN="1"; $env:RECORD_END="1"; $env:RECORD_MAX_PAGES="4"; $env:RECORD_MODE="article"
$env:RECORD_BOARD="Stock"; $env:RECORD_NAME="stock-end"; yarn record:cassette
# list（看板列表）
$env:RECORD_ALLOW_LOGIN="1"; $env:RECORD_MODE="list"; $env:RECORD_BOARD="C_Chat"; $env:RECORD_NAME="cchat-list"; yarn record:cassette
```
offline spec 遍历所有 article cassette 逐卷守门；End 测试自动挑带 'end' step 的那卷。
- `record:cassette` = `cross-env RECORD_CASSETTE=1 playwright test --project=record`（无 RECORD_CASSETTE 会 skip）。
- 录制器在 `tests/e2e/tools/record-cassette.spec.js`。
- **凭证优先序**：`tests/e2e/.ptt-creds.json`（gitignored，`{"user","pass"}`）> env `RECORD_ALLOW_LOGIN=1` + env `PTT_USER`/`PTT_PASS` > 否则强制 guest。
- 页数上限在 hook 内吞掉超额 `\x1b[6~`（无 race：pageLines 停在已 flush 的页），控制素材大小/重放时长。
  实测 Stock 12 页 ≈ cassette 27KB + fixture 44KB；不设上限的盤中閒聊可达 416 页 / 2.6MB。

### 隐私（CLAUDE.md，公开 fork 必守）—— CONFIRMED 关键设计
- **capture 是 article-scoped**：hook 装在登入*之后*、Enter 前清空 `cur` → cassette/fixture 只含
  「文章 recv（公开内容）」，**不含登入画面 / 帐号回显 / 个人化状态列**。
- 预设**强制 guest**（删 `PTT_USER`/`PTT_PASS` env）：guest 无密码、PTT 不回显密码 → 素材零凭证。
- 用真实帐号登入时（guest 名額满 "太多 guest 在站上"）：写档前对 recv + fixture 文字做
  **登入帐号等长 redact**（`(?<![0-9A-Za-z])id(?![0-9A-Za-z])` → `xxxx`，保 byte/栏位对齐）+ `assertNoLeak`
  把关（解码全部 recv/文字，含帐号即抛错不写）。`meta.recordedAs` 只记 `guest`/`account`，不存帐号名。
- **额外遮蔽（2026-06）**：`RECORD_REDACT_EXTRA="id1,id2"` 等长遮蔽「登入帐号以外、文章里出现的自己其他 id」
  （典型：Fw 转录文「※ 转录者: <另一 id>」），`assertNoLeak` 一并把关；并自动等长遮蔽所有 **IPv4**
  （转录者/「来自: <IP>」会带发文者个资）。`test-xmen` 卷即用此录制（账号 + 转录者 id + IP 皆已 redact 成 x）。
- redact 是手动扫描（`redactUser`）：id 须右侧非英数边界；左侧认「非英数 / 字串开头 / Big5 尾位元组」
  （前一位元组 0x40-0x7E 且其前 ≥0x80）。故 article 的「→ 你的id:」「推 你的id:」与 list 状态列
  「我是<id>」（id 紧贴 Big5「是」0xAC4F，trail 0x4F='O'）都能正确遮成 xxxx → **article / list 用真实帐号皆可**。
- `assertNoLeak` 是最后防线：万一 redact 漏了就抛错不写。实测 stock-huang / stock-end / cchat-list 三卷
  独立扫描皆 0 泄漏。
- commit 前仍务必 `git diff` 复查产出档不含帐号 / 本机路径 / OS 使用者名。文章内容是公开 PTT，可入 repo。

## 跑
```
yarn test:e2e:offline   # 离线重放（stub WebSocket，零网络），断网/无帐密也全过
yarn test:unit          # 含 Layer2 重建（无对应 fixture 则 skip）
yarn test:e2e           # 仍连真实 PTT 的 live e2e（共存，--project=live）
```
- `playwright.config.js` 三 project：`live`（现有 spec，排除 offline/tools）、`offline`、`record`。
- 没录过任何 cassette/fixture：offline 文章/增强 spec 与 Layer2 unit **skip**（非失败）；
  `harness.offline.spec.js` 永远不需素材（验离线 boot+onData 渲染）。

## 回归捕捉力验证（关键，证明素材真能守门）
录好 cassette 后：临时改坏 `comment_parse.findPageOverlap`（或 stash 第一则推文修复 commit），
`yarn test:e2e:offline` + `yarn test:unit` 必须**变红**（首推作者缺席 / commentCount 不符 / 楼号错位）；
复原后转绿。

## 踩坑
- 必须先 `applyPrefs(enableEasyReading:true)` 写 localStorage **再** `enterEasyReading()`，否则
  `_onChanged` 读到 pref off 会立刻 `exitEasyReading`（`easy_reading.js:182`）。
- `installReplay()` 的 `addInitScript` 必须在 `page.goto` **之前**（覆写 `window.WebSocket` 要早于 bundle）。
- Layer2 重建要 `pageScreens[p].slice(0,-1)` 去掉状态列（与 accumulatePageLines 一致）。
- `getRowText(row,0,cols,pageLines)` 第 4 参传 pageLines 才读累积页（不传读 24 列原生 buf）。
