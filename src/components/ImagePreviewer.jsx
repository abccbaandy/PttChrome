import React from "react";
import {
  RE_IMAGE_EXT,
  RE_VIDEO_EXT,
  RE_IMGUR_ALBUM,
  RE_IMGUR_SINGLE,
  RE_TWIMG,
  RE_MEEE,
  flickrBase58Decode,
} from "../js/image_url_detect";
import { probeImgurAsset } from "../js/imgur_probe";
import { computeCenteredScrollTop, offsetTopWithin } from "../js/scroll_anchor";

const noop = () => {};

export const of = (src) => Promise.resolve({ src });

const previewRequestCache = new Map();
// 同一 href 永遠回傳同一個 Promise 參考，讓 <ImagePreviewer>（PureComponent）
// 在整列重繪（如 pusherHighlight 切換）時 props 穩定、跳過更新，避免 iframe 重掛閃爍。
export const requestPreview = (href) => {
  let p = previewRequestCache.get(href);
  if (p === undefined) {
    p = of(href).then(resolveSrcToImageUrl);
    // 不可預覽的一般連結（default resolver）在 render 期就 reject，而
    // <ImagePreviewer> 的 rejection handler 要到 useEffect（commit 後）才掛上
    // —— 中間隔著 microtask checkpoint，瀏覽器先射 unhandledrejection
    // （dev overlay 彈「Unimplemented」）。先掛一個 no-op catch 標記 handled；
    // 回傳的仍是原 promise，消費端照常收到 reject（state.error 路徑不變）。
    p.catch(noop);
    previewRequestCache.set(href, p);
  }
  return p;
};

// resolveSrcToImageUrl turns a link into a *media descriptor*:
//   { type: "image", src, srcset? } | { type: "video", src }
//   | { type: "iframe", src }       | { type: "album", images: [descriptor] }
// `type` defaults to "image" when omitted (back-compat with bare { src }).
export const resolveSrcToImageUrl = ({ src }) =>
  imageUrlResolvers.find((r) => r.test(src)).request(src);

// Hover preview only deals with still images: measure height for positioning.
// Non-image descriptors (video/iframe/album) pass through unchanged — OnHover
// renders nothing for them.
export const resolveWithImageDOM = (descriptor) => {
  if (descriptor.type && descriptor.type !== "image") {
    return Promise.resolve(descriptor);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ ...descriptor, height: img.height });
    img.onerror = reject;
    img.referrerPolicy = "no-referrer";
    img.src = descriptor.src;
  });
};

// <request> is a Promise (memoized per-href in requestPreview) resolving to a
// media descriptor. React.memo keeps the old PureComponent shallow-compare so a
// stable request prop skips re-render (no iframe/video remount flicker; see
// requestPreview above). On a request change we reset, subscribe, and ignore a
// late resolve from a superseded request via the effect-cleanup `active` flag.
export const ImagePreviewer = React.memo(function ImagePreviewer(props) {
  const { component, request, ...rest } = props;
  const [state, setState] = React.useState({
    value: undefined,
    error: undefined,
  });

  React.useEffect(() => {
    let active = true;
    setState({ value: undefined, error: undefined });
    request.then(
      (value) => {
        if (active) setState({ value, error: undefined });
      },
      (error) => {
        if (active) setState({ value: undefined, error });
      },
    );
    return () => {
      active = false;
    };
  }, [request]);

  return React.createElement(component, {
    ...rest,
    value: state.value,
    error: state.error,
  });
});

const getTop = (top, height) => {
  const pageHeight = window.innerHeight;

  // opening image would pass the bottom of the page
  if (top + height / 2 > pageHeight - 20) {
    if (height / 2 < top) {
      return pageHeight - 20 - height;
    }
  } else if (top - 20 > height / 2) {
    return top - height / 2;
  }
  return 20;
};

