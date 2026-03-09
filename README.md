# Agent-i-Kit Registry

Static registry index for [agentikit](https://github.com/itlackey/agentikit) kit discovery. Powers `akm search --source registry` by providing a single JSON file that lists all known kits.

## How it works

The `index.json` file is a static list of kits hosted on GitHub raw. The Agent-i-Kit CLI fetches and caches it locally (1-hour TTL) instead of querying npm and GitHub APIs at search time. This means faster searches, no rate limits, and offline support with a cached index.

A GitHub Actions workflow rebuilds the index every 6 hours by scanning:

- **npm** for packages with `agentikit` or `akm` keywords
- **GitHub** for repos with the `agentikit` topic
- **manual-entries.json** for curated entries that should always be included

Results are deduplicated, validated, and committed as `index.json`.

## Getting your kit listed

There are three ways to get your kit into the registry.

### Option 1: npm keyword (automatic)

Add `agentikit` to your `package.json` keywords:

```json
{
  "keywords": ["agentikit", "your-other-keywords"]
}
```

Publish to npm and the next index rebuild will pick it up.

### Option 2: GitHub topic (automatic)

Add the `agentikit` topic to your GitHub repository (Settings > Topics). The scanner will find it on the next rebuild.

For richer metadata, include a `package.json` at the repo root with `keywords`, `description`, and optionally an `agentikit` field:

```json
{
  "agentikit": {
    "assetTypes": ["skill", "command", "knowledge"]
  }
}
```

### Option 3: Manual entry (PR)

For kits that aren't on npm or don't use the GitHub topic, open a pull request adding your kit to `manual-entries.json`:

```json
{
  "id": "github:your-org/your-kit",
  "name": "Your Kit Name",
  "description": "One-line description of what the kit provides",
  "ref": "your-org/your-kit",
  "source": "github",
  "homepage": "https://github.com/your-org/your-kit",
  "tags": ["relevant", "searchable", "keywords"],
  "assetTypes": ["skill", "tool"],
  "author": "your-name",
  "license": "MIT"
}
```

Required fields: `id`, `name`, `ref`, `source`. Everything else is optional but improves search ranking.

## Index format

```json
{
  "version": 1,
  "updatedAt": "2026-03-09T00:00:00Z",
  "kits": [
    {
      "id": "github:itlackey/dimm-city-kit",
      "name": "Dimm City TTRPG Kit",
      "description": "Agent skills for creaturepunk TTRPG content",
      "ref": "itlackey/dimm-city-kit",
      "source": "github",
      "tags": ["ttrpg", "creaturepunk"],
      "assetTypes": ["skill", "command", "knowledge"],
      "author": "itlackey"
    }
  ]
}
```

The `ref` field is what you'd pass to `akm add`. The full schema is in `registry-index.schema.json`.

## Configuring the CLI

The Agent-i-Kit CLI uses this registry by default. You can override the URL:

```bash
# Environment variable (comma-separated for multiple)
export AKM_REGISTRY_URL=https://your-company.com/registry/index.json

# Config file
akm config --set 'registryUrls=["https://your-company.com/registry/index.json"]'
```

## Local development

```bash
bun install
bun run build     # rebuild index.json from npm + GitHub + manual entries
bun run validate  # check index.json structure
```

Set `GITHUB_TOKEN` to avoid rate limits when running the build script locally.
