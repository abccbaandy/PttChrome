# upstream pttbbs 原始碼畫面檢查：MVP 之後的待做

狀態：**MVP 已上線**（`.github/workflows/ptt-src-screens.yml`，每天台灣 06:43；紅了開 issue
「PTT 原始碼畫面檢查失敗」，label `ptt-src-screens`，**不接 Claude routine**）。
目的：upstream 改畫面讓本專案判錯時，在使用者回報前就知道（例：72718d5，upstream 10/01 在文章列表
row 1 加指令說明列「[s]選擇看板」，10/18 才被發現；fixture 換回修正前的 `board_note_skip.js` 會紅）。

## 現況（CONFIRMED）

- `tools/ptt-src-screens/generate.sh`：用 upstream Makefile 編譯 mbbsd 物件檔 → `objcopy` 把 `main`
  改名 → 連 `driver.c`（假 SHM `calloc`、假使用者、暫存 BBSHOME 裡依 `seed.tsv` 建看板與 `.DIR`）→
  直接呼叫 `Read()`，stdout 收 pfterm 吐的位元組 → `tests/unit/fixtures/ptt_src_screens/article_list.json`。
  不架站、不登入、不需要 logind／Go 服務。exit 2＝build／driver 環境問題。
- build 坑（已寫進 generate.sh）：sample conf 要加 `USE_PFTERM`（vtuikit 無條件呼叫 `grayout_rect`）；
  必須 clang＋`-finput-charset=big5`（gcc 把 Big5 尾碼 0x5C 當跳脫字元，字串壞掉）；upstream HEAD 在
  `-Werror` 下常編不過 ⇒ `-Wno-error`。driver 要先 `init_io()`（否則 pfterm 沒輸出緩衝）、
  `currboard` 先清空再 `enter_board`（`brc_initial_board` 同名會走捷徑不設 `currbid`）。
- `tests/unit/ptt_src_screens.test.js`：位元組 → AnsiParser/TermBuf → `classifyListScreen`、
  `parseListArticleNum`／`parseListAuthor`／`subjectOfListText`、`boardEntryArms`。平常 `yarn test:unit`
  跑 repo 裡那份 fixture（3b8596b9 產的）；nightly 換成 upstream HEAD 產的。
- `scripts/ptt-src-screens-report.mjs`：open 的同名 issue 只留言；沒有 open 的且是 schedule 才新開；
  dispatch 不新開。`yarn ci:status` 不算 schedule／dispatch 的 run。

## 待做（依價值排序）

1. **接 Claude routine**：新開 issue 時起 session 修（同 flaky hunt：trigger＝Issue opened＋標題＋作者
   `github-actions[bot]`）。routine prompt 要分兩種紅：generate 紅修 `tools/ptt-src-screens/`；check 紅照
   CLAUDE.md「PTT 邏輯不准猜」先讀 upstream commit、新舊格式都吃，修完更新 repo 裡的 fixture。
   要接時一併評估 flaky hunt 的連鎖防護（`Fixes #N` 關 issue 後驗證 dispatch 再紅）在這裡是否也需要。
2. **補畫面**（每個畫面一份 fixture＋對應斷言；driver 要能選入口與按鍵序列）：
   - 看板列表（`board_list_parse.js`、看板列表平滑捲動的範圍指紋）；
   - 置底文：driver 的假 SHM 還沒設置底數（現在置底那篇畫成一般編號 5），要找出 `read.c` 判置底的
     來源（`SHM` 的 bottom 計數）並在 seed 補上，斷言 `isPinnedListRow`；
   - 長標題「…」截斷（`subjectMatches` 前綴比對）；
   - 開文後的 pmore 狀態列（`parseStatusRow`、`classifyListScreen` → `article`）；
   - `h` 說明選單（`parseHelpMenuScreen`）、進板畫面（`boardNoteDecision`）、主選單。
3. **按鍵改成等輸出靜止再送**：現在 `(sleep 1; printf q)`（pfterm 在阻塞讀鍵前才 flush）。多畫面
   序列要一個 node 小工具：spawn driver、stdout 靜止 N ms 才送下一鍵、逐幀切出位元組。
4. **畫面有變但仍綠時也通知**：generate job 已印 `git diff --stat`（fixture 與 repo 不同＝upstream 改了
   這個畫面）。可以改成開低優先 issue，或自動開 PR 更新 fixture。
5. **寬終端**：driver 現在固定 `term_set_size(80, 24)`。若之後開放寬於 80 欄，加 100／120 欄的產出。
6. **build 會被 upstream 搞壞的面**：目前排除 `screen.o`／`test_*.o`／`testsz.o`，upstream 新增需要另外
   排除的物件或新的必要 conf 時 generate 會紅（exit 2）；屆時把修法補進 generate.sh 並記在這裡。
