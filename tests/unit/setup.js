// Components use a global `React` (webpack ProvidePlugin var:'React'), never an
// import. Provide it for jest so JSX (React.createElement) resolves.
global.React = require("react");
