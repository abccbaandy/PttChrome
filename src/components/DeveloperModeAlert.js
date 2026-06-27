import React from "react";
import { Alert, Button, Fade } from "react-bootstrap";
import { i18n } from "../js/i18n";
import "./PageTopAlert.css";

export const DeveloperModeAlert = ({ onDismiss }) => (
  <Fade in appear>
    <Alert
      variant="danger"
      className="PageTopAlert"
      dismissible
      onClose={onDismiss}
    >
      <h4>{i18n("alert_developerModeHeader")}</h4>
      <p>{i18n("alert_developerModeText")}</p>
      <p>
        <Button variant="danger" onClick={onDismiss}>
          {i18n("alert_developerModeDismiss")}
        </Button>
      </p>
    </Alert>
  </Fade>
);

export default DeveloperModeAlert;
