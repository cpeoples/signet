# Signet

Signet lists every Apple firmware, whether Apple still signs it, and where to download it, using only Apple's own servers.

It reads Apple's firmware feeds, inspects each IPSW with HTTP range requests (no full downloads), and asks Apple's TSS server (`gs.apple.com`) whether each build can still be restored. The output is one JSON report, which is also the data source for a static website.

## Contents

| Part | What it does |
|---|---|
| `signet` CLI (`src/`) | Builds the report: devices, IPSWs, signing status, release and expiry dates, OTA packages with their decryption keys, specs. |
| `signet serve` | Runs the same pipeline as an in-memory HTTP service: `/health`, `/api/site`, `/api/signing`, `/api/report`. |
| `signet decrypt` | Decrypts encrypted OTA packages (`.aea`) on macOS, Linux or Windows, using `@chrispeoples/aea`. |
| `@chrispeoples/aea` (`packages/aea`) | Standalone `.aea` decryptor and Apple Archive (`.aar`) extractor, with a `signet-aea` CLI. An npm workspace that `signet` depends on. |
| Website (`site/`) | Hugo site generated from `signet-report.json`. |

## Requirements

- Node.js 24.5 or later (`@chrispeoples/aea` on its own needs only Node.js 22)
- [Hugo](https://gohugo.io/installation/) extended 0.161 or later, for the website
- Git, to fetch the theme submodule

## Quick start

```bash
git clone --recurse-submodules <repo-url> signet
cd signet
npm install

npm run json        # build the CLI, write signet-report.json and signet-history.json
npm run site:dev    # preview the site at http://localhost:1313/signet/
```

If you cloned without `--recurse-submodules`, run `git submodule update --init` to fetch the theme.

## npm scripts

| Script | What it runs |
|---|---|
| `npm run build` | Builds `packages/aea`, then `tsc` compiles `src/` into `dist/` |
| `npm test` | The `@chrispeoples/aea` test suite |
| `npm start -- <flags>` | `node dist/cli.js <flags>` |
| `npm run json` | Builds, then `node dist/cli.js --json --history signet-history.json > signet-report.json` |
| `npm run site:data` | Same as `npm run json` |
| `npm run site:dev` | Runs `npm run json` if `signet-report.json` is missing, then `hugo server -s site` |
| `npm run site:build` | Fresh report, then a minified site in `site/public/` |
| `npm run site:render` | Minified site from the existing report |

## CLI

Build once with `npm run build`, then:

```bash
node dist/cli.js                                  # every IPSW in Apple's feeds, grouped by signing state
node dist/cli.js --list-devices                   # one row per device: name, latest build, signing state
node dist/cli.js --feed ios --device iPhone16,2   # one feed, one device
node dist/cli.js --url <IPSW URL>                 # check a specific IPSW
node dist/cli.js --json --history signet-history.json > signet-report.json
```

Main options:

| Flag | Effect |
|---|---|
| `--feed NAME` | `ios`, `macos`, `visionos`, `bridgeos` (or any feed in the config), `appledb`, `ota`, or `all` (default) |
| `--device SUBSTR` | Only devices whose identifier contains `SUBSTR` |
| `--url URL` | Check specific IPSW URLs (repeatable) |
| `--list-devices` | One row per device instead of one per IPSW |
| `--json` | JSON output |
| `--history FILE` | Record signing observations across runs (see below) |
| `--jobs N` | Parallel IPSW checks (default from the config) |
| `--names FILE` | JSON map of identifiers to names, for devices whose firmware can't be read for names |
| `--no-names`, `--no-tss` | Skip DeviceTree name lookup; skip signing checks (`--list-devices` only) |
| `--no-dates` | Skip release and expiry dates from `gdmf.apple.com` |
| `--no-appledb`, `--no-ota`, `--no-ota-assets` | Skip AppleDB URL discovery, Apple's OTA full updates, or the per-device OTA package list |
| `--tech-specs`, `--no-tech-specs` | Force Apple Tech Specs lookup on or off |
| `--no-chip-images` | Skip chip photos |
| `--config FILE`, `--print-config` | Use another config file; print the effective config and exit |

Run `node dist/cli.js --help` for the full list. Endpoints and tuning settings are in `signet.config.json`; `user_agent` is sent to every server except `gs.apple.com`, which gets `tss_user_agent`.

### Signing history

Apple doesn't publish when it stops signing a build. With `--history FILE`, Signet records what it sees on each run: when a build was first and last seen signed, and when signing ended. Run it on a schedule (hourly, for example) to get accurate end dates.

### Live service

```bash
node dist/cli.js serve --port 8787 --refresh 30    # re-check Apple every 30 minutes
```

Defaults are `--host 127.0.0.1`, `--port 8787` and `--refresh 30` (`0` runs the pipeline once). Other flags are passed to the pipeline. CORS is open, so the website or any other client can fetch live signing data.

## Decrypting OTA packages

Many OTA updates are Apple Encrypted Archives (`.aea`). The report includes each package's decryption key, and the device pages show it.

On any OS:

```bash
node dist/cli.js decrypt <file>.aea --key '<base64 key>'     # writes <file>.aar
```

On macOS 13 or later, Apple's own tool works too:

```bash
aea decrypt -i <file>.aea -o <file>.aar -key-value 'base64:<key>'
```

Both produce identical output. Every block is authenticated, so a wrong key or a damaged download fails with an error instead of producing a broken file.

The decrypted file is an Apple Archive (`.aar`), not a zip. To list or extract it, use the `signet-aea` CLI from `@chrispeoples/aea` (`npx signet-aea` inside this repo):

```bash
signet-aea extract <file>.aea --key '<base64 key>' -d out/
signet-aea list <file>.aar
```

## Website

Pages are generated at build time from `signet-report.json` by a Hugo content adapter (`site/content/_content.gotmpl`); there are no hand-written device pages. The theme is [splunk/hugo-theme-splunk-workshop](https://github.com/splunk/hugo-theme-splunk-workshop), included as a Git submodule in `site/themes/`.

Download links point to Apple's CDN (`updates.cdn-apple.com`). Signet never re-hosts firmware.

The site is built for `https://cpeoples.github.io/signet/` (`baseURL` in `site/hugo.toml`) and deployed by `.github/workflows/docs.yml` on every push to `main` and hourly, so signing status stays current. Pull requests build it without deploying. Each page gets a search title and description from the report, a canonical link and schema.org breadcrumbs. The build also writes `sitemap.xml`, `robots.txt` and an [`llms.txt`](https://llmstxt.org/) that lists every device with its latest firmware and signing status.

## Data sources

| Data | Source |
|---|---|
| IPSW lists | Apple's firmware feeds (`itunes.apple.com`, `mesu.apple.com`) |
| Device names, chip, CPU, GPU, display, radios | The DeviceTree inside each IPSW, read with HTTP range requests |
| Signing status | Apple's TSS server, `gs.apple.com` |
| Release and expiry dates | Apple's update server, `gdmf.apple.com` |
| OTA packages and decryption keys | `gdmf.apple.com` and `mesu.apple.com` |
| Retail specs and product photos | Apple Tech Specs (`support.apple.com`) |

Three non-Apple sources are used, each for one thing:

- AppleDB: only to find Apple-hosted download URLs for builds that have no IPSW feed (watchOS). URLs are accepted only on Apple's hosts. Disable with `--no-appledb`.
- Wikimedia Commons: chip photos, credited with author and license. Disable with `--no-chip-images`.
- A names file you provide with `--names FILE`, for devices older than 2014 whose firmware can't be read for names.

## Project layout

```
src/                 CLI, pipeline and service (TypeScript)
packages/aea/        @chrispeoples/aea: .aea decryptor and .aar extractor
site/                Hugo site: content adapter, layouts, CSS and JS
site/themes/         theme submodule
signet.config.json   endpoints and tuning settings
```

Generated files (`signet-report.json`, `signet-history.json`, `apple-boards.json`, `apple-techspecs.json`, `dist/`, `site/public/`) are gitignored and rebuilt from Apple's servers on demand.
