import { describe, expect, it } from "vitest";
import { contactSearchFilter, sanitizeSearch } from "./search";

describe("sanitizeSearch", () => {
  it("keeps what a name, phone, or email is actually made of", () => {
    expect(sanitizeSearch("Rosy Perera")).toBe("Rosy Perera");
    expect(sanitizeSearch("+52 998-123.45")).toBe("+52 998-123.45");
    expect(sanitizeSearch("ana_b@gama.mx")).toBe("ana_b@gama.mx");
  });

  it("keeps accents and non-Latin letters", () => {
    expect(sanitizeSearch("Ángel Chávez")).toBe("Ángel Chávez");
    expect(sanitizeSearch("生きたい")).toBe("生きたい");
  });

  it("strips the characters that would break PostgREST's or() grammar", () => {
    // A comma would start a new filter, parens would open a group, and
    // % / * are its wildcards — all of them turn a search box into a
    // way to rewrite the query.
    expect(sanitizeSearch("a,name.ilike.*")).toBe("aname.ilike.");
    expect(sanitizeSearch("or(id.eq.1)")).toBe("orid.eq.1");
    expect(sanitizeSearch("100%")).toBe("100");
  });

  it("trims the edges", () => {
    expect(sanitizeSearch("  pedro  ")).toBe("pedro");
  });
});

describe("contactSearchFilter", () => {
  it("matches a partial name or a partial number", () => {
    expect(contactSearchFilter("ros")).toBe(
      "name.ilike.%ros%,phone.ilike.%ros%",
    );
  });

  it("widens to the columns the caller asks for", () => {
    expect(contactSearchFilter("ana", ["name", "phone", "email"])).toBe(
      "name.ilike.%ana%,phone.ilike.%ana%,email.ilike.%ana%",
    );
  });

  it("returns null when nothing survives sanitizing, so the caller keeps its unfiltered query", () => {
    expect(contactSearchFilter("")).toBeNull();
    expect(contactSearchFilter("   ")).toBeNull();
    expect(contactSearchFilter("%%%")).toBeNull();
  });
});