ImagePreviewer.OnHover = ({ left, top, value, error }) => {
  if (error || (value && value.type && value.type !== "image")) {
    return false;
  } else if (value) {
    return (
      <img
        referrerPolicy="no-referrer"
        src={value.src}
        style={{
          display: "block",
          position: "absolute",
          left: left + 20,
          top: getTop(top, value.height),
          maxHeight: "80%",
          maxWidth: "90%",
          zIndex: 2,
        }}
      />
    );
  } else {
    return (
      <span
        className="previewSpinner"
        style={{
          position: "absolute",
          left: left + 20,
          top: top,
          zIndex: 2,
        }}
      />
    );
  }
};

// 「讀取中」指示器：「URL 解析中」與「媒體下載中」兩階段共用，外觀一致。
// <img>/<video> 無法回報真實下載進度，故用不定式（indeterminate）動畫進度條；
// 樣式定義於 src/css/main.css。
const LoadingOverlay = () => (
  <div className="previewLoading">
    <span className="previewSpinner" />
    <span className="previewLoadingText">讀取中…</span>
    <span className="previewLoadingBar">
      <span className="previewLoadingBarFill" />
    </span>
  </div>
);

// Some hosts only accept requests without a referer (imgur, twitter, …); a few
// require it (verb.tw). Strip the referer everywhere except the latter.
const needsReferer = (src) => {
  try {
    return /(^|\.)verb\.tw$/i.test(new URL(src, location.href).hostname);
  } catch (e) {
    return false;
  }
};

// 暫時性載入失敗（host hotlink/rate-limit/5xx）會讓 <img> onError，舊版單次 error
// 就跳下一候選、候選耗盡即 render false（讀取動畫消失、無圖、無提示）→ 看起來跟
// 「沒在讀取」一模一樣，正是這功能本要防的誤判。故每個候選先 bounded 重試（backoff
// 內維持讀取動畫），全部耗盡才顯示可見的「載入失敗，點擊重試」。
const MAX_RETRIES_PER_CANDIDATE = 2;
const RETRY_BASE_MS = 300; // 退避：300ms, 600ms（每候選 1+2 次嘗試）

// <img> that walks a list of candidate URLs. Each candidate is retried a few
// times with backoff before advancing; one candidate (the resolved src) is the
// common case, twitter/meee supply fallbacks (:orig → .png:orig → :large → plain).
const FallbackImage = React.memo(function FallbackImage({
  candidates,
  ...rest
}) {
  // attempt 只用來換 <img> 的 key 觸發重掛（瀏覽器重發請求），不竄改 URL，
  // 避免破壞帶簽章的網址（如 twitter :orig）。
  const [state, setState] = React.useState({
    index: 0,
    loaded: false,
    retries: 0,
    attempt: 0,
    failed: false,
  });
  // 讀最新 state（避免同一 render 多次 onError 讀到 stale 閉包），比照 class this.state。
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const retryTimerRef = React.useRef(null);

  React.useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  const handleError = React.useCallback(() => {
    const { retries } = stateRef.current;
    if (retries < MAX_RETRIES_PER_CANDIDATE) {
      // 退避後重掛同一候選；等待期間維持 loaded:false → 讀取動畫不閃掉。
      const delay = RETRY_BASE_MS * Math.pow(2, retries);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        setState((s) => ({
          ...s,
          retries: s.retries + 1,
          attempt: s.attempt + 1,
          loaded: false,
        }));
      }, delay);
      return;
    }
    // 此候選重試用罄 → 換下一候選；沒有下一個就進可見的失敗態。
    setState((s) => {
      const nextIndex = s.index + 1;
      if (candidates[nextIndex] == null) {
        return { ...s, failed: true };
      }
      return {
        ...s,
        index: nextIndex,
        retries: 0,
        attempt: s.attempt + 1,
        loaded: false,
      };
    });
  }, [candidates]);

  // 換下一個候選網址時 loaded 一併重設，避免沿用上一張的已載入狀態。
  const handleLoad = React.useCallback(
    () => setState((s) => ({ ...s, loaded: true })),
    [],
  );

  // 點擊失敗提示 → 從頭重跑整串候選。
  const handleRetry = React.useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setState((s) => ({
      ...s,
      index: 0,
      retries: 0,
      attempt: s.attempt + 1,
      loaded: false,
      failed: false,
    }));
  }, []);

  const { index, loaded, attempt, failed } = state;
  const src = candidates[index];
  if (failed || src == null) {
    return (
      <div className="previewError" onClick={handleRetry} title="點擊重試">
        圖片載入失敗，點擊重試
      </div>
    );
  }
  return (
    <React.Fragment>
      {!loaded && <LoadingOverlay />}
      <img
        key={`${index}-${attempt}`}
        {...rest}
        {...(needsReferer(src) ? {} : { referrerPolicy: "no-referrer" })}
        src={src}
        onLoad={handleLoad}
        onError={handleError}
        style={loaded ? null : { display: "none" }}
      />
    </React.Fragment>
  );
});

