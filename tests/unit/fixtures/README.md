# Floor-numbering / comment-detection fixtures

Saved PTT articles that exposed the easy-reading floor & comment bugs (2026-06).
Each `*.txt` is one article's relevant rows in **terminal shape** (the 80-col
buffer reconstruction: a real comment's `MM/DD HH:MM` timestamp is right-aligned,
so there is whitespace before it).

Line format — one labelled row per line, `<LABEL><TAB><verbatim row text>`:

- `C` — a real comment row. `parseComment` must return `{type,userid}` and the C
  rows of a fixture must end up numbered 1..N (the assertion that matters).
- `N` — must NOT be a comment / must NOT take a floor (body text, body text written
  in comment shape WITHOUT a timestamp, `※ 編輯`/`※ 發信站`/`※ 文章網址`, blank rows).
- `F` — fake comment in the body/signature with a FAKE timestamp (full comment
  shape; no per-row signal can reject it). It parses as a comment and takes a
  transient floor, but the BePTT meta-latch rule (`FloorCounter.nonComment`)
  zeroes the counters on non-comment rows until `※ 發信站`/`※ 文章網址` is seen,
  so the C rows still start at 1.

Lines starting with `#` are comments (source URL + which bug the file demonstrates)
and are ignored by the loader. Consumed by `tests/unit/comment_parse.test.js`.

These are public PTT contents (board, userid, timestamps are all public).
