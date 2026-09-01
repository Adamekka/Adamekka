import assert from "node:assert/strict";
import test from "node:test";

import { generateLanguageOutputs } from "./generate-language-stats.mjs";

function repository(name, languages) {
  return {
    name,
    languages: {
      edges: Object.entries(languages).map(([language, { bytes, color }]) => ({
        size: bytes,
        node: { color, name: language },
      })),
    },
  };
}

test("limits the card while listing every language in the text output", () => {
  const { languages, svg, text } = generateLanguageOutputs({
    repositories: [
      repository("Alpha", {
        "C++": { bytes: 100, color: "#f34b7d" },
        Rust: { bytes: 50, color: "#dea584" },
      }),
      repository("beta", {
        "C++": { bytes: 300, color: "#f34b7d" },
        Rust: { bytes: 50, color: "#dea584" },
        C: { bytes: 200, color: "#555555" },
      }),
      repository("Excluded", {
        C: { bytes: 10_000, color: "#555555" },
      }),
    ],
    excludedRepositories: ["Excluded"],
    languageLimit: 2,
  });

  assert.deepEqual(
    languages.map(({ name, bytes }) => ({ name, bytes })),
    [
      { name: "C++", bytes: 400 },
      { name: "C", bytes: 200 },
    ],
  );
  assert.equal(
    text,
    [
      "C++ 57.14%",
      "  beta 42.86%",
      "  Alpha 14.29%",
      "",
      "C 28.57%",
      "  beta 28.57%",
      "",
      "Rust 14.29%",
      "  Alpha 7.14%",
      "  beta 7.14%",
      "",
    ].join("\n"),
  );
  assert.match(svg, />C\+\+<\/text>\s*<text[^>]*>66\.67%<\/text>/);
  assert.match(svg, />C<\/text>\s*<text[^>]*>33\.33%<\/text>/);
  assert.doesNotMatch(svg, />Rust<\/text>/);
});

test("sorts ties deterministically and escapes language names in SVG", () => {
  const { languages, svg, text } = generateLanguageOutputs({
    repositories: [
      repository("zeta", {
        "A&B": { bytes: 10, color: "not-a-color" },
      }),
      repository("Alpha", {
        "A&B": { bytes: 10, color: "not-a-color" },
        alpha: { bytes: 10, color: "#123abc" },
      }),
      repository("beta", {
        alpha: { bytes: 10, color: "#123abc" },
      }),
    ],
    excludedRepositories: [],
    languageLimit: 2,
  });

  assert.deepEqual(
    languages.map((language) => language.name),
    ["A&B", "alpha"],
  );
  assert.match(svg, />A&amp;B<\/text>/);
  assert.match(svg, /fill="#858585"/);
  assert.match(
    text,
    /^A&B 50\.00%\n  Alpha 25\.00%\n  zeta 25\.00%/,
  );
});

test("rejects invalid byte counts and empty output", () => {
  assert.throws(
    () =>
      generateLanguageOutputs({
        repositories: [],
        excludedRepositories: [],
        languageLimit: 0,
      }),
    /languageLimit must be a positive integer/,
  );

  assert.throws(
    () =>
      generateLanguageOutputs({
        repositories: [
          repository("broken", {
            Rust: { bytes: 0, color: "#dea584" },
          }),
        ],
        excludedRepositories: [],
        languageLimit: 20,
      }),
    /invalid byte count/,
  );

  assert.throws(
    () =>
      generateLanguageOutputs({
        repositories: [
          repository("Excluded", {
            Rust: { bytes: 100, color: "#dea584" },
          }),
        ],
        excludedRepositories: ["Excluded"],
        languageLimit: 20,
      }),
    /no language data/,
  );
});
