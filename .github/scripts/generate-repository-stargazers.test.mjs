import assert from "node:assert/strict";
import test from "node:test";

import { generateStargazerOutput } from "./generate-repository-stargazers.mjs";

test("formats starred repositories by count with stable name ordering", () => {
  const output = generateStargazerOutput({
    repositories: [
      {
        isArchived: false,
        name: "beta",
        stargazerCount: 2,
        stargazers: ["zeta-user", "AlphaUser"],
      },
      {
        isArchived: false,
        name: "Forked-Project",
        isFork: true,
        stargazerCount: 1,
        stargazers: ["fork-fan"],
      },
      {
        isArchived: false,
        name: "alpha",
        stargazerCount: 2,
        stargazers: ["SecondUser", "first-user"],
      },
      {
        isArchived: false,
        name: "No-Stars",
        stargazerCount: 0,
        stargazers: [],
      },
    ],
    excludedRepositories: [],
    repositoryOwner: "ProfileOwner",
  });

  assert.equal(
    output,
    [
      "alpha (2)",
      "  first-user",
      "  SecondUser",
      "",
      "beta (2)",
      "  AlphaUser",
      "  zeta-user",
      "",
      "Forked-Project (1)",
      "  fork-fan",
      "",
    ].join("\n"),
  );
});

test("writes an empty file when no repository has stargazers", () => {
  assert.equal(
    generateStargazerOutput({
      repositories: [
        {
          isArchived: false,
          name: "Empty",
          stargazerCount: 0,
          stargazers: [],
        },
        {
          isArchived: false,
          name: "Also-Empty",
          stargazerCount: 0,
          stargazers: [],
        },
      ],
      excludedRepositories: [],
      repositoryOwner: "ProfileOwner",
    }),
    "",
  );
});

test("rejects invalid and duplicate stargazer usernames", () => {
  assert.throws(
    () =>
      generateStargazerOutput({
        repositories: [
          {
            isArchived: false,
            name: "Invalid",
            stargazerCount: 1,
            stargazers: [""],
          },
        ],
        excludedRepositories: [],
        repositoryOwner: "ProfileOwner",
      }),
    /invalid stargazer username/,
  );
  assert.throws(
    () =>
      generateStargazerOutput({
        repositories: [
          {
            isArchived: false,
            name: "Duplicate",
            stargazerCount: 2,
            stargazers: ["User", "user"],
          },
        ],
        excludedRepositories: [],
        repositoryOwner: "ProfileOwner",
      }),
    /duplicate stargazer/,
  );
});

test("requires self-starred repositories to be explicitly excluded", () => {
  assert.throws(
    () =>
      generateStargazerOutput({
        repositories: [
          {
            isArchived: false,
            name: "Self-Starred",
            stargazerCount: 1,
            stargazers: ["profileowner"],
          },
        ],
        excludedRepositories: [],
        repositoryOwner: "ProfileOwner",
      }),
    /Self-Starred is starred by ProfileOwner; add it to STATS_EXCLUDED_REPOS/,
  );

  assert.equal(
    generateStargazerOutput({
      repositories: [
        {
          isArchived: false,
          name: "Self-Starred",
          stargazerCount: 1,
          stargazers: ["ProfileOwner"],
        },
      ],
      excludedRepositories: ["self-starred"],
      repositoryOwner: "ProfileOwner",
    }),
    "",
  );
});

test("rejects invalid repository data", () => {
  assert.throws(
    () =>
      generateStargazerOutput({
        repositories: [
          {
            isArchived: false,
            name: "",
            stargazerCount: 0,
            stargazers: [],
          },
        ],
        excludedRepositories: [],
        repositoryOwner: "ProfileOwner",
      }),
    /Repository names must be non-empty strings/,
  );
  assert.throws(
    () =>
      generateStargazerOutput({
        repositories: [
          {
            isArchived: false,
            name: "Missing-Stargazers",
            stargazerCount: 0,
          },
        ],
        excludedRepositories: [],
        repositoryOwner: "ProfileOwner",
      }),
    /must have a stargazers array/,
  );
});

test("uses reported counts and marks archived usernames GitHub withholds", () => {
  assert.equal(
    generateStargazerOutput({
      repositories: [
        {
          isArchived: true,
          name: "Archived-Project",
          stargazerCount: 3,
          stargazers: ["KnownUser"],
        },
        {
          isArchived: true,
          name: "Hidden-Project",
          stargazerCount: 1,
          stargazers: [],
        },
        {
          isArchived: false,
          name: "Active-Project",
          stargazerCount: 1,
          stargazers: ["Someone"],
        },
      ],
      excludedRepositories: [],
      repositoryOwner: "ProfileOwner",
    }),
    [
      "Archived-Project (3)",
      "  KnownUser",
      "  [2 stargazer usernames unavailable while archived]",
      "",
      "Active-Project (1)",
      "  Someone",
      "",
      "Hidden-Project (1)",
      "  [1 stargazer username unavailable while archived]",
      "",
    ].join("\n"),
  );
});
