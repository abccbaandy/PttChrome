import { useCallback } from "react";
import {
  Paper,
  Tooltip,
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
        <Tooltip label="Alt + r" position="top">
          <Button
            variant={enabled ? "filled" : "default"}
            onClick={onEnabledClick}
          >
            {i18n("liveHelperEnable")}
          </Button>
        </Tooltip>
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
