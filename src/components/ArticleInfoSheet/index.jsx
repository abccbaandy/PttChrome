import { useState } from "react";
import { i18n } from "../../js/i18n";
import { needsTapToLoad } from "../../js/image_load_gate";
import { MobileSheet } from "../MobileSheet";
import "./ArticleInfoSheet.css";

// 手機「文章資訊」（P102）：「更多」→「文章資訊」打開的 bottom sheet。資料是 MobileToolbar 開面板
// 那一刻向 articleTools.mobileInfo() 要的（js/article_tools.js，只讀累積頁、不送鍵），這裡照畫。
//   - 推／噓／→ 各幾則＋比例條（新格式推文沒有推噓之分，另計、算在條的灰色段）
//   - 推文最多的人：點＝只看他的推文（term_view.setCommentFilter，跟長按選單同一個入口）
//   - 本篇圖片：點＝捲到那一列（articleTools.jumpTo）。行動網路省流量的閘門開著（image_load_gate）
//     就不載縮圖，只畫一格「圖」，點了照樣捲過去（到了文章裡再照閘門的規則點開）。

const fmt = (key, vars) =>
  String(i18n(key) || "").replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );

// 比例條各段的寬（%）。總數 0 ⇒ null（不畫條）。
export function ratioSegments(stats) {
  const s = stats || {};
  const parts = [
    ["push", s.push || 0],
    ["boo", s.boo || 0],
    ["arrow", (s.arrow || 0) + (s.modern || 0)],
  ];
  const total = parts.reduce((n, p) => n + p[1], 0);
  if (!total) return null;
  return parts
    .filter((p) => p[1] > 0)
    .map(([kind, n]) => ({ kind, pct: (n * 100) / total }));
}

function Thumb({ image, onOpen }) {
  const [index, setIndex] = useState(0);
  const gated = needsTapToLoad(image.url, true);
  const failed = index >= image.thumbs.length;
  return (
    <button
      type="button"
      className="nomouse_command articleInfoThumb pttRipple"
      data-info-image={image.row}
      title={image.url}
      onClick={() => onOpen(image.row)}
    >
      {gated || failed ? (
        <span className="articleInfoThumbStub">
          {i18n("articleInfo_tapToLoad")}
        </span>
      ) : (
        <img
          src={image.thumbs[index]}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setIndex(index + 1)}
        />
      )}
    </button>
  );
}

export const ArticleInfoSheet = ({
  pttchrome,
  opened,
  info,
  onBack,
  onClose,
}) => {
  const s = (info && info.stats) || { push: 0, boo: 0, arrow: 0, modern: 0 };
  const segs = ratioSegments(s);
  // 原 PO 傳 op＝true：篩選橫幅寫「只看原 PO」，同長按選單分開傳 op 的做法。
  const onUser = (u) => {
    onClose();
    const view = pttchrome && pttchrome.view;
    if (view && typeof view.setCommentFilter === "function")
      view.setCommentFilter(u.user, !!u.op);
  };
  const onImage = (row) => {
    onClose();
    const tools = pttchrome && pttchrome.articleTools;
    if (tools && typeof tools.jumpTo === "function") tools.jumpTo(row);
  };
  return (
    <MobileSheet
      pttchrome={pttchrome}
      opened={opened}
      onClose={onClose}
      sheetKey="articleInfo"
    >
      {info ? (
        <div data-panel="articleInfo" className="articleInfo">
          <button
            type="button"
            className="nomouse_command articleInfoBack pttRipple"
            data-info-back=""
            aria-label={i18n("articleInfo_back")}
            onClick={onBack}
          >
            ‹ {i18n("articleInfo_title")}
          </button>
          <section className="articleInfoSection" data-info-stats="">
            <div className="articleInfoHeading">
              {info.comments
                ? fmt("articleInfo_comments", { n: info.comments })
                : i18n("articleInfo_noComments")}
            </div>
            <div className="articleInfoCounts">
              <span data-kind="push">
                {i18n("tools_push")} {s.push}
              </span>
              <span data-kind="boo">
                {i18n("tools_boo")} {s.boo}
              </span>
              <span data-kind="arrow">→ {s.arrow}</span>
              {s.modern > 0 && (
                <span data-kind="modern">
                  {i18n("tools_modern")} {s.modern}
                </span>
              )}
            </div>
            {segs && (
              <div className="articleInfoBar" aria-hidden="true">
                {segs.map((g) => (
                  <span
                    key={g.kind}
                    data-kind={g.kind}
                    style={{ width: g.pct + "%" }}
                  />
                ))}
              </div>
            )}
          </section>
          {info.users.length > 0 && (
            <section className="articleInfoSection">
              <div className="articleInfoHeading">
                {i18n("articleInfo_users")}
              </div>
              <div className="articleInfoUsers">
                {info.users.map((u) => (
                  <button
                    key={u.user}
                    type="button"
                    className="nomouse_command articleInfoUser pttRipple"
                    data-info-user={u.user}
                    data-op={u.op ? "" : undefined}
                    onClick={() => onUser(u)}
                  >
                    <span className="articleInfoUserName">
                      {u.user}
                      {u.op && (
                        <span className="articleInfoOp">
                          {i18n("tools_op")}
                        </span>
                      )}
                    </span>
                    <span className="articleInfoCount">{u.count}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {info.images.length > 0 && (
            <section className="articleInfoSection">
              <div className="articleInfoHeading">
                {fmt("articleInfo_images", { n: info.images.length })}
              </div>
              <div className="articleInfoThumbs" data-info-images="">
                {info.images.map((img) => (
                  <Thumb key={img.url} image={img} onOpen={onImage} />
                ))}
              </div>
            </section>
          )}
        </div>
      ) : null}
    </MobileSheet>
  );
};

export default ArticleInfoSheet;
