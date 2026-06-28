// PostCSS for Mantine (官方建議設定)。preset-mantine 提供 light-dark()/rem()/
// breakpoint mixin；simple-vars 供 $mantine-breakpoint-* 變數。對既有 main.css/
// color.css 為安全 no-op（只轉換 Mantine 專屬函式/mixin）。
module.exports = {
  plugins: {
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
};
