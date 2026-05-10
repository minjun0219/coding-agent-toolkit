import { describe, it, expect } from "bun:test";
import { joinBaseAndPath, syntheticOperationId } from "./url";

describe("joinBaseAndPath", () => {
  it("inserts a slash when missing", () => {
    expect(joinBaseAndPath("https://api.example.com", "pet")).toBe(
      "https://api.example.com/pet",
    );
  });
  it("avoids double slashes", () => {
    expect(joinBaseAndPath("https://api.example.com/", "/pet")).toBe(
      "https://api.example.com/pet",
    );
    expect(joinBaseAndPath("https://api.example.com//", "//pet")).toBe(
      "https://api.example.com//pet",
    );
  });
  it("preserves path-style base URLs", () => {
    expect(joinBaseAndPath("https://api.example.com/v1", "/pet/{petId}")).toBe(
      "https://api.example.com/v1/pet/{petId}",
    );
  });
  it("returns path as-is when baseUrl is empty", () => {
    expect(joinBaseAndPath("", "/pet")).toBe("/pet");
  });
});

describe("syntheticOperationId", () => {
  it("drops braces and lowercases method", () => {
    expect(syntheticOperationId("GET", "/pet/{petId}")).toBe("get_pet_petId");
  });
  it("handles root path", () => {
    expect(syntheticOperationId("post", "/")).toBe("post_root");
  });
});
