# Floor-numbering / comment-detection fixtures

Saved PTT articles that exposed the easy-reading floor & comment bugs (2026-06).
Each `*.txt` is one article's relevant rows in **terminal shape** (the 80-col
buffer reconstruction: a real comment's `MM/DD HH:MM` timestamp is right-aligned,
so there is whitespace before it).

Line format — one labelled row per line, `<LABEL><TAB><verbatim row text>`:

- `C` — a real comment row. `parseComment` must return `{type,userid}` and it must
  occupy exactly one floor.
- `N` — must NOT be a comment / must NOT take a floor (body text, body text written
  in comment shape, `※ 編輯`/`※ 發信站`/`※ 文章網址`, blank rows).

Lines starting with `#` are comments (source URL + which bug the file demonstrates)
and are ignored by the loader. Consumed by `tests/unit/comment_parse.test.js`.

These are public PTT contents (board, userid, timestamps are all public).
