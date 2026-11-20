import { describe, expect, it } from "vitest";
import { isAuthorizedCron } from "@/lib/cron-auth";

const SECRET = "abcdefghijklmnop1234";

describe("isAuthorizedCron", () => {
  it("accepts the exact bearer secret", () => {
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing, wrong or differently formatted header", () => {
    expect(isAuthorizedCron(null, SECRET)).toBe(false);
    expect(isAuthorizedCron("", SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCron(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  it("fails closed when the secret is unset, empty, short or not alphanumeric", () => {
    expect(isAuthorizedCron("Bearer undefined", undefined)).toBe(false);
    expect(isAuthorizedCron("Bearer ", "")).toBe(false);
    expect(isAuthorizedCron("Bearer short123", "short123")).toBe(false);
    expect(isAuthorizedCron("Bearer has-a-dash-in-it-123", "has-a-dash-in-it-123")).toBe(false);
  });
});
