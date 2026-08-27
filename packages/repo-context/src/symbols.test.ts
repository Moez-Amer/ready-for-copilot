import { describe, expect, it } from "vitest";
import { extractClaims } from "./symbols.js";

describe("extractClaims", () => {
  it("pulls out file paths the issue names", () => {
    const { paths } = extractClaims("Rename the field in src/models/user.py and update migrations/");
    expect(paths).toContain("src/models/user.py");
    expect(paths).toContain("migrations/");
  });

  it("pulls out backticked code identifiers", () => {
    const { symbols } = extractClaims("Rename `getUser` to `fetchUser`.");
    expect(symbols).toEqual(expect.arrayContaining(["getUser", "fetchUser"]));
  });

  it("recognises snake_case and PascalCase as code", () => {
    const { symbols } = extractClaims("The email_addr column on UserSerializer is wrong.");
    expect(symbols).toEqual(expect.arrayContaining(["email_addr", "UserSerializer"]));
  });

  it("does not mistake ordinary prose for code", () => {
    const { symbols } = extractClaims("The login is broken, please fix this bug when you can.");
    expect(symbols).toHaveLength(0);
  });

  it("ignores URLs, which are not repository paths", () => {
    const { paths } = extractClaims("See https://example.com/docs/thing for details.");
    expect(paths.some((p) => p.includes("example.com"))).toBe(false);
  });

  it("caps how much it extracts, to bound downstream API calls", () => {
    const many = Array.from({ length: 40 }, (_, i) => `\`symbolName${i}\``).join(" ");
    const { symbols } = extractClaims(many);
    expect(symbols.length).toBeLessThanOrEqual(6);
  });
});
