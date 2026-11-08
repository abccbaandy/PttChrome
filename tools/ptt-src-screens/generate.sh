#!/bin/sh
# 從 upstream pttbbs 原始碼產生畫面 fixture（場景表見 scenes.mjs）。
# 用法：sh tools/ptt-src-screens/generate.sh <pttbbs 目錄>   （預設 3rd_script/pttbbs）
# 產出：tests/unit/fixtures/ptt_src_screens/<場景>.json
# exit 2 ＝ build／driver 環境問題（不是本專案解析器壞）。
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
P=$(cd "${1:-$ROOT/3rd_script/pttbbs}" && pwd) || exit 2
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# upstream 的 sample conf 補上 PTT 實跑、sample 沒開的兩項：
#   USE_PFTERM：vtuikit 無條件呼叫 pfterm 的 grayout_rect；
#   USE_PMORE：沒開時 more() 是 more.c 的 minimore，狀態列「瀏覽 P.1」不是 PTT 的 pmore 狀態列。
# 並關掉 sample 開著、PTT 沒開的 CONFIG_OLD_RECOMMEND（舊式推文：只有 →、沒有型別選單，推文列
# 是「→ id:msg推 日期」）：PTT 實跑的是推／噓／→ 三種，開著的話推文場景測的是 PTT 不會送的畫面。
cp "$P/sample/pttbbs.conf" "$P/pttbbs.conf" &&
  printf '\n#define USE_PFTERM\n#define USE_PMORE\n#undef CONFIG_OLD_RECOMMEND\n' >> "$P/pttbbs.conf" || exit 2
# 內容檢查（upstream 254a21b）：開 CONFIG_CONTENT_SVC，服務由 driver.c 的 __wrap_content_filter 假扮
# （推文含「spam」才擋，其餘放行＝跟服務連不上一樣，舊場景畫面不變）。舊 upstream 沒有 content.h 就不開。
if [ -f "$P/include/content.h" ]; then
  HAS_CONTENT=1; CONTENT_WRAP=,--wrap=content_filter
  printf '#define CONFIG_CONTENT_SVC 1\n' >> "$P/pttbbs.conf" || exit 2
else HAS_CONTENT=0; CONTENT_WRAP=; fi
# 使用限制提示（upstream 368f91f5）：activity.svc 拒絕 #AID／搜尋時帶理由 ⇒ activity_alert 整頁。
# 服務由 driver.c 的 __wrap_activity_nav_track 假扮（只在 Mine 板拒絕 AID／標題搜尋，其餘放行）。
# 舊 upstream 的 activity_nav_track 沒有 msg 參數就不接（也不會畫這張）。
if grep -q 'msgsz' "$P/include/activity.h" 2>/dev/null; then
  HAS_ACTIVITY_MSG=1; CONTENT_WRAP=$CONTENT_WRAP,--wrap=activity_nav_track
else HAS_ACTIVITY_MSG=0; fi
# 限速通知（upstream f369626a）：activity_nav_track 的 delay_ms 拿掉、改帶 on_delay callback（服務說「限速中」
# 時先畫 activity_alert(" 限速中 ")），activity_read_post 也一樣 ⇒ driver 的 wrapper 照新簽名接，並接手
# activity_read_post（場景的 PTT_SRC_ACTIVITY_SLOW 指定哪幾種要通知，見 driver.c）。舊簽名照舊接。
if grep -q 'activity_delay_fn' "$P/include/activity.h" 2>/dev/null; then
  HAS_ACTIVITY_SLOW=1; CONTENT_WRAP=$CONTENT_WRAP,--wrap=activity_read_post
else HAS_ACTIVITY_SLOW=0; fi
# clang＋-finput-charset=big5 才不會把 Big5 尾碼 0x5C 當跳脫字元（gcc 會弄壞字串）；
# upstream HEAD 在 -Werror 下常有 unused 警告編不過，關掉 -Werror。
# 漏 #include 的隱式宣告（upstream 254a21b 的 content.c 用 gettimeofday 沒 include <sys/time.h>）
# 在 clang 16 起是預設 error、不吃 -Wno-error ⇒ 單獨降回警告（PTT 自己用的編譯器不一定擋）。
X='EXT_CFLAGS=-finput-charset=big5 -fexec-charset=big5 -Wno-error -Wno-error=implicit-function-declaration'
make -s -C "$P" clean >/dev/null 2>&1
make -j8 -C "$P/common" "$X" >"$OUT/build.log" 2>&1 || { tail -60 "$OUT/build.log"; exit 2; }
make -j8 -C "$P/mbbsd" "$X" >>"$OUT/build.log" 2>&1 || { tail -60 "$OUT/build.log"; exit 2; }

cd "$P/mbbsd" || exit 2
clang -w -I../include -c vers.c -o "$OUT/vers.o" || exit 2
objcopy --redefine-sym main=ptt_main mbbsd.o "$OUT/mbbsd_nomain.o" || exit 2
# 連 mbbsd 的其餘物件檔。排除：mbbsd.o（上面改名過的那份才用）、vers.o（上面重編）、
# screen.o（非 pfterm 的畫面層，USE_PFTERM 下沒有內容）、以及**任何自帶 main 的物件**
# （upstream 的 test_*.o／testsz.o 這類小程式；新增的也自動排除，不用追著改清單）。
OBJS=
for o in *.o; do
  case "$o" in mbbsd.o|vers.o|screen.o) continue ;; esac
  nm "$o" 2>/dev/null | grep -q ' T main$' && continue
  OBJS="$OBJS $o"
