import { useEffect, useState } from "react";
import { Alert, Button, Transition } from "@mantine/core";
import { i18n } from "../js/i18n";
import "./PageTopAlert.css";

// 外部連結開出來的新分頁，發現已經有一個登入好的分頁接手了跳轉時顯示。
//
// 為什麼只能請使用者自己切回去：既有分頁沒有 user activation，window.focus()
// 叫不動自己；而這個新分頁是外部程式開的，window.close() 也關不掉（只有 script
// 開出來的視窗關得掉）。這兩件事瀏覽器就是不給，不是這裡少做了什麼。
export const DeepLinkHandoffAlert = ({ target, onStayHere }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Transition mounted={mounted} transition="fade" duration={200}>
      {(styles) => (
        <Alert
          style={styles}
          color="blue"
          className="PageTopAlert"
          title={i18n("alert_deepLinkHandoffHeader")}
        >
          <p>
            {i18n("alert_deepLinkHandoffText")}
            {target ? " #" + target.aid + " (" + target.board + ")" : ""}
          </p>
          <Button color="blue" onClick={onStayHere}>
            {i18n("alert_deepLinkHandoffStay")}
          </Button>
        </Alert>
      )}
    </Transition>
  );
};

export default DeepLinkHandoffAlert;
