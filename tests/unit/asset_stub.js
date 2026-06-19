// Jest stub for non-JS asset imports (png/gif/bmp/css …). Webpack turns these
// into URL strings / CSS side effects at build time; in unit tests they are
// irrelevant, so map them all to a harmless string via jest moduleNameMapper.
module.exports = "asset-stub";
