#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

const repositoriesQuery = `
  query OwnedRepositories($login: String!, $cursor: String) {
    viewer {
      login
    }
    user(login: $login) {
      repositories(
        ownerAffiliations: OWNER
        first: 100
        after: $cursor
        orderBy: { field: NAME, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isArchived
          name
          owner {
            login
          }
          stargazerCount
        }
      }
    }
  }
`;

const stargazersQuery = `
  query RepositoryStargazers(
    $owner: String!
    $name: String!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      stargazers(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          login
        }
      }
    }
  }
`;

export function generateStargazerOutput({
  repositories,
  excludedRepositories,
  repositoryOwner,
}) {
  if (typeof repositoryOwner !== "string" || repositoryOwner.length === 0) {
    throw new Error("repositoryOwner must be a non-empty string");
  }
  if (!Array.isArray(excludedRepositories)) {
    throw new Error("excludedRepositories must be an array");
  }

  const excluded = new Set(
    excludedRepositories.map((name) => {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error(
          "excludedRepositories must contain non-empty strings",
        );
      }
      return name.toLowerCase();
    }),
  );
  const foldedRepositoryOwner = repositoryOwner.toLowerCase();

  function compareNames(left, right) {
    const foldedLeft = left.toLowerCase();
    const foldedRight = right.toLowerCase();
    if (foldedLeft !== foldedRight) {
      return foldedLeft < foldedRight ? -1 : 1;
    }
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const populatedRepositories = repositories
    .map((repository) => {
      if (typeof repository.name !== "string" || repository.name.length === 0) {
        throw new Error("Repository names must be non-empty strings");
      }
      if (excluded.has(repository.name.toLowerCase())) {
        return null;
      }
      if (
        typeof repository.isArchived !== "boolean" ||
        !Number.isSafeInteger(repository.stargazerCount) ||
        repository.stargazerCount < 0
      ) {
        throw new Error(`${repository.name} has invalid repository metadata`);
      }

      if (!Array.isArray(repository.stargazers)) {
        throw new Error(`${repository.name} must have a stargazers array`);
      }

      const seen = new Set();
      const stargazers = repository.stargazers.map((login) => {
        if (typeof login !== "string" || login.length === 0) {
          throw new Error(
            `${repository.name} has an invalid stargazer username`,
          );
        }
        const foldedLogin = login.toLowerCase();
        if (seen.has(foldedLogin)) {
          throw new Error(`${repository.name} has duplicate stargazer ${login}`);
        }
        if (foldedLogin === foldedRepositoryOwner) {
          throw new Error(
            `${repository.name} is starred by ${repositoryOwner}; add it to STATS_EXCLUDED_REPOS`,
          );
        }
        seen.add(foldedLogin);
        return login;
      });

      return {
        name: repository.name,
        count: repository.isArchived
          ? Math.max(repository.stargazerCount, stargazers.length)
          : stargazers.length,
        stargazers: stargazers.toSorted(compareNames),
        unavailableStargazers: repository.isArchived
          ? Math.max(repository.stargazerCount - stargazers.length, 0)
          : 0,
      };
    })
    .filter(
      (repository) =>
        repository !== null && repository.count > 0,
    )
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareNames(left.name, right.name),
    );

  if (populatedRepositories.length === 0) {
    return "";
  }

  return `${populatedRepositories
    .map(
      (repository) => {
        const entries = repository.stargazers.map((login) => `  ${login}`);
        if (repository.unavailableStargazers > 0) {
          const noun =
            repository.unavailableStargazers === 1 ? "username" : "usernames";
          entries.push(
            `  [${repository.unavailableStargazers} stargazer ${noun} unavailable while archived]`,
          );
        }
        return `${repository.name} (${repository.count})\n${entries.join("\n")}`;
      },
    )
    .join("\n\n")}\n`;
}

