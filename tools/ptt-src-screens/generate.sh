#!/bin/sh
# 從 upstream pttbbs 原始碼產生畫面 fixture（spike：目前只有文章列表一幀）。
# 用法：sh tools/ptt-src-screens/generate.sh <pttbbs 目錄>   （預設 3rd_script/pttbbs）
# 產出：tests/unit/fixtures/ptt_src_screens/article_list.json
# exit 2 ＝ build／driver 環境問題（不是本專案解析器壞）。
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
P=$(cd "${1:-$ROOT/3rd_script/pttbbs}" && pwd) || exit 2
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# upstream 的 sample conf 加 USE_PFTERM（vtuikit 無條件呼叫 pfterm 的 grayout_rect；PTT 實跑 pfterm）。
cp "$P/sample/pttbbs.conf" "$P/pttbbs.conf" && printf '\n#define USE_PFTERM\n' >> "$P/pttbbs.conf" || exit 2
# clang＋-finput-charset=big5 才不會把 Big5 尾碼 0x5C 當跳脫字元（gcc 會弄壞字串）；
# upstream HEAD 在 -Werror 下常有 unused 警告編不過，關掉 -Werror。
X='EXT_CFLAGS=-finput-charset=big5 -fexec-charset=big5 -Wno-error'
make -s -C "$P" clean >/dev/null 2>&1
make -j8 -C "$P/common" "$X" >"$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; exit 2; }
make -j8 -C "$P/mbbsd" "$X" >>"$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; exit 2; }

cd "$P/mbbsd" || exit 2
clang -w -I../include -c vers.c -o "$OUT/vers.o" || exit 2
objcopy --redefine-sym main=ptt_main mbbsd.o "$OUT/mbbsd_nomain.o" || exit 2
OBJS=$(ls *.o | grep -v -E '^(mbbsd|test_brc|test_pfterm_url|testsz|screen|vers)\.o$')
clang -g -O0 -w -I../include -DBBSHOME='"/root"' -c "$HERE/driver.c" -o "$OUT/driver.o" || exit 2
clang -o "$OUT/driver" "$OUT/driver.o" "$OUT/mbbsd_nomain.o" $OBJS "$OUT/vers.o" \
  -L../common/bbs -L../common/sys -L../common/osdep -lcmbbs -lcmsys -losdep -lrt -pthread || exit 2

iconv -f UTF-8 -t BIG5 "$HERE/seed.tsv" >"$OUT/seed.big5" || exit 2
mkdir -p "$OUT/home"
# 先等畫面畫完（pfterm 在阻塞讀鍵前才 flush），再送 q 離開。spike 用 sleep，正式版改成等輸出靜止。
(sleep 1; printf q) | timeout 20 "$OUT/driver" "$OUT/home" "$OUT/seed.big5" >"$OUT/screen.bin" || exit 2
[ -s "$OUT/screen.bin" ] || exit 2

node -e '
const fs = require("fs");
const b = fs.readFileSync(process.argv[1]);
fs.writeFileSync(process.argv[2], JSON.stringify({ cols: 80, rows: 24, bytes: b.toString("latin1") }) + "\n");
' "$OUT/screen.bin" "$ROOT/tests/unit/fixtures/ptt_src_screens/article_list.json" || exit 2
echo "ok: $(cd "$P" && git rev-parse --short HEAD 2>/dev/null)"
