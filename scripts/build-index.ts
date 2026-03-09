#!/usr/bin/env bun
/**
 * build-index.ts — Scans npm and GitHub for agentikit-compatible kits,
 * deduplicates, and writes index.json for the static registry.
 *
 * Usage:
 *   bun run scripts/build-index.ts
 *
 * Environment:
 *   GITHUB_TOKEN  — optional, raises rate limit from 10 to 5000 req/hr
 */

import fs from "node:fs"
import path from "node:path"

// ── Types ───────────────────────────────────────────────────────────────────

interface RegistryKitEntry {
  id: string
  name: string
  description?: string
  ref: string
  source: "npm" | "github" | "git"
  homepage?: string
  tags?: string[]
  assetTypes?: string[]
  author?: string
  license?: string
  latestVersion?: string
  /** Whether this entry was manually reviewed and approved via PR */
  curated?: boolean
}

interface RegistryIndex {
  version: 1
  updatedAt: string
  kits: RegistryKitEntry[]
}

// ── Constants ───────────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com"
const NPM_REGISTRY = "https://registry.npmjs.org"
const REQUIRED_KEYWORDS = ["agentikit", "akm"]
const GITHUB_TOPICS = ["agentikit", "akm"]
const OUTPUT_PATH = path.join(import.meta.dir, "..", "index.json")
const MANUAL_ENTRIES_PATH = path.join(import.meta.dir, "..", "manual-entries.json")

/** Repos/packages to exclude from the index (e.g. the agentikit core itself) */
const EXCLUDED_REPOS = new Set([
  "itlackey/agentikit-plugins",
  "itlackey/agentikit",
])

/** npm package names to exclude from the index */
const EXCLUDED_NPM_PACKAGES = new Set([
  "agentikit",
  "agentikit-claude",
  "agentikit-opencode",
  "@anthropic-ai/agentikit",
  "agentikit-plugins",
])