// 播放器內建全螢幕進出後把影片捲回視野。
//
// 進全螢幕時 <video> 被提到全螢幕層、原位高度塌陷 → 內容總高驟減，捲動容器
// （.main）的 scrollTop 被夾到新的 maxScroll；退出後高度回來，捲動位置卻停在被夾
// 過的值 → 文章跳到很後面（與點圖放大/縮小同一類，見 16c5398）。
// 退出當下已拿不到「進場前的相對位置」（進場那刻 layout 就變了，且原生全螢幕鈕
// 攔不到 before），故不套 computeAnchoredScrollTop，改用可預期的還原：置中。
// 量測一律 offsetTop/offsetHeight，不可用 getBoundingClientRect（座標系規則見
// scroll_anchor.js 開頭）。
const useFullscreenScrollRestore = (videoRef) => {
  React.useEffect(() => {
    const wasFullscreen = { current: false };
    const onChange = () => {
      const v = videoRef.current;
      if (!v) return;
      if (document.fullscreenElement === v) {
        wasFullscreen.current = true;
        return;
      }
      // 別支影片/別的元素進出全螢幕時不得亂動捲動位置。
      if (wasFullscreen.current !== true || document.fullscreenElement) return;
      wasFullscreen.current = false;
      const container = v.closest("#mainContainer");
      const scroller = v.closest(".main");
      if (!container || !scroller) return;
      // 退出全螢幕的 layout 回復可能落在事件之後，下一幀再量才是還原後的值。
      requestAnimationFrame(() => {
        if (!v.isConnected) return;
        scroller.scrollTop = computeCenteredScrollTop({
          top: offsetTopWithin(v, container),
          height: v.offsetHeight,
          viewportHeight: scroller.clientHeight,
          maxScroll: scroller.scrollHeight - scroller.clientHeight,
        });
      });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [videoRef]);
};

// <video>/<iframe> 內嵌：載入完成前疊 LoadingOverlay，避免網路慢時空白像壞掉。
const InlineVideo = React.memo(function InlineVideo({ src }) {
  const [loaded, setLoaded] = React.useState(false);
  const videoRef = React.useRef(null);
  useFullscreenScrollRestore(videoRef);
  return (
    <React.Fragment>
      {!loaded && <LoadingOverlay />}
      <video
        ref={videoRef}
        className="easyReadingVideo"
        src={src}
        controls
        onLoadedData={() => setLoaded(true)}
        style={loaded ? null : { display: "none" }}
      />
    </React.Fragment>
  );
});

const InlineIframe = React.memo(function InlineIframe({ src }) {
  const [loaded, setLoaded] = React.useState(false);
  return (
    <div style={{ margin: "0.5em auto", maxWidth: "800px", height: "450px" }}>
      {!loaded && <LoadingOverlay />}
      <iframe
        type="text/html"
        src={src}
        allowFullScreen
        referrerPolicy="origin-when-cross-origin"
        onLoad={() => setLoaded(true)}
        style={{ border: "none", width: "100%", height: "100%" }}
      />
    </div>
  );
});

const inlineImage = (descriptor, key) => (
  <FallbackImage
    key={key}
    className="easyReadingImg hyperLinkPreview"
    candidates={descriptor.srcset || [descriptor.src]}
  />
);

const inlineVideo = (src, key) => <InlineVideo key={key} src={src} />;

const inlineIframe = (src, key) => <InlineIframe key={key} src={src} />;

// 單一 descriptor → 元素。相簿展開的每一項也走這裡，所以相簿內的圖自動吃到
// srcset 候選鏈（如 imgur 的 webp 優先），不必在 album 分支複製一份判斷。
const renderMedia = (descriptor, key) => {
  switch (descriptor.type) {
    case "video":
      return inlineVideo(descriptor.src, key);
    case "iframe":
      return inlineIframe(descriptor.src, key);
    default:
      return inlineImage(descriptor, key);
  }
};

ImagePreviewer.Inline = ({ value, error }) => {
  if (error) {
    return false;
  } else if (value) {
    return value.type === "album"
      ? value.images.map(renderMedia)
      : renderMedia(value, undefined);
  } else {
    return <LoadingOverlay />;
  }
};

// RE_IMAGE_EXT / RE_VIDEO_EXT 及各 host regex 移至 src/js/image_url_detect.js
// （與圖文合併分組共用，見該檔說明）。

// Multiple client ids, picked at random, to spread imgur API quota.
const IMGUR_CLIENT_IDS = [
  "a023b4e4a5324bc",
  "ca7108e04622b7a",
  "e83ef0f75467fbf",
  "8683d4c3edf9f8f",
  "88f07b92270c5f2",
];

// imgur 對同一 hash 另外提供 `.webp` 衍生檔：解析度與原圖完全相同、體積約 1/5，
// 而且不像原圖那樣有 per-request 長尾（真 Chromium、獨立快取、同瞬間同 URL 實測
// 0.8s / 2.5s / 8.8s；webp 則穩定 ~0.58s）。故靜態圖優先要 webp，原副檔名留作候選，
// webp 不存在時由 FallbackImage 自動退回。數據與驗證方式見
// docs/media-preview-addons.md。
//
// **動圖必須排除**：imgur 的 webp 衍生對 gif 只回**靜態單幀**（實測 auVUJzV：
// gif 10.85 MB／完整動畫 → webp 27950 B／VP8 static、零 ANMF frame），而且 <img>
// 會 onload 成功 → FallbackImage 不會退回，動圖直接被靜音成一張圖。
//
// 而且 **imgur 對圖片原檔忽略 URL 副檔名**，一律回儲存的原始格式（實測
// `auVUJzV.jpg` 與 `.png` 都回 image/gif 完整動畫；`ofT90A6.png`/`.gif` 都回
// image/jpeg）。所以 URL 副檔名**不是**可靠的動圖判準——只有它明確寫著靜態格式時
// 才敢直接要 webp；未知（無副檔名，imgur 分享連結的預設形式）與 gif 系副檔名改走
// HEAD 探測（src/js/imgur_probe.js）判定真實型別。
// gif→mp4（ptt-media-preview term.js 的做法）不採用：動畫與尺寸雖然都保住，但
// imgur 的 mp4 衍生有嚴重長尾（真瀏覽器實測 1.1 MB 花 65～67s），比直接載 10 MB
// 的 gif（4/4 穩定 2.3s）更差。數據見 docs/media-preview-addons.md。
const STATIC_IMGUR_EXT = new Set(["jpg", "jpeg", "png"]);

// 探測結果 → descriptor。「原始檔就是影片」的資產（現代 imgur 把上傳的動畫存成
// video/mp4）只有 .mp4 會動，任何圖片副檔名都只回單幀靜態縮圖，且 <img> 會 onload
// 成功 → FallbackImage 不會退回 ⇒ 動圖被靜音（回報案例 imgur.com/lP0NHpE）。
const imgurMediaFromProbe = (id, kind) => {
  const base = `https://i.imgur.com/${id}`;
  switch (kind) {
    case "video":
      return { type: "video", src: `${base}.mp4` };
    case "gif":
      return { type: "image", src: `${base}.gif` };
    case "static":
      // 探測確認是真靜態圖，才敢吃 webp 優化（未探測前一律不敢碰）。
      return {
        type: "image",
        src: `${base}.webp`,
        srcset: [`${base}.webp`, `${base}.jpg`],
      };
    default:
      // 探測失敗／非圖片回應：維持舊行為（.jpg 對圖片原檔仍拿得到原檔）。
      return { type: "image", src: `${base}.jpg` };
  }
};

// ext 可為 undefined（無副檔名）——那正是最危險的一類，必須與「明確寫著 .jpg」
// 區分開來，不可在呼叫端先補預設值。
const imgurMedia = (id, ext) => {
  const base = `https://i.imgur.com/${id}`;
  // imgur 也託管影片直連（.mp4）。必須先於「圖片」判斷分流，否則會被塞進 <img>，
  // 永遠 decode 失敗 → 顯示「圖片載入失敗，點擊重試」。相簿路徑本來就有這個分流，
  // 單一連結漏掉（實例 i.imgur.com/8MYpXhr.mp4）。webm/ogg 衍生 imgur 不產（實測
  // 同 hash .webm 回 404），故不改寫副檔名，原樣交給 <video>。
  if (ext && RE_VIDEO_EXT.test(`.${ext}`)) {
    return { type: "video", src: `${base}.${ext}` };
  }
  if (!ext || !STATIC_IMGUR_EXT.has(ext)) {
    return { type: "image", src: `${base}.${ext || "jpg"}` };
  }
  const candidates = [`${base}.webp`, `${base}.${ext}`];
  return { type: "image", src: candidates[0], srcset: candidates };
};

// 相簿 API 回傳的 link 是原副檔名直連；轉成 descriptor 讓相簿內的圖也吃到 webp
// 優先（相簿一次展開多張，最吃這個優化）。
const imgurAlbumMedia = (link) => {
  if (RE_VIDEO_EXT.test(link)) {
    return { type: "video", src: link };
  }
  const m = RE_IMGUR_SINGLE.exec(link);
  if (!m) {
    return { type: "image", src: link };
  }
  const [, id, ext] = m;
  return imgurMedia(id, ext && ext.toLowerCase());
};

const resolveImgurAlbum = (hash) => {
  const clientId =
    IMGUR_CLIENT_IDS[Math.floor(Math.random() * IMGUR_CLIENT_IDS.length)];
  return fetch(`https://api.imgur.com/3/album/${hash}?client_id=${clientId}`, {
    mode: "cors",
    referrerPolicy: "no-referrer",
  })
    .then((r) => r.json())
    .then((j) =>
      j.data && j.data.images ? j.data.images.map((i) => i.link) : [],
    )
    .catch(() => []);
};

// Ordered most-specific → most-generic. `.find` returns the first matching
// resolver, so the generic extension resolvers sit just above the default.
// Adding a new host = one entry here; no per-host rendering logic.
const imageUrlResolvers = [
  {
    /* imgur album / gallery */
    regex: RE_IMGUR_ALBUM,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const hash = src.match(this.regex)[1];
      return resolveImgurAlbum(hash).then((links) => ({
        type: "album",
        images: links.map(imgurAlbumMedia),
      }));
    },
  },
  {
    /* imgur single image (i.imgur.com/<id>.<ext> or imgur.com/<id>) */
    regex: RE_IMGUR_SINGLE,
    test(src) {
      return this.regex.test(src) && !/\/(?:a|gallery)\//i.test(src);
    },
    request(src) {
      const [, id, ext] = this.regex.exec(src);
      const e = ext && ext.toLowerCase();
      // 明確寫著影片或靜態圖副檔名 → 直接出，不多發探測請求（imgur 為影片型資產
      // 產的直連本來就是 .mp4，明寫 jpg/jpeg/png/webp 視為可信）。
      if (
        e &&
        (RE_VIDEO_EXT.test(`.${e}`) || STATIC_IMGUR_EXT.has(e) || e === "webp")
      ) {
        return Promise.resolve(imgurMedia(id, e));
      }
      // 無副檔名（imgur 分享連結的預設形式）／gif／gifv／未知 → HEAD 探測真實型別。
      return probeImgurAsset(id).then((kind) => imgurMediaFromProbe(id, kind));
    },
  },
  {
    /* twitter / X — request :orig with png/large/plain fallbacks */
    regex: RE_TWIMG,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const [, id, dotExt, queryExt] = this.regex.exec(src);
      let ext = (dotExt || queryExt || "jpg").toLowerCase();
      if (ext === "webp") ext = "jpg";
      const base = `https://pbs.twimg.com/media/${id}`;
      return Promise.resolve({
        type: "image",
        src: `${base}.${ext}:orig`,
        srcset: [
          `${base}.${ext}:orig`,
          `${base}.png:orig`,
          `${base}.${ext}:large`,
          `${base}.${ext}`,
        ],
      });
    },
  },
  {
    /* meee.com.tw — real extension is unknown, try common ones */
    regex: RE_MEEE,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const [, id, ext] = this.regex.exec(src);
      const exts = [
        ...new Set(
          [ext, "jpg", "jpeg", "png", "gif"]
            .filter(Boolean)
            .map((e) => e.toLowerCase()),
        ),
      ];
      return Promise.resolve({
        type: "image",
        src: `https://i.meee.com.tw/${id}.${exts[0]}`,
        srcset: exts.map((e) => `https://i.meee.com.tw/${id}.${e}`),
      });
    },
  },
  {
    /* youtube (watch / youtu.be / embed / shorts / live) */
    regex:
      /(?:youtube\.com\/watch\?[^#]*[?&]?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([\w-]{9,12})/i,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const id = src.match(this.regex)[1];
      let embed = `https://www.youtube.com/embed/${id}`;
      try {
        const t = new URL(src, location.href).searchParams.get("t");
        if (t) embed += `?start=${parseInt(t, 10) || t}`;
      } catch (e) {
        // ignore malformed url
      }
      return Promise.resolve({ type: "iframe", src: embed });
    },
  },
  {
    /* twitch clips */
    regex: /^https?:\/\/clips\.twitch\.tv\/([\w-]+)/i,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const id = src.match(this.regex)[1];
      return Promise.resolve({
        type: "iframe",
        src: `https://clips.twitch.tv/embed?clip=${id}&parent=${location.hostname}`,
      });
    },
  },
  {
    /* flickr */
    regex: /flic\.kr\/p\/(\w+)|flickr\.com\/photos\/[\w@]+\/(\d+)/,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const [, flickrBase58Id, flickrPhotoId] = src.match(this.regex);
      const photoId = flickrBase58Id
        ? flickrBase58Decode(flickrBase58Id)
        : flickrPhotoId;

      const apiURL = `https://api.flickr.com/services/rest/?${new URLSearchParams(
        {
          method: "flickr.photos.getInfo",
          api_key: "c8c95356e465b8d7398ff2847152740e",
          photo_id: photoId,
          format: "json",
          nojsoncallback: 1,
        },
      )}`;
      return fetch(apiURL, { mode: "cors" })
        .then((r) => r.json())
        .then((data) => {
          if (!data.photo) {
            throw new Error("Not found");
          }
          const { farm, server: svr, id, secret } = data.photo;
          return {
            type: "image",
            src: `https://farm${farm}.staticflickr.com/${svr}/${id}_${secret}.jpg`,
          };
        });
    },
  },
  {
    /* any direct video link */
    test(src) {
      return RE_VIDEO_EXT.test(src);
    },
    request(src) {
      return Promise.resolve({ type: "video", src });
    },
  },
  {
    /* any direct image link — the generic catch-all that covers every host
       that serves a real image URL, with zero per-host code */
    test(src) {
      return RE_IMAGE_EXT.test(src);
    },
    request(src) {
      return Promise.resolve({ type: "image", src });
    },
  },
  {
    /* Default: not previewable */
    test() {
      return true;
    },
    request() {
      return Promise.reject(new Error("Unimplemented"));
    },
  },
];

export default ImagePreviewer;
