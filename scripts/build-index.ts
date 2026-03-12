#!/usr/bin/env bun
/**
 * Build script for generating the akm registry index (v2).
 *
 * Scans npm and GitHub for akm-compatible kits, merges in curated manual
 * entries, deduplicates by id, and writes a v2 `index.json`.
 *
 * Usage:
 *   bun run scripts/build-index.ts
 *   bun run scripts/build-index.ts --out index.json
 *
 * Environment:
 *   GITHUB_TOKEN  Optional, raises GitHub API rate limits
 */

import fs from "node:fs";
import path from "node:path";

interface ManualAsset {
  type: string;
  name: string;
  description?: string;
  tags?: string[];
}

interface RegistryKitEntry {
  id: string;
  name: string;
  description?: string;
  ref: string;
  source: "npm" | "github" | "git" | "local";
  homepage?: string;
  tags?: string[];
  assetTypes?: string[];
  assets?: ManualAsset[];
  author?: string;
  license?: string;
  latestVersion?: string;
  curated?: boolean;
}

interface RegistryIndex {
  version: 2;
  updatedAt: string;
  kits: RegistryKitEntry[];
}

const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
const REQUIRED_KEYWORDS = ["agentikit", "akm-kit"];
const GITHUB_TOPICS = ["agentikit", "akm-kit"];
const OUTPUT_PATH = path.join(import.meta.dir, "..", "index.json");
const MANUAL_ENTRIES_PATH = path.join(import.meta.dir, "..", "manual-entries.json");

const EXCLUDED_REPOS = new Set(["itlackey/agentikit-plugins", "itlackey/agentikit"]);
const EXCLUDED_NPM_PACKAGES = new Set([
  "agentikit",
  "agentikit-claude",
  "agentikit-opencode",
  "agentikit-plugins",
  "akm-cli",
  "akm-opencode",
]);

const KNOWN_ASSET_TYPES = new Set(["script", "skill", "command", "agent", "knowledge"]);

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "akm-registry-builder",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

interface GithubRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  owner: { login: string };
  license: { spdx_id: string } | null;
  topics: string[];
  default_branch: string;
}

interface GithubSearchResponse {
  items: GithubRepo[];
}

async function scanGithub(): Promise<RegistryKitEntry[]> {
  const kits: RegistryKitEntry[] = [];
  const seen = new Set<string>();
  const headers = githubHeaders();

  for (const topic of GITHUB_TOPICS) {
    let page = 1;
    const perPage = 100;

    while (true) {
      const q = encodeURIComponent(`topic:${topic}`);
      const url = `${GITHUB_API}/search/repositories?q=${q}&sort=updated&order=desc&per_page=${perPage}&page=${page}`;

      console.log(`  GitHub: fetching topic:${topic} page ${page}`);
      let data: GithubSearchResponse;
      try {
        data = await fetchJson<GithubSearchResponse>(url, headers);
      } catch (err) {
        console.warn(`  GitHub search failed for topic:${topic} page ${page}:`, (err as Error).message);
        break;
      }

      for (const repo of data.items) {
        if (EXCLUDED_REPOS.has(repo.full_name)) continue;
        const id = `github:${repo.full_name}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const entry = await buildGithubEntry(repo, headers);
        if (entry) kits.push(entry);
      }

      if (data.items.length < perPage) break;
      page++;
      await sleep(2000);
    }
  }

  return kits;
}

async function buildGithubEntry(
  repo: GithubRepo,
  headers: Record<string, string>,
): Promise<RegistryKitEntry | null> {
  const entry: RegistryKitEntry = {
    id: `github:${repo.full_name}`,
    name: repo.name,
    description: repo.description ?? undefined,
    ref: repo.full_name,
    source: "github",
    homepage: repo.html_url,
    author: repo.owner.login,
    license: repo.license?.spdx_id ?? undefined,
    tags: repo.topics.filter((t) => !GITHUB_TOPICS.includes(t)),
  };

  const hasAgentikitTopic = repo.topics.some((t) => t === "agentikit");
  let hasAgentikitPackage = false;

  try {
    const pkgUrl = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/package.json`;
    const pkg = await fetchJson<Record<string, unknown>>(pkgUrl);

    if (typeof pkg.version === "string") entry.latestVersion = pkg.version;
    if (typeof pkg.description === "string" && !entry.description) entry.description = pkg.description;

    if (Array.isArray(pkg.keywords)) {
      const kwLower = pkg.keywords.map((k) => (typeof k === "string" ? k.toLowerCase() : ""));
      hasAgentikitPackage = kwLower.some((k) => REQUIRED_KEYWORDS.includes(k));

      const keywords = pkg.keywords.filter(
        (k): k is string => typeof k === "string" && !REQUIRED_KEYWORDS.includes(k.toLowerCase()),
      );
      if (keywords.length > 0) {
        entry.tags = [...new Set([...(entry.tags ?? []), ...keywords])];
      }
    }

    const assetTypes = extractAssetTypes(pkg);
    if (assetTypes.length > 0) entry.assetTypes = assetTypes;
  } catch {
    // Ignore package.json fetch failures.
  }

  if (!hasAgentikitTopic && !hasAgentikitPackage) return null;
  return entry;
}

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      links?: { homepage?: string; npm?: string; repository?: string };
      author?: { name?: string; username?: string };
      publisher?: { username?: string };
    };
  }>;
}

