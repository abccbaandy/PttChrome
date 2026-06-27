import { useEffect } from "react";
import { Alert, Button, Fade } from "react-bootstrap";
import { i18n } from "../js/i18n";
import "./PageTopAlert.css";

export const ConnectionAlert = ({ onDismiss }) => {
  useEffect(() => {
    const handler = e => {
      if (e.keyCode == 13) {
        onDismiss();
      }
      // Kills everything becase we don't want any further action performed under ConnectionAlert status
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onDismiss]);

  return (
    <Fade in appear>
      <Alert
        variant="danger"
        className="PageTopAlert"
        dismissible
        onClose={onDismiss}
      >
        <h4>{i18n("alert_connectionHeader")}</h4>
        <p>{i18n("alert_connectionText")}</p>
        <p>
          <Button variant="danger" onClick={onDismiss}>
            {i18n("alert_connectionReconnect")}
          </Button>
        </p>
      </Alert>
    </Fade>
  );
};

export default ConnectionAlert;
