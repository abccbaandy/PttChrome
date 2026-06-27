import { useCallback } from "react";
import { Modal, OverlayTrigger, Tooltip, Button } from "react-bootstrap";
import { i18n } from "../../js/i18n";
import "./LiveHelperModal.css";

const normalizeSec = value => {
  const sec = parseInt(value, 10);
  return sec > 1 ? sec : 1;
};

export const LiveHelperModal = ({ show, onHide, enabled, sec, onChange }) => {
  const onEnabledClick = useCallback(
    () => onChange({ enabled: !enabled, sec }),
    [enabled, sec, onChange]
  );
  const onSecChange = useCallback(
    ({ target: { value } }) => onChange({ enabled, sec: normalizeSec(value) }),
    [enabled, onChange]
  );

  return (
    <Modal show={show} backdrop={false}>
      <Modal.Body className="LiveHelperModal__Body">
        <OverlayTrigger
          placement="top"
          overlay={<Tooltip id="liveHelperShortcut">Alt + r</Tooltip>}
        >
          <Button variant="secondary" active={enabled} onClick={onEnabledClick}>
            {i18n("liveHelperEnable")}
          </Button>
        </OverlayTrigger>
        <span className="LiveHelperModal__Body__Text nomouse_command">
          {i18n("liveHelperSpan")}
        </span>
        <input
          type="number"
          className="LiveHelperModal__Body__Input form-control nomouse_command"
          value={sec}
          onChange={onSecChange}
        />
        <span className="LiveHelperModal__Body__Text nomouse_command">
          {i18n("liveHelperSpanSec")}
        </span>
        <button
          type="button"
          className="LiveHelperModal__Body__Close close nomouse_command"
          onClick={onHide}
        >
          &times;
        </button>
      </Modal.Body>
    </Modal>
  );
};

export default LiveHelperModal;
