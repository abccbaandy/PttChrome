// 假 core 上的假 session（`{ aidNavigation: { active: true } }` 這類物件）照真 App 一樣向線路登記。
//
// 真 App 由各 session 建構時 holdWireWhile（src/js/wire_lease.js），serialized_op_gate 只問 wire_lease；
// 測試裡的假 session 沒有跑建構子，這裡代登記。讀的是**當下的** core[owner]：測試中途把
// core.longPush 整個換掉也照讀。提示字與判斷用 session 模組自己 export 的同一支函式，不在這裡另寫一份。
import { holdWireWhile } from "../../../src/js/wire_lease";
import { aidNavigationWireHint } from "../../../src/js/aid_navigation";
import { longPushWireHint } from "../../../src/js/long_push_session";
import { logoutWireHint } from "../../../src/js/logout_session";
import { boardNoteSkipWireHint } from "../../../src/js/board_note_skip";

export function wireFakeSessions(core) {
  holdWireWhile(core, "aidNavigation", () => aidNavigationWireHint(core.aidNavigation));
  holdWireWhile(core, "longPush", () => longPushWireHint(core.longPush));
  holdWireWhile(core, "logout", () => logoutWireHint(core.logout));
  holdWireWhile(core, "boardNoteSkip", () => boardNoteSkipWireHint(core.boardNoteSkip));
  return core;
}
