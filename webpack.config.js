const path = require('path');
const webpack = require('webpack');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const HtmlWebpackHarddiskPlugin = require('html-webpack-harddisk-plugin');

const DEVELOPER_MODE = process.env.NODE_ENV === 'development'
const PRODUCTION_MODE = process.env.NODE_ENV !== 'development'

// Build identity, surfaced in the About tab and the startup console line so a
// running page can be matched to a commit (stale-deploy debugging).
let GIT_COMMIT = 'unknown';
try {
  GIT_COMMIT = require('child_process')
    .execSync('git rev-parse --short HEAD')
    .toString()
    .trim();
} catch (e) {}
// Display in UTC+8 (台灣時間) — the user base is in Taiwan, so a +8 timestamp is
// what people expect to see in the About tab / startup console.
const BUILD_TIME = new Date(Date.now() + 8 * 3600 * 1000)
  .toISOString()
  .replace('T', ' ')
  .replace(/\..+$/, '') + ' (UTC+8)';

module.exports = {
  mode: PRODUCTION_MODE ? 'production' : 'development',
  entry: {
    'pttchrome': './src/entry.js',
  },
  // jQuery is imported in source but provided as a CDN global (loaded by a
  // <script> tag in src/dev.html) rather than bundled; hammerjs is global-only
  // (no import). React/react-dom are now BUNDLED (React 19 dropped the UMD
  // build, so the old CDN-global + externals path is no longer viable). Source
  // files that reference a bare `React` (classic JSX runtime, React.Component,
  // React.createRef, ...) get it from the ProvidePlugin below instead of
  // window.React. bootstrap provides CSS only (CDN <link>); react-bootstrap 2
  // is a bundled import and needs no global.
  output: {
    path: path.join(__dirname, 'dist/assets/'),
    publicPath: 'assets/',
    pathinfo: DEVELOPER_MODE,
    filename: `[name]${ PRODUCTION_MODE ? '.[contenthash]' : '' }.js`
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        loader: "babel-loader",
      },
      {
        test: /\.css$/,
        use: [
          {
            loader: MiniCssExtractPlugin.loader,
            // CSS and the fonts/icons it references both live in dist/assets/;
            // emit url()s relative to the CSS file instead of output.publicPath
            // (which would double up as assets/assets/...).
            options: { publicPath: '' },
          },
          'css-loader',
          // postcss-preset-mantine（light-dark()/rem()/breakpoint mixin）。對既有
          // main.css/color.css 為安全 no-op。設定見 postcss.config.cjs。
          'postcss-loader',
        ],
      },
      {
        test: /\.(bin|bmp|png|woff)$/,
        oneOf: [
          {
            resourceQuery: /inline/,
            type: 'asset/inline',
          },
          {
            type: 'asset/resource',
            generator: {
              filename: '[name].[hash][ext]',
            },
          }
        ]
      }
    ]
  },
  devtool: 'source-map',
  performance: {
    hints: PRODUCTION_MODE ? 'warning' : false,
    // source-map 檔（devtool: 'source-map' 產生）不計入體積判斷
    assetFilter: (assetFilename) => !assetFilename.endsWith('.map'),
    // 門檻調到實際合理值以濾掉雜訊，但仍保留 'warning' 偵測真正異常肥大。
    // 基線：firebase lazy chunk ~517 KiB（刻意設計，未登入零下載）。
    // Mantine（UI 元件庫）：bundle 後 JS ~648 KiB、prebuilt styles.css ~246 KiB
    // （gzip 後 css ~35 KiB），entrypoint 合計 ~894 KiB。皆為單純壓縮體積（非異常），
    // 故 maxAssetSize 700 KiB、maxEntrypointSize 950 KiB。
    maxAssetSize: 716800,
    maxEntrypointSize: 972800,
  },
  optimization: {
    // '...' keeps webpack's built-in terser for JS alongside the CSS minimizer.
    minimizer: ['...', new CssMinimizerPlugin()],
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.PTTCHROME_PAGE_TITLE': JSON.stringify(process.env.PTTCHROME_PAGE_TITLE || 'PttChrome'),
      'process.env.DEFAULT_SITE': JSON.stringify(PRODUCTION_MODE ? 'wsstelnet://ws.ptt.cc/bbs' : 'wstelnet://localhost:8080/bbs'),
      // Default OFF: ignore ?site= in the URL (a page-author/link could otherwise
      // point the client at an arbitrary WebSocket host). Users who want a custom
      // proxy set it in Preferences instead (useProxy + proxyUrl, see pref_storage.js).
      // Set ALLOW_SITE_IN_QUERY=yes to re-enable the query override.
      'process.env.ALLOW_SITE_IN_QUERY': JSON.stringify(process.env.ALLOW_SITE_IN_QUERY === 'yes'),
      'process.env.DEVELOPER_MODE': JSON.stringify(DEVELOPER_MODE),
      // App Check debug token for local dev (pref_sync.js). Comes from the
      // developer's machine env, never from the repo — a registered debug
      // token bypasses reCAPTCHA, so committing it would defeat App Check.
      // Unset → undefined → pref_sync falls back to per-profile auto tokens.
      'process.env.APPCHECK_DEBUG_TOKEN': JSON.stringify(process.env.APPCHECK_DEBUG_TOKEN) || 'undefined',
      'process.env.GIT_COMMIT': JSON.stringify(GIT_COMMIT),
      'process.env.BUILD_TIME': JSON.stringify(BUILD_TIME),
      // Emulator hookup in pref_sync.js is test-only (set by `firebase
      // emulators:exec` under jest); pin to undefined so terser drops it.
      'process.env.FIRESTORE_EMULATOR_HOST': 'undefined',
      'process.env.FIREBASE_AUTH_EMULATOR_HOST': 'undefined',
      'process.env.GCLOUD_PROJECT': 'undefined',
    }),
    new MiniCssExtractPlugin({
      filename: '[name].[contenthash].css',
      chunkFilename: '[id].css',
    }),
    new HtmlWebpackPlugin({
      alwaysWriteToDisk: DEVELOPER_MODE,
      minify: {
        collapseWhitespace: PRODUCTION_MODE,
        removeComments: PRODUCTION_MODE
      },
      inject: 'head',
      template: './src/dev.html',
      filename: '../index.html'
    })
  ].concat(PRODUCTION_MODE ? [] : [
    new HtmlWebpackHarddiskPlugin()
  ]),
  devServer: {
    static: path.join(__dirname, './dist'),
    port: 8080,
    client: {
      overlay: {
        // "ResizeObserver loop completed with undelivered notifications" 是無害的
        // 瀏覽器節流警告（Mantine 的 Modal/Tabs 等用 ResizeObserver 會觸發）。WDS
        // 預設把它當 uncaught runtime error 蓋上全螢幕 overlay → 擋住點擊（含 e2e）。
        // 過濾掉這條噪音，真正的錯誤照常顯示。
        runtimeErrors: (error) =>
          !(error && /ResizeObserver loop/.test(error.message)),
      },
    },
    devMiddleware: {
      // output.publicPath is relative ('assets/') for the static deploy;
      // dev-middleware v5+ no longer normalizes it, so serve explicitly.
      publicPath: '/assets/',
    },
    proxy: [
      {
        context: ['/bbs'],
        target: 'https://ws.ptt.cc',
        secure: true,
        ws: true,
        changeOrigin: true,
        onProxyReqWs(proxyReq) {
          // Whitelist does not accept ws.ptt.cc
          proxyReq.setHeader('origin', 'https://term.ptt.cc');
        }
      }
    ]
  }
};
