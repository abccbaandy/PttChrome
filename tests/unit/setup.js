// Render tests run under jsdom + @testing-library/react (jest.config.js
// testEnvironment:"jsdom"). jest-dom adds DOM matchers; testing-library sets
// IS_REACT_ACT_ENVIRONMENT and wraps render in act() itself, so no global React
// or test-renderer shim is needed.
import "@testing-library/jest-dom";