done
# fileheader_t 的推文數欄位：upstream b500faf 把 char pad＋char recommend 併成 int16_t rating（畫面不變）。
# 新舊 upstream 都要編得過 ⇒ 看 header 決定 driver 寫哪個欄位。
# upstream 8d5a7928 再把 rating 改名 score（一樣是淨推數，畫面不變）。
SCORE_RE='^[[:space:]]*int16_t[[:space:]]+score;'
RATING_RE='^[[:space:]]*int16_t[[:space:]]+rating;'
if grep -Eq "$SCORE_RE" ../include/pttstruct.h; then FH_RATING=score
elif grep -Eq "$RATING_RE" ../include/pttstruct.h; then FH_RATING=rating
else FH_RATING=recommend; fi
# boardheader_t 的板主：upstream 653523c 把 char BM[] 換成 user_t moderators[]（見 driver.c#set_moderators）。
if grep -Eq '^[[:space:]]*user_t[[:space:]]+moderators\[' ../include/pttstruct.h; then BH_MODERATORS=1; else BH_MODERATORS=0; fi
# 等鍵也等 IPC service fd：upstream acee9aa 起沒連上時改成有逾時的等待（見 driver.c 的 HAS_IPC_FD）。
if grep -q 'vkey_attach_ipc' ../include/proto.h; then HAS_IPC_FD=1; else HAS_IPC_FD=0; fi
# 實況模式（upstream 3c7d9af）：有 pmore_feed_comment 才接 fd 3 的實況推文、--wrap 訂閱（見 driver.c 的 HAS_LIVE）。
# upstream c6d35a8 把實況搬進 more.c（pmore_feed_comment 拿掉）⇒ 改認 more.c 的 live_run，舊的照認。
if grep -q 'pmore_feed_comment' ../include/proto.h || grep -q '^live_run(' more.c; then HAS_LIVE=1; LIVE_WRAP=,--wrap=ipc_is_connected,--wrap=ipc_sub,--wrap=ipc_unsub,--wrap=ipc_read_packet; else HAS_LIVE=0; LIVE_WRAP=; fi
# upstream f5bb8f5 起每次等鍵前 vkey_sync_ipc 都從 libcmbbs 的 ipc_get_fd 重抓 IPC fd（蓋掉 vkey_attach_ipc 掛的），
# IPC handler 也從 wmsg_ipc_handler 改名 mbbsd_ipc_handler ⇒ --wrap=ipc_get_fd 交回 driver 掛的 fd（見 driver.c）。
if grep -q 'vkey_sync_ipc' ../include/proto.h; then HAS_IPC_SYNC=1; LIVE_WRAP=$LIVE_WRAP,--wrap=ipc_get_fd; else HAS_IPC_SYNC=0; fi
if grep -q 'mbbsd_ipc_handler' ../include/proto.h; then IPC_HANDLER=mbbsd_ipc_handler; else IPC_HANDLER=wmsg_ipc_handler; fi
clang -g -O0 -w -I../include -DBBSHOME='"/root"' -DFH_RATING="$FH_RATING" -DBH_MODERATORS="$BH_MODERATORS" -DHAS_IPC_FD="$HAS_IPC_FD" -DHAS_LIVE="$HAS_LIVE" -DHAS_CONTENT="$HAS_CONTENT" -DHAS_ACTIVITY_MSG="$HAS_ACTIVITY_MSG" -DHAS_ACTIVITY_SLOW="$HAS_ACTIVITY_SLOW" -DHAS_IPC_SYNC="$HAS_IPC_SYNC" -DIPC_HANDLER="$IPC_HANDLER" -c "$HERE/driver.c" -o "$OUT/driver.o" || exit 2
# --wrap：driver.c 接住 upstream 等 stdin 的阻塞點，在 stdout 標出幀尾（WAIT_MARK，見 driver.c）；
# passwd_query 一律「查不到」（板主 id 從 SHM->userid 來，見 driver.c#set_moderators）。
# shellcheck disable=SC2086
clang -o "$OUT/driver" -Wl,--wrap=read,--wrap=select,--wrap=poll,--wrap=passwd_query$LIVE_WRAP$CONTENT_WRAP "$OUT/driver.o" "$OUT/mbbsd_nomain.o" $OBJS "$OUT/vers.o" \
  -L../common/bbs -L../common/sys -L../common/osdep -lcmbbs -lcmsys -losdep -lrt -pthread || exit 2

iconv -f UTF-8 -t BIG5 "$HERE/seed.tsv" >"$OUT/seed.big5" || exit 2
node "$HERE/capture.mjs" "$OUT/driver" "$OUT/seed.big5" "$ROOT/tests/unit/fixtures/ptt_src_screens" || exit 2
echo "ok: $(cd "$P" && git rev-parse --short HEAD 2>/dev/null)"
