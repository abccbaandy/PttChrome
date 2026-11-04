import {
  Paper,
  Button,
  Text,
  CloseButton,
  Group,
} from "@mantine/core";
import { i18n } from "../../js/i18n";
import { formatLiveElapsed } from "../../js/live_helper";
import "./LiveHelperModal.css";

// Live 文小幫手：PTT 官方推文實況（文章裡按 v）的操作面板（js/live_helper.js）。
// 「邊讀文章邊看新推文」的浮動控制列，**不可阻擋**底下終端機操作：fixed 定位的 Paper，
// 不是 modal（不搶焦點、不擋鍵盤，終端機照常收鍵）。
//
// view 是 live_helper.liveHelperFacts 的結果（容器每半秒重讀一次本幀）：
//   live         實況中：計時、收到幾則、(B)鈴聲 開／關、離開實況
//   ready        在文章裡：開始實況
//   busy／unavailable  按鈕停用＋一句為什麼
export const LiveHelperModal = ({ show, onHide, view, onStart, onLeave, onBell }) => {
  if (!show) return null;
  const kind = (view && view.kind) || "unavailable";
  const live = kind === "live";

  let note = null;
  if (kind === "unavailable") note = i18n("liveHelperNeedArticle");
  else if (kind === "busy") note = i18n("liveHelperBusy");
  else if (kind === "ready") note = i18n("liveHelperReadyNote");

  return (
    <Paper shadow="md" p="sm" withBorder className="LiveHelperModal">
      {/* wrap：手機窄螢幕放不下一列就折行，不要撐出畫面。 */}
      <Group gap="xs" wrap="wrap" className="LiveHelperModal__Body">
        <Text fw={700} className="LiveHelperModal__Body__Text nomouse_command">
          {i18n("liveHelperTitle")}
        </Text>
        {live ? (
          <>
            <span className="LiveHelperModal__OnAir nomouse_command">
              {i18n("liveHelperOn")} {formatLiveElapsed(view.elapsedSec)}
            </span>
            <Text size="sm" className="LiveHelperModal__Body__Text nomouse_command">
              {i18n("liveHelperReceived").replace("%d", String(view.received))}
            </Text>
            <Button
              size="xs"
              variant={view.bell ? "filled" : "default"}
              onClick={onBell}
              className="nomouse_command"
            >
              {view.bell ? i18n("liveHelperBellOn") : i18n("liveHelperBellOff")}
            </Button>
            <Button size="xs" color="red" variant="light" onClick={onLeave} className="nomouse_command">
              {i18n("liveHelperLeave")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="xs"
              onClick={onStart}
              disabled={kind !== "ready"}
              className="nomouse_command"
            >
              {i18n("liveHelperStart")}
            </Button>
            {note && (
              <Text size="sm" c="dimmed" className="LiveHelperModal__Body__Text nomouse_command">
                {note}
              </Text>
            )}
          </>
        )}
        <CloseButton
          className="LiveHelperModal__Body__Close nomouse_command"
          onClick={onHide}
          ml="auto"
          aria-label={i18n("liveHelperClose")}
        />
      </Group>
    </Paper>
  );
};

export default LiveHelperModal;
