import { useSyncExternalStore } from "react";
import { getProxyStatus, subscribeProxyStatus } from "../../js/proxy_status";

// 連結旁的 imgur 快取代理狀態徽章。
//
//   "proxy" → ◇ 這次載入經過代理，代理端未命中（已回源）
//   "cache" → ◆ 這次載入經過代理，且代理端快取命中（圖沒出國）
//   "none"  → 不渲染任何東西，DOM 與這功能不存在時逐字相同
//             （直連、fail-open 302 退回原址、瀏覽器本機快取命中都算）
//
// 狀態來自 module 級的 store（src/js/proxy_status.js）而不是 props：實際知道結果的是
// 預覽圖的 <img> onload，而它與這個 <a> 在**不同 DOM 子樹**（LinkSegmentBuilder.build
// 把 segs 與 previews 分開），而且 LazyInlinePreview 捲遠了還會把預覽卸掉。
// 每個徽章自行訂閱 ⇒ 不必為了這個讓整列重繪。
//
// 空心／實心同一族幾何字元：體積差一眼可辨、字型覆蓋率高、**零網路請求**，
// 也不像 emoji 會被系統字型換成彩色圖案（會拖累渲染又壓不住大小）。
const GLYPH = { proxy: "◇", cache: "◆" };
const TITLE = {
  proxy: "經由快取代理載入（代理端未命中，已回源）",
  cache: "經由快取代理載入（代理快取命中，未連 imgur）",
};

export const ProxyBadge = ({ href }) => {
  const status = useSyncExternalStore(subscribeProxyStatus, () =>
    getProxyStatus(href),
  );
  if (status === "none") return null;
  return (
    <span
      className={
        status === "cache" ? "proxyBadge proxyBadge--cache" : "proxyBadge"
      }
      title={TITLE[status]}
    >
      {GLYPH[status]}
    </span>
  );
};

export default ProxyBadge;
