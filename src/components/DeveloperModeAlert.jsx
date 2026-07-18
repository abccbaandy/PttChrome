import { useEffect, useState } from "react";
import { Alert, Button, Transition } from "@mantine/core";
import { i18n } from "../js/i18n";
import "./PageTopAlert.css";

export const DeveloperModeAlert = ({ onDismiss }) => {
  // Fade-in（取代 RB 的 <Fade in appear>）：mount 後再翻 true 觸發過場。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Transition mounted={mounted} transition="fade" duration={200}>
      {(styles) => (
        <Alert
          style={styles}
          color="red"
          className="PageTopAlert"
          withCloseButton
          onClose={onDismiss}
          title={i18n("alert_developerModeHeader")}
        >
          <p>{i18n("alert_developerModeText")}</p>
          <Button color="red" onClick={onDismiss}>
            {i18n("alert_developerModeDismiss")}
          </Button>
        </Alert>
      )}
    </Transition>
  );
};

export default DeveloperModeAlert;
