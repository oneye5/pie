// Redirect `react` imports to Preact's official compat layer.
//
// The pie webview renders with Preact, so react-ecosystem hooks (such as
// use-undo's useReducer/useCallback) must resolve to preact/compat rather than
// the real `react` package — real React hooks require the React reconciler and
// throw "Invalid hook call" under Preact's renderer.
//
// This shim is consumed by the tsx test runner (which, unlike vite, cannot apply
// a build-time alias to imports inside node_modules dependencies). The vite
// webview build instead uses `resolve.alias` to point `react` straight at
// `preact/compat`.
module.exports = require('preact/compat');
