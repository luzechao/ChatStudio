import assert from "node:assert/strict";
import test from "node:test";
import { isThemePreference, resolveTheme } from "../src/renderer/theme.js";

test("theme preferences are validated and system resolution respects explicit overrides", () => {
  for (const value of ["light", "dark", "system"]) assert.equal(isThemePreference(value), true);
  for (const value of [null, undefined, "", "auto", {}]) assert.equal(isThemePreference(value), false);
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
