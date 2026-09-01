#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const LANGUAGE_LIMIT = 20;

const repositoriesQuery = `
  query LanguageRepositories($login: String!, $cursor: String) {
    viewer {
      login
    }
    user(login: $login) {
      repositories(
        ownerAffiliations: OWNER
        isFork: false
        first: 100
        after: $cursor
        orderBy: { field: NAME, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
            pageInfo {
              hasNextPage
            }
            edges {
              size
              node {
                color
                name
              }
            }
          }
        }
      }
    }
  }
`;

export function generateLanguageOutputs({
  repositories,
  excludedRepositories,
  languageLimit,
}) {
  if (!Number.isInteger(languageLimit) || languageLimit < 1) {
    throw new Error("languageLimit must be a positive integer");
  }

  const excluded = new Set(excludedRepositories);
  const languageMap = new Map();

  for (const repository of repositories) {
    if (excluded.has(repository.name)) {
      continue;
    }

    for (const edge of repository.languages.edges) {
      if (!Number.isSafeInteger(edge.size) || edge.size <= 0) {
        throw new Error(
          `GitHub returned an invalid byte count for ${repository.name}/${edge.node.name}`,
        );
      }

      let language = languageMap.get(edge.node.name);
      if (!language) {
        language = {
          name: edge.node.name,
          color: /^#[0-9a-f]{6}$/i.test(edge.node.color ?? "")
            ? edge.node.color
            : "#858585",
          bytes: 0,
          projects: [],
        };
        languageMap.set(edge.node.name, language);
      }

      language.bytes += edge.size;
      language.projects.push({ name: repository.name, bytes: edge.size });
    }
  }

  function compareNames(left, right) {
    const foldedLeft = left.toLowerCase();
    const foldedRight = right.toLowerCase();
    if (foldedLeft !== foldedRight) {
      return foldedLeft < foldedRight ? -1 : 1;
    }
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const allLanguages = [...languageMap.values()].sort(
    (left, right) =>
      right.bytes - left.bytes || compareNames(left.name, right.name),
  );
  const languages = allLanguages.slice(0, languageLimit);

  if (allLanguages.length === 0) {
    throw new Error("GitHub returned no language data for included repositories");
  }

  const totalBytes = languages.reduce(
    (sum, language) => sum + language.bytes,
    0,
  );
  const allLanguageBytes = allLanguages.reduce(
    (sum, language) => sum + language.bytes,
    0,
  );

  function formatPercentage(bytes, denominator) {
    return `${((bytes / denominator) * 100).toFixed(2)}%`;
  }

  const text = `${allLanguages
    .map((language) => {
      const projects = language.projects
        .toSorted(
          (left, right) =>
            right.bytes - left.bytes || compareNames(left.name, right.name),
        )
        .map(
          (project) =>
            `  ${project.name} ${formatPercentage(project.bytes, allLanguageBytes)}`,
        )
        .join("\n");
      return `${language.name} ${formatPercentage(language.bytes, allLanguageBytes)}\n${projects}`;
    })
    .join("\n\n")}\n`;

  function escapeXml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  const width = 300;
  const height = 45 + (languages.length + 1) * 40;
  const progressWidth = 205;
  const rows = languages
    .map((language, index) => {
      const percentage = (language.bytes / totalBytes) * 100;
      return `
        <g transform="translate(0, ${index * 40})">
          <text data-testid="lang-name" x="2" y="15" class="lang-name">${escapeXml(language.name)}</text>
          <text x="215" y="34" class="lang-name">${percentage.toFixed(2)}%</text>
          <svg width="${progressWidth}" x="0" y="25">
            <rect data-testid="progress-background" rx="5" ry="5" width="${progressWidth}" height="8" fill="#ddd" />
            <svg data-testid="lang-progress" width="${percentage}%">
              <rect rx="5" ry="5" width="${progressWidth}" height="8" fill="${escapeXml(language.color)}" />
            </svg>
          </svg>
        </g>`;
    })
    .join("");

  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="titleId descId">
  <title id="titleId">Most Used Languages</title>
  <desc id="descId">Most used languages across all included repositories</desc>
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: #81a1c1; }
    .lang-name { font: 400 11px 'Segoe UI', Ubuntu, Sans-Serif; fill: #d8dee9; }
  </style>
  <rect data-testid="card-bg" x="0.5" y="0.5" rx="4.5" height="${height - 1}" stroke="#e4e2e2" width="299" fill="#2e3440" />
  <g data-testid="card-title" transform="translate(25, 35)">
    <text class="header" data-testid="header">Most Used Languages</text>
  </g>
  <g data-testid="main-card-body" transform="translate(0, 55)">
    <svg data-testid="lang-items" x="25">${rows}
    </svg>
  </g>
</svg>
`;

  return { languages, svg, text };
}

async function main() {
  const token = process.env.README_STATS_TOKEN;
  const repositoryOwner = process.env.GITHUB_REPOSITORY_OWNER;
  const excludedRepositories = process.env.TOP_LANGS_EXCLUDED_REPOS;

  if (!token) {
    throw new Error("README_STATS_TOKEN is required");
  }
  if (!repositoryOwner) {
    throw new Error("GITHUB_REPOSITORY_OWNER is required");
  }
  if (excludedRepositories === undefined) {
    throw new Error("TOP_LANGS_EXCLUDED_REPOS is required");
  }

  const excludedRepositoryNames = excludedRepositories
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const excludedRepositorySet = new Set(excludedRepositoryNames);

  async function queryGitHub(cursor) {
    let response;
    try {
      response = await fetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "adamekka-language-stats",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          query: repositoriesQuery,
          variables: { login: repositoryOwner, cursor },
        }),
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
    if (!payload.data?.user) {
      throw new Error(`GitHub user ${repositoryOwner} was not found`);
    }
    const viewerLogin = payload.data?.viewer?.login;
    if (typeof viewerLogin !== "string") {
      throw new Error("GitHub did not identify the README_STATS_TOKEN owner");
    }
    if (viewerLogin.toLowerCase() !== repositoryOwner.toLowerCase()) {
      throw new Error(
        `README_STATS_TOKEN belongs to ${viewerLogin}, not ${repositoryOwner}`,
      );
    }

    return payload.data.user.repositories;
  }

  const repositories = [];
  let cursor = null;
  do {
    const page = await queryGitHub(cursor);
    for (const repository of page.nodes) {
      if (
        !excludedRepositorySet.has(repository.name) &&
        repository.languages.pageInfo.hasNextPage
      ) {
        throw new Error(
          `${repository.name} has more than 100 detected languages; refusing to generate partial stats`,
        );
      }
      repositories.push(repository);
    }

    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error("GitHub omitted the cursor for the next repository page");
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor !== null);

  const { svg, text } = generateLanguageOutputs({
    repositories,
    excludedRepositories: excludedRepositoryNames,
    languageLimit: LANGUAGE_LIMIT,
  });

  await mkdir("profile", { recursive: true });
  await Promise.all([
    writeFile("profile/top-langs.svg", svg, "utf8"),
    writeFile("profile/languages.txt", text, "utf8"),
  ]);
  console.log(
    `Generated language stats from ${repositories.length} repositories`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
