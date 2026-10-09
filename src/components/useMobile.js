import { useState, useEffect } from "react";

// 元件端讀「現在是不是手機版面」（App.mobile，唯一寫入點 App.applyMobileLayout）。
// 訂閱 App.onMobileChange；測試常用假的 pttchrome（沒有這支）＝永遠不是手機。
export function useMobile(pttchrome) {
  const [mobile, setMobile] = useState(() => !!(pttchrome && pttchrome.mobile));
  useEffect(() => {
    setMobile(!!(pttchrome && pttchrome.mobile));
    if (!pttchrome || typeof pttchrome.onMobileChange !== "function")
      return undefined;
    return pttchrome.onMobileChange((m) => setMobile(!!m));
  }, [pttchrome]);
  return mobile;
}
