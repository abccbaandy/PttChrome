import { MantineProvider, createTheme } from "@mantine/core";

// 全 app 共用的 Mantine 主題。app 多個獨立 React root（#cmenuReact、#reactAlert）
// 各自掛一層 MantineProvider；預設暗色，但保留切換能力（defaultColorScheme="dark"
// → Mantine 預設 localStorageColorSchemeManager 監聽 storage event，多 root 共用
// 同 key 自動同步）。
const theme = createTheme({
  // 對齊終端機字型偏好（與 pref 的 fontFace 無關，這是 UI chrome 的字型）。
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
});

export const MantineRoot = ({ children }) => (
  <MantineProvider theme={theme} defaultColorScheme="dark">
    {children}
  </MantineProvider>
);

export default MantineRoot;