async function scanNpm(): Promise<RegistryKitEntry[]> {
  const kits: RegistryKitEntry[] = [];
  const seen = new Set<string>();

  for (const keyword of REQUIRED_KEYWORDS) {
    let offset = 0;
    const size = 250;

    while (true) {
      const url = `${NPM_REGISTRY}/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=${size}&from=${offset}`;
      console.log(`  npm: fetching keyword:${keyword} offset ${offset}`);

      let data: NpmSearchResult;
      try {
        data = await fetchJson<NpmSearchResult>(url);
      } catch (err) {
        console.warn(`  npm search failed for keyword:${keyword}:`, (err as Error).message);
        break;
      }

      for (const obj of data.objects) {
        const pkg = obj.package;
        if (EXCLUDED_NPM_PACKAGES.has(pkg.name)) continue;

        const repoUrl = pkg.links?.repository ?? "";
        const normalizedRepo = repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
        if (EXCLUDED_REPOS.has(normalizedRepo)) continue;

        const id = `npm:${pkg.name}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const keywords = (pkg.keywords ?? []).map((k) => k.toLowerCase());
        if (!keywords.some((k) => REQUIRED_KEYWORDS.includes(k))) continue;

        const entry: RegistryKitEntry = {
          id,
          name: pkg.name,
          description: pkg.description,
          ref: pkg.name,
          source: "npm",
          homepage: pkg.links?.homepage ?? pkg.links?.npm,
          author: pkg.author?.name ?? pkg.author?.username ?? pkg.publisher?.username,
          latestVersion: pkg.version,
          tags: (pkg.keywords ?? []).filter((k) => !REQUIRED_KEYWORDS.includes(k.toLowerCase())),
        };

        try {
          const pkgData = await fetchJson<Record<string, unknown>>(`${NPM_REGISTRY}/${encodeURIComponent(pkg.name)}/latest`);
          const assetTypes = extractAssetTypes(pkgData);
          if (assetTypes.length > 0) entry.assetTypes = assetTypes;
          if (typeof pkgData.license === "string") entry.license = pkgData.license;
        } catch {
          // Fall back to search metadata only.
        }

        if (!entry.tags?.length) delete entry.tags;
        kits.push(entry);
      }

      if (data.objects.length < size) break;
      offset += size;
      await sleep(500);
    }
  }

  return kits;
}

function loadManualEntries(): RegistryKitEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MANUAL_ENTRIES_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry: unknown): entry is RegistryKitEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).id === "string" &&
          typeof (entry as Record<string, unknown>).name === "string" &&
          typeof (entry as Record<string, unknown>).ref === "string" &&
          typeof (entry as Record<string, unknown>).source === "string",
      )
      .map((entry) => ({ ...entry, curated: entry.curated ?? true }));
  } catch {
    return [];
  }
}

function extractAssetTypes(pkg: Record<string, unknown>): string[] {
  const fields = [pkg.akm, pkg.agentikit];
  for (const field of fields) {
    if (typeof field !== "object" || field === null) continue;
    const config = field as Record<string, unknown>;
    if (Array.isArray(config.assetTypes)) {
      const types = config.assetTypes.filter(
        (type): type is string => typeof type === "string" && KNOWN_ASSET_TYPES.has(type),
      );
      if (types.length > 0) return types;
    }
  }

  if (Array.isArray(pkg.keywords)) {
    const matched = pkg.keywords.filter(
      (keyword): keyword is string => typeof keyword === "string" && KNOWN_ASSET_TYPES.has(keyword),
    );
    if (matched.length > 0) return [...new Set(matched)];
  }

  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deduplicateKits(kits: RegistryKitEntry[]): RegistryKitEntry[] {
  const byId = new Map<string, RegistryKitEntry>();
  for (const kit of kits) {
    const existing = byId.get(kit.id);
    if (!existing) {
      byId.set(kit.id, kit);
      continue;
    }
    byId.set(kit.id, mergeEntries(existing, kit));
  }
  return [...byId.values()];
}

function mergeEntries(a: RegistryKitEntry, b: RegistryKitEntry): RegistryKitEntry {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? b.description,
    ref: a.ref,
    source: a.source,
    homepage: a.homepage ?? b.homepage,
    tags: mergeStrings(a.tags, b.tags),
    assetTypes: mergeStrings(a.assetTypes, b.assetTypes),
    assets: a.assets ?? b.assets,
    author: a.author ?? b.author,
    license: a.license ?? b.license,
    latestVersion: a.latestVersion ?? b.latestVersion,
    curated: a.curated || b.curated || undefined,
  };
}

function mergeStrings(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined;
  const values = [...new Set([...(a ?? []), ...(b ?? [])])];
  return values.length > 0 ? values : undefined;
}

async function main() {
  console.log("Building akm registry index...");
  console.log();

  console.log("Scanning npm...");
  const npmKits = await scanNpm();
  console.log(`  Found ${npmKits.length} npm packages`);
  console.log();

  console.log("Scanning GitHub...");
  const githubKits = await scanGithub();
  console.log(`  Found ${githubKits.length} GitHub repos`);
  console.log();

  console.log("Loading manual entries...");
  const manualKits = loadManualEntries();
  console.log(`  Found ${manualKits.length} manual entries`);
  console.log();

  const allKits = deduplicateKits([...manualKits, ...npmKits, ...githubKits]);
  allKits.sort((a, b) => a.name.localeCompare(b.name));

  const index: RegistryIndex = {
    version: 2,
    updatedAt: new Date().toISOString(),
    kits: allKits,
  };

  const json = JSON.stringify(index, null, 2);
  const outFlag = process.argv.indexOf("--out");

  if (outFlag !== -1 && process.argv[outFlag + 1]) {
    const outPath = path.resolve(process.argv[outFlag + 1]);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${json}\n`, "utf8");
    console.error(`Wrote ${index.kits.length} kits to ${outPath}`);
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, `${json}\n`, "utf8");
  console.log(`Wrote ${index.kits.length} kits to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
