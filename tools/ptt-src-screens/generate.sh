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
cp "$P/sample/pttbbs.conf" "$P/pttbbs.conf" &&
  printf '\n#define USE_PFTERM\n#define USE_PMORE\n' >> "$P/pttbbs.conf" || exit 2
# clang＋-finput-charset=big5 才不會把 Big5 尾碼 0x5C 當跳脫字元（gcc 會弄壞字串）；
# upstream HEAD 在 -Werror 下常有 unused 警告編不過，關掉 -Werror。
X='EXT_CFLAGS=-finput-charset=big5 -fexec-charset=big5 -Wno-error'
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
clang -g -O0 -w -I../include -DBBSHOME='"/root"' -c "$HERE/driver.c" -o "$OUT/driver.o" || exit 2
# --wrap：driver.c 接住 upstream 等 stdin 的阻塞點，在 stdout 標出幀尾（WAIT_MARK，見 driver.c）。
# shellcheck disable=SC2086
clang -o "$OUT/driver" -Wl,--wrap=read,--wrap=select,--wrap=poll "$OUT/driver.o" "$OUT/mbbsd_nomain.o" $OBJS "$OUT/vers.o" \
  -L../common/bbs -L../common/sys -L../common/osdep -lcmbbs -lcmsys -losdep -lrt -pthread || exit 2

iconv -f UTF-8 -t BIG5 "$HERE/seed.tsv" >"$OUT/seed.big5" || exit 2
node "$HERE/capture.mjs" "$OUT/driver" "$OUT/seed.big5" "$ROOT/tests/unit/fixtures/ptt_src_screens" || exit 2
echo "ok: $(cd "$P" && git rev-parse --short HEAD 2>/dev/null)"