// ── GitHub helpers ──────────────────────────────────────────────────────────

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim()
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agentikit-registry-builder",
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 200)}`)
  }
  return response.json() as Promise<T>
}

// ── GitHub scanner ──────────────────────────────────────────────────────────

interface GithubRepo {
  full_name: string
  name: string
  description: string | null
  html_url: string
  homepage: string | null
  owner: { login: string }
  license: { spdx_id: string } | null
  topics: string[]
  default_branch: string
}

interface GithubSearchResponse {
  total_count: number
  items: GithubRepo[]
}

async function scanGithub(): Promise<RegistryKitEntry[]> {
  const kits: RegistryKitEntry[] = []
  const seen = new Set<string>()
  const headers = githubHeaders()

  for (const topic of GITHUB_TOPICS) {
    let page = 1
    const perPage = 100

    while (true) {
      const q = encodeURIComponent(`topic:${topic}`)
      const url = `${GITHUB_API}/search/repositories?q=${q}&sort=updated&order=desc&per_page=${perPage}&page=${page}`

      console.log(`  GitHub: fetching topic:${topic} page ${page}`)
      let data: GithubSearchResponse
      try {
        data = await fetchJson<GithubSearchResponse>(url, headers)
      } catch (err) {
        console.warn(`  GitHub search failed for topic:${topic} page ${page}:`, (err as Error).message)
        break
      }

      for (const repo of data.items) {
        if (EXCLUDED_REPOS.has(repo.full_name)) {
          console.log(`  Skipping excluded repo ${repo.full_name}`)
          continue
        }
        const id = `github:${repo.full_name}`
        if (seen.has(id)) continue
        seen.add(id)

        const entry = await buildGithubEntry(repo, headers)
        if (entry) kits.push(entry)
      }

      if (data.items.length < perPage) break
      page++
      // Respect GitHub search rate limit (30 req/min)
      await sleep(2000)
    }
  }

  return kits
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
  }

  // Require the "agentikit" topic specifically — "akm" alone matches
  // unrelated projects. Repos with only "akm" must have a package.json
  // containing agentikit/akm keywords to be included.
  const hasAgentikitTopic = repo.topics.some((t) => t === "agentikit")
  let hasAgentikitPackage = false

  // Try to read package.json for richer metadata
  try {
    const pkgUrl = `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/package.json`
    const pkg = await fetchJson<Record<string, unknown>>(pkgUrl)
    if (typeof pkg.version === "string") entry.latestVersion = pkg.version
    if (typeof pkg.description === "string" && !entry.description) {
      entry.description = pkg.description
    }

    // Check if package.json has agentikit-related keywords
    if (Array.isArray(pkg.keywords)) {
      const kwLower = pkg.keywords.map((k: unknown) =>
        typeof k === "string" ? k.toLowerCase() : "",
      )
      hasAgentikitPackage = kwLower.some((k: string) => REQUIRED_KEYWORDS.includes(k))

      const keywords = pkg.keywords.filter(
        (k): k is string => typeof k === "string" && !REQUIRED_KEYWORDS.includes(k.toLowerCase()),
      )
      if (keywords.length > 0) {
        const merged = new Set([...(entry.tags ?? []), ...keywords])
        entry.tags = [...merged]
      }
    }

    // Check for agentikit asset directories
    const assetTypes = extractAssetTypes(pkg)
    if (assetTypes.length > 0) entry.assetTypes = assetTypes
  } catch {
    // No package.json or fetch failed — use repo metadata only
  }

  // Filter: require either the "agentikit" topic or agentikit keywords in package.json
  if (!hasAgentikitTopic && !hasAgentikitPackage) {
    console.log(`  Skipping ${repo.full_name} — no agentikit topic or keywords`)
    return null
  }

  return entry
}

// ── npm scanner ─────────────────────────────────────────────────────────────

interface NpmSearchResult {
  objects: Array<{
    package: {
      name: string
      version: string
      description?: string
      keywords?: string[]
      links?: { homepage?: string; npm?: string; repository?: string }
      author?: { name?: string; username?: string }
      publisher?: { username?: string }
    }
  }>
}

async function scanNpm(): Promise<RegistryKitEntry[]> {
  const kits: RegistryKitEntry[] = []
  const seen = new Set<string>()

  for (const keyword of REQUIRED_KEYWORDS) {
    let offset = 0
    const size = 250

    while (true) {
      const url = `${NPM_REGISTRY}/-/v1/search?text=keywords:${encodeURIComponent(keyword)}&size=${size}&from=${offset}`
      console.log(`  npm: fetching keyword:${keyword} offset ${offset}`)

      let data: NpmSearchResult
      try {
        data = await fetchJson<NpmSearchResult>(url)
      } catch (err) {
        console.warn(`  npm search failed for keyword:${keyword}:`, (err as Error).message)
        break
      }

      for (const obj of data.objects) {
        const pkg = obj.package
        if (EXCLUDED_NPM_PACKAGES.has(pkg.name)) {
          console.log(`  Skipping excluded npm package ${pkg.name}`)
          continue
        }
        // Also exclude if the repository URL matches an excluded repo
        const repoUrl = pkg.links?.repository ?? ""
        if (EXCLUDED_REPOS.has(repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""))) {
          console.log(`  Skipping excluded npm package ${pkg.name} (repo match)`)
          continue
        }
        const id = `npm:${pkg.name}`
        if (seen.has(id)) continue
        seen.add(id)

        const keywords = (pkg.keywords ?? []).map((k) => k.toLowerCase())
        if (!keywords.some((k) => REQUIRED_KEYWORDS.includes(k))) continue

        const authorName =
          pkg.author?.name ?? pkg.author?.username ?? pkg.publisher?.username

        const tags = (pkg.keywords ?? []).filter(
          (k) => !REQUIRED_KEYWORDS.includes(k.toLowerCase()),
        )

        const entry: RegistryKitEntry = {
          id,
          name: pkg.name,
          description: pkg.description,
          ref: pkg.name,
          source: "npm",
          homepage: pkg.links?.homepage ?? pkg.links?.npm,
          author: authorName,
          latestVersion: pkg.version,
          tags: tags.length > 0 ? tags : undefined,
        }

        // Try fetching full package metadata for asset types
        try {
          const pkgData = await fetchJson<Record<string, unknown>>(
            `${NPM_REGISTRY}/${encodeURIComponent(pkg.name)}/latest`,
          )
          const assetTypes = extractAssetTypes(pkgData)
          if (assetTypes.length > 0) entry.assetTypes = assetTypes
          if (typeof pkgData.license === "string") entry.license = pkgData.license
        } catch {
          // Fall back to search metadata only
        }

        kits.push(entry)
      }

      if (data.objects.length < size) break
      offset += size
      await sleep(500)
    }
  }

  return kits
}

// ── Manual entries ──────────────────────────────────────────────────────────

function loadManualEntries(): RegistryKitEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MANUAL_ENTRIES_PATH, "utf8"))
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (e: unknown): e is RegistryKitEntry =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as Record<string, unknown>).id === "string" &&
          typeof (e as Record<string, unknown>).name === "string" &&
          typeof (e as Record<string, unknown>).ref === "string" &&
          typeof (e as Record<string, unknown>).source === "string",
      )
      .map((entry) => ({ ...entry, curated: true }))
  } catch {
    return []
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const KNOWN_ASSET_TYPES = new Set(["tool", "skill", "command", "agent", "knowledge", "script"])

function extractAssetTypes(pkg: Record<string, unknown>): string[] {
  // Check for agentikit.assetTypes field in package.json
  if (typeof pkg.agentikit === "object" && pkg.agentikit !== null) {
    const akm = pkg.agentikit as Record<string, unknown>
    if (Array.isArray(akm.assetTypes)) {
      return akm.assetTypes.filter(
        (t): t is string => typeof t === "string" && KNOWN_ASSET_TYPES.has(t),
      )
    }
  }

  // Check for keywords that match asset types
  if (Array.isArray(pkg.keywords)) {
    const matched = pkg.keywords.filter(
      (k): k is string => typeof k === "string" && KNOWN_ASSET_TYPES.has(k),
    )
    if (matched.length > 0) return matched
  }

  return []
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deduplicateKits(kits: RegistryKitEntry[]): RegistryKitEntry[] {
  const byId = new Map<string, RegistryKitEntry>()
  for (const kit of kits) {
    const existing = byId.get(kit.id)
    if (!existing) {
      byId.set(kit.id, kit)
      continue
    }
    // Merge: prefer the entry with more metadata
    byId.set(kit.id, mergeEntries(existing, kit))
  }
  return [...byId.values()]
}

function mergeEntries(a: RegistryKitEntry, b: RegistryKitEntry): RegistryKitEntry {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? b.description,
    ref: a.ref,
    source: a.source,
    homepage: a.homepage ?? b.homepage,
    tags: mergeTags(a.tags, b.tags),
    assetTypes: a.assetTypes ?? b.assetTypes,
    author: a.author ?? b.author,
    license: a.license ?? b.license,
    latestVersion: a.latestVersion ?? b.latestVersion,
    curated: a.curated || b.curated || undefined,
  }
}

function mergeTags(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined
  const merged = new Set([...(a ?? []), ...(b ?? [])])
  return merged.size > 0 ? [...merged] : undefined
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Building agentikit registry index...")
  console.log()

  console.log("Scanning npm...")
  const npmKits = await scanNpm()
  console.log(`  Found ${npmKits.length} npm packages`)
  console.log()

  console.log("Scanning GitHub...")
  const githubKits = await scanGithub()
  console.log(`  Found ${githubKits.length} GitHub repos`)
  console.log()

  console.log("Loading manual entries...")
  const manualKits = loadManualEntries()
  console.log(`  Found ${manualKits.length} manual entries`)
  console.log()

  // Manual entries take priority (listed first so they win dedup)
  const allKits = deduplicateKits([...manualKits, ...npmKits, ...githubKits])

  // Sort by name for stable diffs
  allKits.sort((a, b) => a.name.localeCompare(b.name))

  const index: RegistryIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    kits: allKits,
  }

  const output = JSON.stringify(index, null, 2) + "\n"
  fs.writeFileSync(OUTPUT_PATH, output, "utf8")

  console.log(`Wrote ${allKits.length} kits to ${OUTPUT_PATH}`)
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