async function main() {
  const token = process.env.README_STATS_TOKEN;
  const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER;
  const excludedRepositories = process.env.STATS_EXCLUDED_REPOS;

  if (!token) {
    throw new Error("README_STATS_TOKEN is required");
  }
  if (!repositoryOwner) {
    throw new Error("GITHUB_REPOSITORY_OWNER is required");
  }
  if (excludedRepositories === undefined) {
    throw new Error("STATS_EXCLUDED_REPOS is required");
  }

  const excludedRepositoryNames = excludedRepositories
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const excludedRepositorySet = new Set(
    excludedRepositoryNames.map((name) => name.toLowerCase()),
  );

  async function queryGitHub(query, variables) {
    let response;
    try {
      response = await fetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "adamekka-repository-stargazers",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new Error("Could not reach the GitHub GraphQL API", {
        cause: error,
      });
    }

    let responseText;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new Error("GitHub ended the GraphQL response before it completed", {
        cause: error,
      });
    }

    let payload;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new Error(
        `GitHub returned a non-JSON response with status ${response.status}`,
        { cause: error },
      );
    }

    if (!response.ok || payload.errors) {
      const details = payload.errors?.map((error) => error.message).join("; ");
      throw new Error(
        `GitHub GraphQL request failed with status ${response.status}${details ? `: ${details}` : ""}`,
      );
    }

    return payload.data;
  }

  const repositories = [];
  let repositoryCursor = null;
  let verifiedTokenOwner = false;
  do {
    const data = await queryGitHub(repositoriesQuery, {
      login: repositoryOwner,
      cursor: repositoryCursor,
    });
    if (!data?.user) {
      throw new Error(`GitHub user ${repositoryOwner} was not found`);
    }

    if (!verifiedTokenOwner) {
      const viewerLogin = data.viewer?.login;
      if (typeof viewerLogin !== "string") {
        throw new Error("GitHub did not identify the README_STATS_TOKEN owner");
      }
      if (viewerLogin.toLowerCase() !== repositoryOwner.toLowerCase()) {
        throw new Error(
          `README_STATS_TOKEN belongs to ${viewerLogin}, not ${repositoryOwner}`,
        );
      }
      verifiedTokenOwner = true;
    }

    const page = data.user.repositories;
    if (!Array.isArray(page?.nodes)) {
      throw new Error("GitHub omitted the owned repository list");
    }
    for (const repository of page.nodes) {
      if (repository === null) {
        console.warn("GitHub returned an unavailable repository; skipping it");
        continue;
      }
      if (
        typeof repository.name !== "string" ||
        typeof repository.isArchived !== "boolean" ||
        typeof repository.owner?.login !== "string" ||
        !Number.isSafeInteger(repository.stargazerCount) ||
        repository.stargazerCount < 0
      ) {
        throw new Error("GitHub returned invalid owned repository data");
      }

      // The count only avoids empty API requests; output counts come from fetched users.
      if (repository.stargazerCount > 0) {
        repositories.push({
          name: repository.name,
          isArchived: repository.isArchived,
          owner: repository.owner.login,
          stargazerCount: repository.stargazerCount,
          stargazers: [],
        });
      }
    }

    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error("GitHub omitted the cursor for the next repository page");
    }
    repositoryCursor = page.pageInfo.hasNextPage
      ? page.pageInfo.endCursor
      : null;
  } while (repositoryCursor !== null);

  for (const repository of repositories) {
    if (excludedRepositorySet.has(repository.name.toLowerCase())) {
      continue;
    }

    let stargazerCursor = null;
    do {
      const data = await queryGitHub(stargazersQuery, {
        owner: repository.owner,
        name: repository.name,
        cursor: stargazerCursor,
      });
      if (!data?.repository) {
        throw new Error(
          `GitHub repository ${repository.owner}/${repository.name} was not found`,
        );
      }

      const page = data.repository.stargazers;
      if (!Array.isArray(page?.nodes)) {
        throw new Error(
          `GitHub omitted stargazers for ${repository.owner}/${repository.name}`,
        );
      }
      for (const user of page.nodes) {
        if (user === null) {
          console.warn(
            `GitHub returned an unavailable stargazer for ${repository.owner}/${repository.name}; skipping it`,
          );
          continue;
        }
        if (typeof user.login !== "string") {
          throw new Error(
            `GitHub returned an invalid stargazer for ${repository.owner}/${repository.name}`,
          );
        }
        repository.stargazers.push(user.login);
      }

      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
        throw new Error(
          `GitHub omitted the next stargazer cursor for ${repository.owner}/${repository.name}`,
        );
      }
      stargazerCursor = page.pageInfo.hasNextPage
        ? page.pageInfo.endCursor
        : null;
    } while (stargazerCursor !== null);
  }

  const output = generateStargazerOutput({
    repositories,
    excludedRepositories: excludedRepositoryNames,
    repositoryOwner,
  });
  await mkdir("profile", { recursive: true });
  await writeFile("profile/starred.txt", output, "utf8");
  console.log(
    `Generated stargazer lists for ${repositories.filter((repository) => !excludedRepositorySet.has(repository.name.toLowerCase()) && (repository.isArchived ? repository.stargazerCount : repository.stargazers.length) > 0).length} repositories`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
