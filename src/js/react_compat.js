// React 19 相容層：React 19 移除了 createFactory（自 16.13 起 deprecated）。
// recompose@0.26 仍在每個 HOC 內呼叫 createFactory(BaseComponent)
// （withState/withHandlers/lifecycle/withProps/compose… 全部），在 React 19 下
// 會 runtime 炸「createFactory is not a function」。完整把 6 個元件改寫成 hooks
// 留到階段三（見 docs/handoff/react-19-upgrade.md）；在那之前用本檔把
// createFactory 補回，當作過渡橋接。
//
// webpack `resolve.alias` 把裸 `react` specifier（精確比對 `react$`）導到本檔；
// 真 react 透過 `react-real` alias（webpack config 端 require.resolve('react')
// 算出的絕對路徑）取得，不會被 react$ 攔成迴圈，也繞過 react@19 exports 對
// `react/index.js` 子路徑的封鎖。
//
// 用 CommonJS 寫法刻意為之：對 CJS module.exports 物件，webpack 會合成全部具名
// export（createElement/Component/useState…）；若用 ESM `export *` 轉發 CJS 則
// 只能帶出 default，會讓整個 bundle 的 `import { useX } from "react"` 失聯。
const React = require("react-real");

module.exports = Object.assign({}, React, {
  // createFactory(type) === bound createElement，與 React 舊實作等價。
  createFactory(type) {
    return React.createElement.bind(null, type);
  },
});
