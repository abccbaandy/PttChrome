import { Fragment } from "react";
import { ImageUploadOverlay } from "./ImageUploadOverlay";
import { ImageUploadPanel } from "./ImageUploadPanel";

// 上傳功能的整層 UI（拖曳遮罩／進度／結果提示／紀錄面板）。由
// js/image_upload_controller.js 以 imperative render 掛進 #imageUploadReact，
// 狀態全部由 controller 持有——這層不自己存任何東西，純畫。
export const ImageUploadLayer = ({ controller, state }) => (
  <Fragment>
    <ImageUploadOverlay
      dragging={state.dragging}
      uploading={state.uploading}
      notice={state.notice}
      onOpenPanel={() => controller.openPanel()}
      onDismiss={() => controller.dismissNotice()}
    />
    {state.panelOpen && (
      <ImageUploadPanel
        history={state.history}
        uploading={state.uploading}
        onInsert={(url) => controller.insertOne(url)}
        onCopy={(url) => controller.copyUrl(url)}
        onRemove={(url) => controller.removeHistory(url)}
        onClear={() => controller.clearHistoryAll()}
        onClose={() => controller.closePanel()}
      />
    )}
  </Fragment>
);

export default ImageUploadLayer;
