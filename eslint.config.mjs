import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
  ]),

  // React Compiler rules: kept on, demoted to warnings.
  //
  // These ship as errors, and they flag patterns this app uses on
  // purpose and documents in place — the hydration-safe localStorage
  // read in the inbox page, and resetting derived state when the active
  // conversation changes. Rewriting ~23 call sites across the inbox and
  // settings buys one render per site and risks real regressions in the
  // most-used screen in the product.
  //
  // Left as errors they cost more than they return: a permanent count of
  // 26 is indistinguishable from 27, so the next genuine error lands
  // invisibly. As warnings they stay on the report and stop drowning it.
  //
  // Worth revisiting if `reactCompiler` is ever enabled in
  // next.config.ts — `preserve-manual-memoization` in particular only
  // describes lost optimisation, which is inert until then.
  {
    name: "react-compiler/advisory",
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
    },
  },
]);

export default eslintConfig;
