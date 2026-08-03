// Render tests run under jsdom + @testing-library/react (vitest.config.mjs
// testEnvironment:"jsdom"). jest-dom adds DOM matchers; testing-library sets
// IS_REACT_ACT_ENVIRONMENT and wraps render in act() itself, so no global React
// or test-renderer shim is needed.
import "@testing-library/jest-dom";
