import React from "react";
import { decode } from "base58";

const noop = () => {};

export const of = src => Promise.resolve({ src });

const previewRequestCache = new Map();
// 同一 href 永遠回傳同一個 Promise 參考，讓 <ImagePreviewer>（PureComponent）
// 在整列重繪（如 pusherHighlight 切換）時 props 穩定、跳過更新，避免 iframe 重掛閃爍。
export const requestPreview = href => {
  let p = previewRequestCache.get(href);
  if (p === undefined) {
    p = of(href).then(resolveSrcToImageUrl);
    previewRequestCache.set(href, p);
  }
  return p;
};

// resolveSrcToImageUrl turns a link into a *media descriptor*:
//   { type: "image", src, srcset? } | { type: "video", src }
//   | { type: "iframe", src }       | { type: "album", images: [url] }
// `type` defaults to "image" when omitted (back-compat with bare { src }).
export const resolveSrcToImageUrl = ({ src }) =>
  imageUrlResolvers.find(r => r.test(src)).request(src);

// Hover preview only deals with still images: measure height for positioning.
// Non-image descriptors (video/iframe/album) pass through unchanged — OnHover
// renders nothing for them.
export const resolveWithImageDOM = descriptor => {
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

export class ImagePreviewer extends React.PureComponent {
  state = {
    pending: undefined,
    value: undefined,
    error: undefined
  };

  componentDidMount() {
    this.handleStart();
  }

  componentDidUpdate(prevProps) {
    if (this.props.request !== prevProps.request) {
      this.handleStart();
    }
  }

  handleStart(props) {
    this.setState((state, { request }) => {
      request.then(this.handleResolve, this.handleReject);
      return {
        pending: request,
        value: undefined,
        error: undefined
      };
    });
  }

  handleResolve = value => {
    this.setState(({ pending }, { request }) => {
      if (pending !== request) {
        return;
      }
      return { value };
    });
  };

  handleReject = error => {
    this.setState(({ pending }, { request }) => {
      if (pending !== request) {
        return;
      }
      return { error };
    });
  };

  render() {
    return React.createElement(this.props.component, {
      ...this.props,
      component: undefined,
      request: undefined,
      value: this.state.value,
      error: this.state.error
    });
  }
}

const getTop = (top, height) => {
  const pageHeight = $(window).height();

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
          zIndex: 2
        }}
      />
    );
  } else {
    return (
      <i
        className="glyphicon glyphicon-refresh glyphicon-refresh-animate"
        style={{
          position: "absolute",
          left: left + 20,
          top: top,
          zIndex: 2
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
    <i className="glyphicon glyphicon-refresh glyphicon-refresh-animate" />
    <span className="previewLoadingText">讀取中…</span>
    <span className="previewLoadingBar">
      <span className="previewLoadingBarFill" />
    </span>
  </div>
);

// Some hosts only accept requests without a referer (imgur, twitter, …); a few
// require it (verb.tw). Strip the referer everywhere except the latter.
const needsReferer = src => {
  try {
    return /(^|\.)verb\.tw$/i.test(new URL(src, location.href).hostname);
  } catch (e) {
    return false;
  }
};

// <img> that walks a list of candidate URLs, advancing on each load error.
// One candidate (the resolved src) is the common case; twitter/meee supply
// fallbacks (e.g. :orig → .png:orig → :large → plain).
class FallbackImage extends React.PureComponent {
  state = { index: 0, loaded: false };

  // 換下一個候選網址時 loaded 一併重設，避免沿用上一張的已載入狀態。
  handleError = () =>
    this.setState(s => ({ index: s.index + 1, loaded: false }));
  handleLoad = () => this.setState({ loaded: true });

  render() {
    const { candidates, ...rest } = this.props;
    const src = candidates[this.state.index];
    if (src == null) {
      return false;
    }
    const { loaded } = this.state;
    return (
      <React.Fragment>
        {!loaded && <LoadingOverlay />}
        <img
          {...rest}
          {...(needsReferer(src) ? {} : { referrerPolicy: "no-referrer" })}
          src={src}
          onLoad={this.handleLoad}
          onError={this.handleError}
          style={loaded ? null : { display: "none" }}
        />
      </React.Fragment>
    );
  }
}

// <video>/<iframe> 內嵌：載入完成前疊 LoadingOverlay，避免網路慢時空白像壞掉。
class InlineVideo extends React.PureComponent {
  state = { loaded: false };
  handleLoad = () => this.setState({ loaded: true });
  render() {
    const { loaded } = this.state;
    return (
      <React.Fragment>
        {!loaded && <LoadingOverlay />}
        <video
          className="easyReadingVideo"
          src={this.props.src}
          controls
          onLoadedData={this.handleLoad}
          style={loaded ? null : { display: "none" }}
        />
      </React.Fragment>
    );
  }
}

class InlineIframe extends React.PureComponent {
  state = { loaded: false };
  handleLoad = () => this.setState({ loaded: true });
  render() {
    const { loaded } = this.state;
    return (
      <div style={{ margin: "0.5em auto", maxWidth: "800px", height: "450px" }}>
        {!loaded && <LoadingOverlay />}
        <iframe
          type="text/html"
          src={this.props.src}
          allowFullScreen
          referrerPolicy="origin-when-cross-origin"
          onLoad={this.handleLoad}
          style={{ border: "none", width: "100%", height: "100%" }}
        />
      </div>
    );
  }
}

const inlineImage = (descriptor, key) => (
  <FallbackImage
    key={key}
    className="easyReadingImg hyperLinkPreview"
    candidates={descriptor.srcset || [descriptor.src]}
  />
);

const inlineVideo = (src, key) => <InlineVideo key={key} src={src} />;

const inlineIframe = (src, key) => <InlineIframe key={key} src={src} />;

ImagePreviewer.Inline = ({ value, error }) => {
  if (error) {
    return false;
  } else if (value) {
    switch (value.type) {
      case "video":
        return inlineVideo(value.src, undefined);
      case "iframe":
        return inlineIframe(value.src, undefined);
      case "album":
        return value.images.map((url, i) =>
          RE_VIDEO_EXT.test(url)
            ? inlineVideo(url, i)
            : inlineImage({ src: url }, i)
        );
      default:
        return inlineImage(value, undefined);
    }
  } else {
    return <LoadingOverlay />;
  }
};

const RE_IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|apng|avif|jfif|pjpeg|pjp|svg|bmp|ico)(?:$|[?#])/i;
const RE_VIDEO_EXT = /\.(?:mp4|webm|ogg)(?:$|[?#])/i;

// Multiple client ids, picked at random, to spread imgur API quota.
const IMGUR_CLIENT_IDS = [
  "a023b4e4a5324bc",
  "ca7108e04622b7a",
  "e83ef0f75467fbf",
  "8683d4c3edf9f8f",
  "88f07b92270c5f2"
];

const resolveImgurAlbum = hash => {
  const clientId =
    IMGUR_CLIENT_IDS[Math.floor(Math.random() * IMGUR_CLIENT_IDS.length)];
  return fetch(`https://api.imgur.com/3/album/${hash}?client_id=${clientId}`, {
    mode: "cors",
    referrerPolicy: "no-referrer"
  })
    .then(r => r.json())
    .then(j => (j.data && j.data.images ? j.data.images.map(i => i.link) : []))
    .catch(() => []);
};

// Ordered most-specific → most-generic. `.find` returns the first matching
// resolver, so the generic extension resolvers sit just above the default.
// Adding a new host = one entry here; no per-host rendering logic.
const imageUrlResolvers = [
  {
    /* imgur album / gallery */
    regex: /^https?:\/\/(?:[mi]\.)?imgur\.com\/(?:a|gallery)\/(\w+)/i,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const hash = src.match(this.regex)[1];
      return resolveImgurAlbum(hash).then(images => ({
        type: "album",
        images
      }));
    }
  },
  {
    /* imgur single image (i.imgur.com/<id>.<ext> or imgur.com/<id>) */
    regex: /^https?:\/\/(?:[mi]\.)?imgur\.com\/([a-z0-9]+)(?:\.([a-z0-9]+))?/i,
    test(src) {
      return this.regex.test(src) && !/\/(?:a|gallery)\//i.test(src);
    },
    request(src) {
      const [, id, ext] = this.regex.exec(src);
      let e = (ext || "jpg").toLowerCase();
      if (e === "gifv") e = "gif";
      return Promise.resolve({
        type: "image",
        src: `https://i.imgur.com/${id}.${e}`
      });
    }
  },
  {
    /* twitter / X — request :orig with png/large/plain fallbacks */
    regex: /^https?:\/\/pbs\.twimg\.com\/media\/([\w-]+)(?:\.(\w+))?(?:\?.*?format=(\w+))?/i,
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
          `${base}.${ext}`
        ]
      });
    }
  },
  {
    /* meee.com.tw — real extension is unknown, try common ones */
    regex: /^https?:\/\/meee\.com\.tw\/(\w+)(?:\.(\w+))?/i,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const [, id, ext] = this.regex.exec(src);
      const exts = [
        ...new Set(
          [ext, "jpg", "jpeg", "png", "gif"]
            .filter(Boolean)
            .map(e => e.toLowerCase())
        )
      ];
      return Promise.resolve({
        type: "image",
        src: `https://i.meee.com.tw/${id}.${exts[0]}`,
        srcset: exts.map(e => `https://i.meee.com.tw/${id}.${e}`)
      });
    }
  },
  {
    /* youtube (watch / youtu.be / embed / shorts / live) */
    regex: /(?:youtube\.com\/watch\?[^#]*[?&]?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([\w-]{9,12})/i,
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
    }
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
        src: `https://clips.twitch.tv/embed?clip=${id}&parent=${location.hostname}`
      });
    }
  },
  {
    /* flickr */
    regex: /flic\.kr\/p\/(\w+)|flickr\.com\/photos\/[\w@]+\/(\d+)/,
    test(src) {
      return this.regex.test(src);
    },
    request(src) {
      const [, flickrBase58Id, flickrPhotoId] = src.match(this.regex);
      const photoId = flickrBase58Id ? decode(flickrBase58Id) : flickrPhotoId;

      const apiURL = `https://api.flickr.com/services/rest/?${new URLSearchParams(
        {
          method: "flickr.photos.getInfo",
          api_key: "c8c95356e465b8d7398ff2847152740e",
          photo_id: photoId,
          format: "json",
          nojsoncallback: 1
        }
      )}`;
      return fetch(apiURL, { mode: "cors" })
        .then(r => r.json())
        .then(data => {
          if (!data.photo) {
            throw new Error("Not found");
          }
          const { farm, server: svr, id, secret } = data.photo;
          return {
            type: "image",
            src: `https://farm${farm}.staticflickr.com/${svr}/${id}_${secret}.jpg`
          };
        });
    }
  },
  {
    /* any direct video link */
    test(src) {
      return RE_VIDEO_EXT.test(src);
    },
    request(src) {
      return Promise.resolve({ type: "video", src });
    }
  },
  {
    /* any direct image link — the generic catch-all that covers every host
       that serves a real image URL, with zero per-host code */
    test(src) {
      return RE_IMAGE_EXT.test(src);
    },
    request(src) {
      return Promise.resolve({ type: "image", src });
    }
  },
  {
    /* Default: not previewable */
    test() {
      return true;
    },
    request() {
      return Promise.reject(new Error("Unimplemented"));
    }
  }
];

export default ImagePreviewer;
