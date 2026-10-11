// Builds assets/stats.svg and assets/languages.svg from the GitHub API.
// Uses a token that can see private/org work, so the numbers match the profile
// contribution graph instead of public-only stats.
//
//   GH_STATS_TOKEN=<token> node scripts/generate-stats.mjs

import { writeFile } from "node:fs/promises";

const LOGIN = process.env.GH_LOGIN || "zh10only1";
const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GH_STATS_TOKEN is not set");

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": `${LOGIN}-profile-stats`,
};

async function rest(path) {
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function graphql(query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors || body));
  return body.data;
}

const searchCount = async (kind, q) =>
  (await rest(`search/${kind}?per_page=1&q=${encodeURIComponent(q)}`)).total_count;

// ---- data -------------------------------------------------------------------

const { user } = await graphql(`{
  user(login: "${LOGIN}") {
    createdAt
    contributionsCollection { contributionCalendar { totalContributions } }
    repositoriesContributedTo(first: 100, includeUserRepositories: true,
      contributionTypes: [COMMIT, PULL_REQUEST, REPOSITORY]) {
      totalCount
      nodes {
        isFork
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
      }
    }
  }
}`);

// contributionsCollection spans at most one year, so sum calendar years.
const firstYear = new Date(user.createdAt).getUTCFullYear();
const thisYear = new Date().getUTCFullYear();
const yearFields = [];
for (let y = firstYear; y <= thisYear; y++) {
  yearFields.push(`y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
    contributionCalendar { totalContributions } }`);
}
const years = (await graphql(`{ user(login: "${LOGIN}") { ${yearFields.join("\n")} } }`)).user;
const allTime = Object.values(years).reduce((n, y) => n + y.contributionCalendar.totalContributions, 0);

const [commits, prs, merged] = await Promise.all([
  searchCount("commits", `author:${LOGIN}`),
  searchCount("issues", `author:${LOGIN} type:pr`),
  searchCount("issues", `author:${LOGIN} type:pr is:merged`),
]);

const IGNORED_LANGS = new Set(["HTML", "CSS", "SCSS", "Dockerfile", "Shell", "Makefile", "Procfile", "Batchfile", "PowerShell", "Bicep", "Jupyter Notebook"]);
const langTotals = new Map();
for (const repo of user.repositoriesContributedTo.nodes) {
  if (repo.isFork) continue;
  // Each repo counts equally, so one very large repo can't drown out the rest.
  const edges = repo.languages.edges.filter((e) => !IGNORED_LANGS.has(e.node.name));
  const repoSize = edges.reduce((n, e) => n + e.size, 0);
  if (!repoSize) continue;
  for (const { size, node } of edges) {
    const cur = langTotals.get(node.name) || { size: 0, color: node.color || "#A6ADC8" };
    cur.size += size / repoSize;
    langTotals.set(node.name, cur);
  }
}
const langSum = [...langTotals.values()].reduce((n, l) => n + l.size, 0) || 1;
const languages = [...langTotals.entries()]
  .map(([name, l]) => ({ name, color: l.color, pct: (l.size / langSum) * 100 }))
  .filter((l) => l.pct >= 0.5)
  .sort((a, b) => b.pct - a.pct)
  .slice(0, 6);

const stats = {
  lastYear: user.contributionsCollection.contributionCalendar.totalContributions,
  allTime,
  commits,
  prs,
  merged,
  repos: user.repositoriesContributedTo.totalCount,
  since: firstYear,
};
console.log(JSON.stringify({ stats, languages }, null, 2));

// ---- render -----------------------------------------------------------------

const W = 495;
const H = 210;
const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const today = new Date().toISOString().slice(0, 10);

const frame = (title, body) => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <style>
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .muted { fill: #A6ADC8; } .dim { fill: #6C7086; } .text { fill: #CDD6F4; }
    .blue { fill: #89B4FA; } .mauve { fill: #CBA6F7; } .green { fill: #A6E3A1; }
    .teal { fill: #94E2D5; } .peach { fill: #FAB387; } .yellow { fill: #F9E2AF; }
  </style>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="10" fill="#0B0F14" stroke="#313244" stroke-width="2"/>
  <circle cx="22" cy="22" r="5" fill="#F38BA8"/>
  <circle cx="38" cy="22" r="5" fill="#F9E2AF"/>
  <circle cx="54" cy="22" r="5" fill="#A6E3A1"/>
  <text x="74" y="27" class="mono muted" font-size="13">${esc(title)}</text>
  <line x1="1" y1="40" x2="${W - 1}" y2="40" stroke="#313244" stroke-width="1"/>
${body}
  <text x="${W - 18}" y="${H - 14}" text-anchor="end" class="mono dim" font-size="11">updated ${today} · incl. private work</text>
</svg>
`;

const rows = [
  ["contributions (last year)", fmt(stats.lastYear), "green"],
  [`contributions (since ${stats.since})`, fmt(stats.allTime), "teal"],
  ["commits", fmt(stats.commits), "blue"],
  ["pull requests", `${fmt(stats.prs)}  (${fmt(stats.merged)} merged)`, "mauve"],
  ["repos contributed to", fmt(stats.repos), "peach"],
];
const statsBody = rows
  .map(([label, value, color], i) => {
    const y = 68 + i * 24;
    return `  <text x="22" y="${y}" class="mono muted" font-size="14"><tspan class="${color}">›</tspan> ${esc(label)}</text>
  <text x="${W - 22}" y="${y}" text-anchor="end" class="mono text" font-size="14" font-weight="700">${esc(value)}</text>`;
  })
  .join("\n");

// One stacked bar, then a two-column legend.
const barX = 22;
const barW = W - 44;
let cursor = barX;
const segments = languages
  .map((l) => {
    const w = (l.pct / 100) * barW;
    const seg = `<rect x="${cursor.toFixed(2)}" y="58" width="${w.toFixed(2)}" height="10" fill="${l.color}"/>`;
    cursor += w;
    return seg;
  })
  .join("");
const legend = languages
  .map((l, i) => {
    const x = i % 2 === 0 ? 22 : 22 + barW / 2 + 6;
    const y = 96 + Math.floor(i / 2) * 26;
    return `  <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>
  <text x="${x + 18}" y="${y}" class="mono text" font-size="14">${esc(l.name)} <tspan class="muted">${l.pct.toFixed(1)}%</tspan></text>`;
  })
  .join("\n");
const langBody = `  <clipPath id="bar"><rect x="${barX}" y="58" width="${barW}" height="10" rx="5"/></clipPath>
  <rect x="${barX}" y="58" width="${barW}" height="10" rx="5" fill="#313244"/>
  <g clip-path="url(#bar)">${segments}</g>
${legend}`;

await writeFile(new URL("../assets/stats.svg", import.meta.url), frame("~/stats  github --all", statsBody));
await writeFile(new URL("../assets/languages.svg", import.meta.url), frame("~/stats  languages --top", langBody));
