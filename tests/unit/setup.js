// react-test-renderer@19：React 19 的 test-renderer 預設 concurrent，初次 mount
// 不再同步 commit——未包 act() 時 create(...).toJSON() / .root 會是 null。本專案
// 暫留 test-renderer（hooks 化/testing-library 遷移留階段三），故在此集中把
// create 包一層 act()，讓既有 3 個 render 測試（row_render / image_preview /
// screen_dropHidden，皆只做初次 mount + 同步讀取）零改動沿用。
global.IS_REACT_ACT_ENVIRONMENT = true;
const TestRenderer = require("react-test-renderer");
const origCreate = TestRenderer.create;
TestRenderer.create = function (element, options) {
  let inst;
  TestRenderer.act(() => {
    inst = origCreate.call(this, element, options);
  });
  return inst;
};
