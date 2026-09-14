import { useCallback } from "react";
import {
  Paper,
  Button,
  NumberInput,
  Text,
  CloseButton,
  Group,
} from "@mantine/core";
import { i18n } from "../../js/i18n";
import "./LiveHelperModal.css";

const normalizeSec = (value) => {
  const sec = parseInt(value, 10);
  return sec > 1 ? sec : 1;
};

// 實況助手是「邊讀文章邊自動更新」的浮動控制列，**不可阻擋**底下終端機操作。
// 舊版 RB Modal backdrop=false 靠 bootstrap 的 pointer-events 穿透；改用浮動 Paper
// （fixed 定位、CSS 控 pointer-events），語意更正確也免 focus-trap。
export const LiveHelperModal = ({ show, onHide, enabled, sec, onChange }) => {
  const onEnabledClick = useCallback(
    () => onChange({ enabled: !enabled, sec }),
    [enabled, sec, onChange],
  );
  const onSecChange = useCallback(
    (value) => onChange({ enabled, sec: normalizeSec(value) }),
    [enabled, onChange],
  );

  if (!show) return null;

  return (
    <Paper shadow="md" p="sm" withBorder className="LiveHelperModal">
      <Group gap="xs" wrap="nowrap" className="LiveHelperModal__Body">
        {/* upstream 的 Tooltip 寫「Alt + r」，但本 fork 的 Alt+R 送的是 ^R（現在
            Alt+A~Z 全是 PTT 的 Ctrl，見 term_keyboard），實況更新走的是
            pttchrome.jsx 的方向鍵序列，從來沒綁 Alt+R。照著按只會得到別的結果，
            所以拿掉；真正的鍵盤入口是 END（term_view.onKeyDown）。 */}
        <Button
          variant={enabled ? "filled" : "default"}
          onClick={onEnabledClick}
        >
          {i18n("liveHelperEnable")}
        </Button>
        <Text className="LiveHelperModal__Body__Text nomouse_command">
          {i18n("liveHelperSpan")}
        </Text>
        <NumberInput
          className="LiveHelperModal__Body__Input nomouse_command"
          w={70}
          min={1}
          value={sec}
          onChange={onSecChange}
        />
        <Text className="LiveHelperModal__Body__Text nomouse_command">
          {i18n("liveHelperSpanSec")}
        </Text>
        <CloseButton
          className="LiveHelperModal__Body__Close nomouse_command"
          onClick={onHide}
          ml="auto"
        />
      </Group>
    </Paper>
  );
};

export default LiveHelperModal;
