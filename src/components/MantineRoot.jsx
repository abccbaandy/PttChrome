import {
  MantineProvider,
  createTheme,
  Button,
  ActionIcon,
  Menu,
} from "@mantine/core";
import { RIPPLE_CLASS } from "../js/ripple";

// 全 app 共用的 Mantine 主題。app 多個獨立 React root（#cmenuReact、#reactAlert）
// 各自掛一層 MantineProvider；預設暗色，但保留切換能力（defaultColorScheme="dark"
// → Mantine 預設 localStorageColorSchemeManager 監聽 storage event，多 root 共用
// 同 key 自動同步）。
const theme = createTheme({
  // 對齊終端機字型偏好（與 pref 的 fontFace 無關，這是 UI chrome 的字型）。
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  // 按下的波紋回饋（src/js/ripple.js 的委派只處理帶這個 class 的元素）：桌機與手機的
  // 對話框按鈕、圖示按鈕、右鍵選單項目。
  components: {
    Button: Button.extend({ classNames: { root: RIPPLE_CLASS } }),
    ActionIcon: ActionIcon.extend({ classNames: { root: RIPPLE_CLASS } }),
    Menu: Menu.extend({ classNames: { item: RIPPLE_CLASS } }),
  },
});

export const MantineRoot = ({ children }) => (
  <MantineProvider theme={theme} defaultColorScheme="dark">
    {children}
  </MantineProvider>
);

export default MantineRoot;
