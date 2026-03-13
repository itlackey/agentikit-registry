# akm Registry

Static registry index for [akm](https://github.com/itlackey/agentikit) kit discovery.
The CLI ships with this registry pre-configured and uses it for `akm registry search`
and `akm search --source registry`.

## How it works

This repo publishes a static `index.json` file. The akm CLI fetches and caches
that file locally, then searches it for matching kits. The index is built here by
a pinned `akm-cli` install via `akm registry build-index`. Current CLI builds support:

- Registry index `version: 2`
- Auto-discovered kits from npm and GitHub
- Curated manual entries that can override or enrich discovered metadata
- Optional asset-level metadata via each kit's `assets` array
- Multiple configured registries via the `registries` config field

The build merges three sources:

- npm packages with `agentikit` or `akm-kit` keywords
- GitHub repos with `agentikit` or `akm-kit` topics
- `manual-entries.json` for curated additions and overrides

## Getting listed

There are three ways to get listed:

- Publish an npm package with `agentikit` or `akm-kit` in `keywords`
- Add the `agentikit` or `akm-kit` GitHub topic to your repository
- Open a PR updating `manual-entries.json` for curated additions or overrides

Manual entry example:

```json
{
  "id": "github:your-org/your-kit",
  "name": "Your Kit Name",
  "description": "One-line description of what the kit provides",
  "ref": "your-org/your-kit",
  "source": "github",
  "homepage": "https://github.com/your-org/your-kit",
  "tags": ["deploy", "review"],
  "assetTypes": ["script", "skill"],
  "author": "your-name",
  "license": "MIT"
}
```

Required fields: `id`, `name`, `ref`, `source`.

Supported `assetTypes` values match the CLI's current asset model:
`script`, `skill`, `command`, `agent`, `knowledge`.

## Index format

```json
{
  "version": 2,
  "updatedAt": "2026-03-12T00:00:00Z",
  "kits": [
    {
      "id": "github:your-org/deploy-kit",
      "name": "deploy-kit",
      "description": "Deployment scripts and skills",
      "ref": "your-org/deploy-kit",
      "source": "github",
      "tags": ["deploy", "infrastructure"],
      "assetTypes": ["script", "skill"],
      "assets": [
        {
          "type": "script",
          "name": "deploy.sh",
          "description": "Deploy to production"
        }
      ],
      "author": "your-org",
      "curated": true
    }
  ]
}
```

The schema lives at `scripts/registry-index.schema.json`.

The local wrapper lives at `scripts/build-index.ts`, and the pinned CLI install
is managed by `scripts/install-akm.ts` using `bun add --exact --no-save`.

## Configuring akm

akm uses this registry by default. You can add or override registries with:

```bash
akm registry list
akm registry add https://your-company.com/registry/index.json --name team
export AKM_REGISTRY_URL=https://your-company.com/registry/index.json
```

In config, registries live under the `registries` array.

## Local development

```bash
bun run install:akm
bun run build
bun run validate
```

The current pin is `akm-cli@0.0.22`, chosen as the next patch after
`../agentikit/package.json`'s `0.0.21` while the CLI release for
`akm registry build-index` is still in flight.
