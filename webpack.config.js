const path = require('path');
const webpack = require('webpack');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const HtmlWebpackHarddiskPlugin = require('html-webpack-harddisk-plugin');
const WebpackCdnPlugin = require('webpack-cdn-plugin');

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
    // firebase modular SDK 的 lazy chunk 屬刻意設計（未登入零下載），
    // 門檻調到實際合理值以濾掉雜訊，但仍保留 'warning' 偵測真正異常肥大。
    // firebase lazy chunk 實測約 517 KiB，給餘裕設 600 KiB
    maxAssetSize: 614400,
    maxEntrypointSize: 614400,
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
    }),
    new WebpackCdnPlugin({
      crossOrigin: 'anonymous',
      modules: [
        {
          // jQuery must be loaded before bootstrap.
          name: 'jquery',
          var: 'jQuery',
          path: 'dist/jquery.min.js',
        },
        {
          name: 'bootstrap',
          var: 'bootstrap',
          path: 'dist/js/bootstrap.min.js',
          style: 'dist/css/bootstrap.min.css',
        },
        {
          name: 'hammerjs',
          var: 'Hammer',
          path: 'hammer.min.js',
        },
        {
          name: 'react',
          var: 'React',
          path: 'umd/react.production.min.js',
        },
        {
          name: 'react-dom',
          var: 'ReactDOM',
          path: 'umd/react-dom.production.min.js',
        },
      ],
    })
  ].concat(PRODUCTION_MODE ? [] : [
    new HtmlWebpackHarddiskPlugin()
  ]),
  devServer: {
    static: path.join(__dirname, './dist'),
    port: 8080,
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
