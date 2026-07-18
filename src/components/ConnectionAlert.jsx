import { useEffect, useState } from "react";
import { Alert, Button, Transition } from "@mantine/core";
import { i18n } from "../js/i18n";
import "./PageTopAlert.css";

export const ConnectionAlert = ({ onDismiss }) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const handler = (e) => {
      if (e.keyCode == 13) {
        onDismiss();
      }
      // Kills everything becase we don't want any further action performed under ConnectionAlert status
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onDismiss]);

  return (
    <Transition mounted={mounted} transition="fade" duration={200}>
      {(styles) => (
        <Alert
          style={styles}
          color="red"
          className="PageTopAlert"
          withCloseButton
          onClose={onDismiss}
          title={i18n("alert_connectionHeader")}
        >
          <p>{i18n("alert_connectionText")}</p>
          <Button color="red" onClick={onDismiss}>
            {i18n("alert_connectionReconnect")}
          </Button>
        </Alert>
      )}
    </Transition>
  );
};

export default ConnectionAlert;
