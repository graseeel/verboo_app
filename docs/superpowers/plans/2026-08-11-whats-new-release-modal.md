# Versioned What's New Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a localized, accessible What's New modal exactly once per tagged desktop-app version, beginning with `0.7.0-beta`, while generating the modal, GitHub release body, and updater summary from one reviewed bilingual catalog.

**Architecture:** A repository-level release catalog is validated before every release and compiled into the renderer. A Rust-owned `WhatsNewService` validates the compile-time release tag, compares semantic versions, and atomically persists app-only acknowledgment state. A focused renderer hook waits for configuration, settings, and mandatory CLI bootstrap to settle before mounting an accessible modal; CLI-only updates never participate in this lifecycle.

**Tech Stack:** React 19, TypeScript 6, Vitest/Testing Library, Tauri 2, Rust 1.89, Serde, SemVer, Node.js 20 release scripts, GitHub Actions.

## Global Constraints

- Target desktop version is exactly `0.7.0-beta` in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
- Supported platforms are macOS, Windows, and Linux; only the iOS Simulator highlight is macOS-specific.
- Automatic presentation is enabled only for artifacts compiled with `VERBOO_RELEASE_TAG=v<package-version>`.
- `VERBOO_WHATS_NEW_PREVIEW=1` displays the current release locally without writing acknowledgment state.
- Persistent state is app-owned at `<app-data>/release-state.json`; no CLI-owned file or update snapshot can trigger or acknowledge the modal.
- The modal appears after configuration, settings, and mandatory Node/CLI bootstrap are resolved, including the bootstrap success animation.
- The modal has exactly two visible actions, no close icon, no backdrop dismissal, and Escape behaves like Close.
- Learn more derives `https://github.com/graseeel/verboo_app/releases/tag/v<version>` from a validated version; the catalog cannot provide a URL.
- A successful external open acknowledges and closes; an opener failure stays visible and does not acknowledge.
- A persistence failure closes the modal for the current process, produces a non-fatal error toast, and may show again after relaunch.
- Release copy is offline, reviewed, and available in `pt-BR` and `en-US`; automation must never invent product claims from commits.
- The `0.7.0-beta` entry contains the six approved highlights, including the integrated iOS Simulator.
- Future release preparation scaffolds editorial fields, while verification blocks an unreviewed sentinel, missing locale, incomplete item, or count outside four to six.
- Do not push, merge, squash, or tag while implementing these tasks. Release operations remain a separate, explicitly verified workflow.
- Preserve all unrelated working-tree changes and stage only the files named by each task.

---

## File Map

### Release content and automation

- Create `release-notes/releases.json`: single bilingual source of release copy.
- Create `scripts/release/release-catalog.mjs`: schema/version validation and catalog loading.
- Create `scripts/release/release-catalog.test.mjs`: release-content contract tests.
- Create `scripts/release/prepare-release.mjs`: non-destructive command that adds an editorial sentinel entry and refuses to overwrite an existing version.
- Create `scripts/release/prepare-release.test.mjs`: behavioral scaffolding tests.
- Create `scripts/release/render-release-notes.mjs`: deterministic GitHub Markdown renderer.
- Modify `package.json`: expose `release:prepare` and `release:verify`.
- Modify `scripts/verify/verify-release-version.mjs`: require a complete catalog entry matching the tag.
- Modify `scripts/verify/verify-release-version.test.mjs`: cover complete and incomplete catalog entries.
- Modify `scripts/verify/update-manifest.mjs`: accept catalog-derived updater notes.
- Modify `scripts/verify/update-manifest.test.mjs`: prove the supplied release summary reaches `latest.json`.
- Modify `scripts/verify/generate-tauri-update-manifest.mjs`: load the matching catalog entry.
- Modify `.github/workflows/tauri-release.yml`: validate content, stamp every platform build, and render release notes from the catalog.
- Modify `scripts/verify/tauri-release-signing.test.mjs`: lock the stamp and remove stale inline release prose.

### Native lifecycle

- Create `src-tauri/src/services/whats_new_service.rs`: eligibility, session suppression, semantic comparison, and atomic state persistence.
- Modify `src-tauri/src/services/mod.rs`: register the service module.
- Modify `src-tauri/src/models/types.rs`: add IPC result types.
- Modify `src-tauri/src/lib.rs`: manage the service and expose two commands.
- Modify `src/shared/types.ts`: mirror the IPC types.
- Modify `src/renderer/verboo-bridge.ts`: expose typed status and acknowledgment calls.

### Renderer

- Create `src/renderer/features/whats-new/releaseCatalog.ts`: typed catalog lookup and fixed tag URL derivation.
- Create `src/renderer/features/whats-new/releaseCatalog.test.ts`: locale, missing-version, and URL tests.
- Create `src/renderer/features/whats-new/WhatsNewModal.tsx`: presentation, focus trap, action ordering, and opener handling.
- Create `src/renderer/features/whats-new/WhatsNewModal.test.tsx`: mounted behavioral and accessibility tests.
- Create `src/renderer/features/whats-new/useWhatsNew.ts`: one-shot bridge query and session dismissal state.
- Create `src/renderer/features/whats-new/useWhatsNew.test.tsx`: request/acknowledgment lifecycle tests.
- Create `src/renderer/styles/whats-new.css`: responsive visual treatment and reduced-motion behavior.
- Modify `src/renderer/styles/app.css`: import the focused stylesheet.
- Modify `src/renderer/i18n.tsx`: generic modal labels and recoverable errors in both locales.
- Modify `src/renderer/App.tsx`: wire startup precedence on both login and unlocked surfaces.
- Modify `src/renderer/App.cliBootstrapGate.test.tsx`: mounted App-to-bridge precedence proof.

---

### Task 1: Create the bilingual release catalog and preparation command

**Files:**
- Create: `release-notes/releases.json`
- Create: `scripts/release/release-catalog.mjs`
- Create: `scripts/release/release-catalog.test.mjs`
- Create: `scripts/release/prepare-release.mjs`
- Create: `scripts/release/prepare-release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the canonical app version string supplied by the release command.
- Produces: `readReleaseCatalog(path?)`, `validateReleaseCatalog(catalog, version)`, `releaseEntry(catalog, version)`, `scaffoldReleaseVersion(catalog, version)`, and `EDITORIAL_SENTINEL` for Task 2; `release-notes/releases.json` for Tasks 2 and 4.

- [ ] **Step 1: Write failing catalog contract tests**

Create `scripts/release/release-catalog.test.mjs` with tests that load the real entry and mutate it counterfactually:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  EDITORIAL_SENTINEL,
  readReleaseCatalog,
  releaseEntry,
  validateReleaseCatalog,
} from "./release-catalog.mjs";

test("0.7.0-beta has complete reviewed pt-BR and en-US copy", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.0-beta");

  assert.equal(entry["pt-BR"].items.length, 6);
  assert.equal(entry["en-US"].items.length, 6);
  assert.match(entry["pt-BR"].items[0].title, /Simulador de iOS/);
  assert.match(entry["en-US"].items[0].title, /iOS Simulator/);
  assert.deepEqual(releaseEntry(catalog, "0.7.0-beta"), entry);
});

test("rejects missing locale, editorial sentinel, and invalid item count", async () => {
  const original = await readReleaseCatalog();

  const missingLocale = structuredClone(original);
  delete missingLocale.releases["0.7.0-beta"]["en-US"];
  assert.throws(
    () => validateReleaseCatalog(missingLocale, "0.7.0-beta"),
    /en-US/,
  );

  const sentinel = structuredClone(original);
  sentinel.releases["0.7.0-beta"]["pt-BR"].summary = EDITORIAL_SENTINEL;
  assert.throws(
    () => validateReleaseCatalog(sentinel, "0.7.0-beta"),
    /editorial copy/i,
  );

  const tooShort = structuredClone(original);
  tooShort.releases["0.7.0-beta"]["en-US"].items = tooShort.releases["0.7.0-beta"]["en-US"].items.slice(0, 3);
  assert.throws(
    () => validateReleaseCatalog(tooShort, "0.7.0-beta"),
    /four to six/i,
  );
});

test("rejects non-canonical release versions", async () => {
  const catalog = await readReleaseCatalog();
  assert.throws(() => validateReleaseCatalog(catalog, "v0.7.0-beta"), /canonical/i);
  assert.throws(() => validateReleaseCatalog(catalog, "0.7"), /canonical/i);
});
```

- [ ] **Step 2: Write failing release-preparation tests**

Create `scripts/release/prepare-release.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { EDITORIAL_SENTINEL, validateReleaseCatalog } from "./release-catalog.mjs";
import { scaffoldReleaseVersion } from "./prepare-release.mjs";

const emptyCatalog = { schemaVersion: 1, releases: {} };

test("scaffolds both locales with four explicit editorial sentinels", () => {
  const next = scaffoldReleaseVersion(emptyCatalog, "0.8.0-beta");
  const entry = next.releases["0.8.0-beta"];

  assert.equal(entry["pt-BR"].title, EDITORIAL_SENTINEL);
  assert.equal(entry["en-US"].title, EDITORIAL_SENTINEL);
  assert.equal(entry["pt-BR"].items.length, 4);
  assert.equal(entry["en-US"].items.length, 4);
  assert.throws(
    () => validateReleaseCatalog(next, "0.8.0-beta"),
    /editorial copy/i,
  );
});

test("refuses to overwrite an existing release", () => {
  const once = scaffoldReleaseVersion(emptyCatalog, "0.8.0-beta");
  assert.throws(
    () => scaffoldReleaseVersion(once, "0.8.0-beta"),
    /already exists/i,
  );
});
```

- [ ] **Step 3: Run the focused tests and confirm the expected red state**

Run:

```bash
node --test scripts/release/release-catalog.test.mjs scripts/release/prepare-release.test.mjs
```

Expected: FAIL because `release-catalog.mjs`, `prepare-release.mjs`, and `release-notes/releases.json` do not exist.

- [ ] **Step 4: Add the exact `0.7.0-beta` catalog**

Create `release-notes/releases.json`:

```json
{
  "schemaVersion": 1,
  "releases": {
    "0.7.0-beta": {
      "pt-BR": {
        "title": "O Verboo Code 0.7.0-beta chegou",
        "summary": "Uma grande atualização para trabalhar com apps iOS, provedores externos e uma instalação mais leve.",
        "items": [
          {
            "title": "Simulador de iOS integrado — macOS",
            "body": "Abra iPhones e iPads ao lado da conversa, interaja com o app, use controles do sistema e envie seleções ao chat."
          },
          {
            "title": "Várias contas Claude e Codex",
            "body": "Conecte contas adicionais, escolha qual conta cada conversa utiliza e preserve o histórico visível ao trocar."
          },
          {
            "title": "Planos e limites no lugar certo",
            "body": "Consulte o plano, as janelas de uso e os horários de renovação diretamente em Provedores."
          },
          {
            "title": "Atualizações independentes do CLI",
            "body": "O app e o CLI agora podem receber atualizações assinadas separadamente, mantendo um único fluxo seguro de reinicialização."
          },
          {
            "title": "Instalação muito mais leve",
            "body": "O Node é baixado e verificado pelo próprio app no primeiro uso, sem depender do Node do sistema e sem criar um aplicativo auxiliar no Dock."
          },
          {
            "title": "Uma experiência mais fluida",
            "body": "Carregamento paralelo de provedores, login mais robusto e transições discretas deixam a inicialização mais agradável."
          }
        ]
      },
      "en-US": {
        "title": "Verboo Code 0.7.0-beta is here",
        "summary": "A major update for working with iOS apps, external providers, and a lighter installation.",
        "items": [
          {
            "title": "Built-in iOS Simulator — macOS",
            "body": "Open iPhones and iPads beside the conversation, interact with your app, use system controls, and send selections to chat."
          },
          {
            "title": "Multiple Claude and Codex accounts",
            "body": "Connect additional accounts, choose which account each conversation uses, and keep the visible history when switching."
          },
          {
            "title": "Plans and limits where you need them",
            "body": "See your plan, usage windows, and reset times directly in Providers."
          },
          {
            "title": "Independent CLI updates",
            "body": "The app and CLI can now receive signed updates separately while sharing one safe restart flow."
          },
          {
            "title": "A much lighter installation",
            "body": "Node is downloaded and verified by the app on first use, without relying on system Node or creating a helper app in the Dock."
          },
          {
            "title": "A smoother experience",
            "body": "Parallel provider loading, more reliable sign-in, and subtle transitions make startup feel better."
          }
        ]
      }
    }
  }
}
```

- [ ] **Step 5: Implement strict catalog validation and loading**

Create `scripts/release/release-catalog.mjs` with these public contracts:

```js
import { readFile } from "node:fs/promises";

export const EDITORIAL_SENTINEL = "EDITORIAL_COPY_REQUIRED";
export const RELEASE_LOCALES = Object.freeze(["pt-BR", "en-US"]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function assertCanonicalVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`release version must be canonical semantic version: ${String(version)}`);
  }
  return version;
}

function assertReviewedText(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be non-empty`);
  }
  if (value.includes(EDITORIAL_SENTINEL)) {
    throw new Error(`${path} still requires reviewed editorial copy`);
  }
}

function validateLocale(copy, path) {
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    throw new Error(`${path} must be an object`);
  }
  assertReviewedText(copy.title, `${path}.title`);
  assertReviewedText(copy.summary, `${path}.summary`);
  if (!Array.isArray(copy.items) || copy.items.length < 4 || copy.items.length > 6) {
    throw new Error(`${path}.items must contain four to six highlights`);
  }
  copy.items.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${path}.items[${index}] must be an object`);
    }
    assertReviewedText(item.title, `${path}.items[${index}].title`);
    assertReviewedText(item.body, `${path}.items[${index}].body`);
  });
  return copy;
}

export function releaseEntry(catalog, version) {
  assertCanonicalVersion(version);
  const entry = catalog?.releases?.[version];
  if (!entry) throw new Error(`release catalog has no entry for ${version}`);
  return entry;
}

export function validateReleaseCatalog(catalog, version) {
  if (catalog?.schemaVersion !== 1) {
    throw new Error(`release catalog schemaVersion must be 1`);
  }
  const entry = releaseEntry(catalog, version);
  for (const locale of RELEASE_LOCALES) {
    validateLocale(entry[locale], `releases.${version}.${locale}`);
  }
  return entry;
}

export async function readReleaseCatalog(path = "release-notes/releases.json") {
  return JSON.parse(await readFile(path, "utf8"));
}
```

- [ ] **Step 6: Implement the non-destructive preparation command**

Create `scripts/release/prepare-release.mjs`:

```js
#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  assertCanonicalVersion,
  EDITORIAL_SENTINEL,
  RELEASE_LOCALES,
} from "./release-catalog.mjs";

function editorialLocale() {
  return {
    title: EDITORIAL_SENTINEL,
    summary: EDITORIAL_SENTINEL,
    items: Array.from({ length: 4 }, () => ({
      title: EDITORIAL_SENTINEL,
      body: EDITORIAL_SENTINEL,
    })),
  };
}

export function scaffoldReleaseVersion(catalog, version) {
  assertCanonicalVersion(version);
  if (catalog?.schemaVersion !== 1 || !catalog.releases || typeof catalog.releases !== "object") {
    throw new Error("release catalog must use schemaVersion 1 and contain releases");
  }
  if (catalog.releases[version]) {
    throw new Error(`release ${version} already exists in the catalog`);
  }
  const next = structuredClone(catalog);
  next.releases[version] = Object.fromEntries(
    RELEASE_LOCALES.map(locale => [locale, editorialLocale()]),
  );
  return next;
}

async function main() {
  const version = process.argv[2];
  if (!version) throw new Error("usage: npm run release:prepare -- <version>");
  const path = "release-notes/releases.json";
  const catalog = JSON.parse(await readFile(path, "utf8"));
  const next = scaffoldReleaseVersion(catalog, version);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`Scaffolded editorial fields for ${version} in ${path}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

- [ ] **Step 7: Expose stable npm commands**

Add these entries to `package.json` under `scripts`:

```json
"release:prepare": "node scripts/release/prepare-release.mjs",
"release:verify": "node scripts/verify/verify-release-version.mjs"
```

Keep the surrounding JSON valid and do not change the package version.

- [ ] **Step 8: Run the focused tests and verify the green state**

Run:

```bash
node --test scripts/release/release-catalog.test.mjs scripts/release/prepare-release.test.mjs
node scripts/verify/verify-release-version.mjs --tag v0.7.0-beta
```

Expected: the two test files pass; the second command still passes the existing version checks until Task 2 adds catalog enforcement.

- [ ] **Step 9: Commit Task 1 only**

```bash
git add package.json release-notes/releases.json scripts/release/release-catalog.mjs scripts/release/release-catalog.test.mjs scripts/release/prepare-release.mjs scripts/release/prepare-release.test.mjs
git diff --cached --check
git commit -m "feat(release): add bilingual release catalog"
```

---

### Task 2: Make release artifacts and metadata consume the catalog

**Files:**
- Create: `scripts/release/render-release-notes.mjs`
- Modify: `scripts/release/release-catalog.test.mjs`
- Modify: `scripts/verify/verify-release-version.mjs`
- Modify: `scripts/verify/verify-release-version.test.mjs`
- Modify: `scripts/verify/update-manifest.mjs`
- Modify: `scripts/verify/update-manifest.test.mjs`
- Modify: `scripts/verify/generate-tauri-update-manifest.mjs`
- Modify: `scripts/verify/tauri-release-signing.test.mjs`
- Modify: `.github/workflows/tauri-release.yml`

**Interfaces:**
- Consumes: `readReleaseCatalog()`, `validateReleaseCatalog()`, and the exact entry created in Task 1.
- Produces: `renderReleaseNotes(entry, version) -> string`, catalog-derived `latest.json.notes`, compile-time `VERBOO_RELEASE_TAG`, and a release workflow with no version-specific prose.

- [ ] **Step 1: Add failing release-metadata tests**

Extend `scripts/release/release-catalog.test.mjs`:

```js
import { renderReleaseNotes } from "./render-release-notes.mjs";

test("renders GitHub notes from the reviewed English catalog entry", async () => {
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, "0.7.0-beta");
  const markdown = renderReleaseNotes(entry, "0.7.0-beta");

  assert.match(markdown, /^## Verboo Code 0\.7\.0-beta/m);
  assert.match(markdown, /Built-in iOS Simulator — macOS/);
  assert.match(markdown, /A much lighter installation/);
  assert.match(markdown, /Verboo-Code-0\.7\.0-beta-Windows-x64-Setup\.exe/);
  assert.doesNotMatch(markdown, /EDITORIAL_COPY_REQUIRED/);
});
```

Modify the first test in `scripts/verify/update-manifest.test.mjs` to pass and assert the catalog summary:

```js
const manifest = await buildUpdateManifest({
  tag: "v1.2.3",
  version: "1.2.3",
  bundlesDir,
  releaseBaseUrl: "https://github.com/graseeel/verboo_app/releases/download/v1.2.3",
  publishedAt: "2026-07-22T18:00:00.000Z",
  notes: "Reviewed release summary",
});

assert.equal(manifest.notes, "Reviewed release summary");
```

Extend `scripts/verify/verify-release-version.test.mjs` with a complete catalog fixture and a missing-entry mutation:

```js
const reviewedLocale = {
  title: "Reviewed title",
  summary: "Reviewed summary",
  items: Array.from({ length: 4 }, (_, index) => ({
    title: `Highlight ${index + 1}`,
    body: `Reviewed body ${index + 1}`,
  })),
};

const reviewedCatalog = {
  schemaVersion: 1,
  releases: {
    "0.6.0-beta.1": {
      "pt-BR": structuredClone(reviewedLocale),
      "en-US": structuredClone(reviewedLocale),
    },
  },
};

test("rejects a matching version that has no reviewed catalog entry", () => {
  assert.throws(
    () => verifyReleaseVersions({
      tag: "v0.6.0-beta.2",
      packageVersion: "0.6.0-beta.2",
      cargoVersion: "0.6.0-beta.2",
      tauriVersion: "0.6.0-beta.2",
      catalog: reviewedCatalog,
    }),
    /no entry/i,
  );
});
```

Pass `catalog: reviewedCatalog` to the existing accepted fixture and matching mutations.

- [ ] **Step 2: Add a failing workflow contract test**

Extend the workflow assertions in `scripts/verify/tauri-release-signing.test.mjs`:

```js
assert.match(workflow, /VERBOO_RELEASE_TAG:\s*\$\{\{ needs\.resolve-tag\.outputs\.tag \}\}/);
assert.match(workflow, /render-release-notes\.mjs/);
assert.doesNotMatch(workflow, /This beta brings a macOS embedded browser/);
assert.doesNotMatch(workflow, /printf '%s\\n' "- On macOS, work beside a live local site/);
```

- [ ] **Step 3: Run the release tests and confirm the expected red state**

Run:

```bash
node --test scripts/release/release-catalog.test.mjs scripts/verify/update-manifest.test.mjs scripts/verify/verify-release-version.test.mjs scripts/verify/tauri-release-signing.test.mjs
```

Expected: FAIL because `render-release-notes.mjs` is absent, the manifest ignores `notes`, version verification does not receive a catalog, and the workflow has no release stamp.

- [ ] **Step 4: Implement deterministic GitHub Markdown rendering**

Create `scripts/release/render-release-notes.mjs`:

```js
#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { readReleaseCatalog, validateReleaseCatalog } from "./release-catalog.mjs";

export function renderReleaseNotes(entry, version) {
  const copy = entry["en-US"];
  const highlights = copy.items.flatMap(item => [
    `- **${item.title}**`,
    `  ${item.body}`,
  ]);
  return [
    `## Verboo Code ${version}`,
    "",
    copy.summary,
    "",
    "### What's new",
    "",
    ...highlights,
    "",
    "### Download the right file",
    "",
    "| Your computer | Download |",
    "|---|---|",
    `| **macOS Apple Silicon** (M1 / M2 / M3 / M4) | \`Verboo-Code-${version}-macOS-Apple-Silicon.dmg\` |`,
    `| **macOS Intel** | \`Verboo-Code-${version}-macOS-Intel.dmg\` |`,
    `| **Windows 10/11 (64-bit)** | \`Verboo-Code-${version}-Windows-x64-Setup.exe\` |`,
    `| **Linux (AppImage, any distro)** | \`Verboo-Code-${version}-Linux-x64.AppImage\` |`,
    `| **Linux Debian/Ubuntu** | \`Verboo-Code-${version}-Linux-x64.deb\` |`,
    `| **Linux Fedora/RHEL** | \`Verboo-Code-${version}-Linux-x64.rpm\` |`,
    "",
    "> Tip: on a Mac, open **Apple menu → About This Mac**. If the chip says Apple M…, pick **Apple Silicon**.",
    "",
    "Assets appear as each platform build finishes.",
    "",
  ].join("\n");
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    result[values[index]?.replace(/^--/, "")] = values[index + 1];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version || !args.output) {
    throw new Error("usage: render-release-notes.mjs --version <version> --output <path>");
  }
  const catalog = await readReleaseCatalog();
  const entry = validateReleaseCatalog(catalog, args.version);
  await writeFile(args.output, renderReleaseNotes(entry, args.version));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

- [ ] **Step 5: Require reviewed catalog content in release version verification**

Modify `scripts/verify/verify-release-version.mjs` so the pure function consumes the catalog and the CLI loads it:

```js
import { readReleaseCatalog, validateReleaseCatalog } from "../release/release-catalog.mjs";

export function verifyReleaseVersions({
  tag,
  packageVersion,
  cargoVersion,
  tauriVersion,
  catalog,
}) {
  if (!tag?.startsWith("v") || tag.length === 1) {
    throw new Error(`release tag must be v-prefixed: ${tag ?? "missing"}`);
  }
  const expected = tag.slice(1);
  for (const [source, actual] of Object.entries({
    package: packageVersion,
    Cargo: cargoVersion,
    Tauri: tauriVersion,
  })) {
    if (actual !== expected) {
      throw new Error(`${source} version ${actual} does not match release ${expected}`);
    }
  }
  validateReleaseCatalog(catalog, expected);
  return expected;
}
```

Inside `main()`, load once and pass:

```js
const catalog = await readReleaseCatalog();
verifyReleaseVersions({
  tag,
  packageVersion: packageJson.version,
  cargoVersion,
  tauriVersion: tauriConfig.version,
  catalog,
});
```

- [ ] **Step 6: Feed reviewed summary text into the updater manifest**

Change `buildUpdateManifest` in `scripts/verify/update-manifest.mjs` to require a non-empty `notes` argument and return it unchanged:

```js
export async function buildUpdateManifest({
  tag,
  version,
  bundlesDir,
  releaseBaseUrl,
  publishedAt = new Date().toISOString(),
  notes,
}) {
  if (typeof notes !== "string" || notes.trim().length === 0) {
    throw new Error("update manifest requires reviewed release notes");
  }
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match version ${version}`);
  }
  const baseUrl = new URL(releaseBaseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("update release URL must use HTTPS");
  }

  const files = new Set(await readdir(bundlesDir));
  const platforms = {};
  for (const [target, makeName] of Object.entries(TARGET_ARTIFACTS)) {
    const artifact = makeName(version);
    const signatureFile = `${artifact}.sig`;
    if (!files.has(artifact)) throw new Error(`missing updater artifact for ${target}: ${artifact}`);
    if (!files.has(signatureFile)) throw new Error(`missing signature for ${target}: ${signatureFile}`);
    const signature = (await readFile(join(bundlesDir, signatureFile), "utf8")).trim();
    if (!signature) throw new Error(`empty signature for ${target}: ${signatureFile}`);
    platforms[target] = {
      signature,
      url: `${releaseBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(basename(artifact))}`,
    };
  }
  return { version, notes, pub_date: publishedAt, platforms };
}
```

Update every `buildUpdateManifest` test call to pass `notes: "Reviewed release summary"`.

Modify `scripts/verify/generate-tauri-update-manifest.mjs` before its call:

```js
import { readReleaseCatalog, validateReleaseCatalog } from "../release/release-catalog.mjs";

const catalog = await readReleaseCatalog();
const release = validateReleaseCatalog(catalog, args.version);

const manifest = await buildUpdateManifest({
  tag: args.tag,
  version: args.version,
  bundlesDir: args["bundles-dir"],
  releaseBaseUrl: `https://github.com/graseeel/verboo_app/releases/download/${args.tag}`,
  notes: release["en-US"].summary,
});
```

- [ ] **Step 7: Stamp all matrix artifacts and replace inline workflow prose**

In the `build-tauri` job-level `env` in `.github/workflows/tauri-release.yml`, add:

```yaml
      VERBOO_RELEASE_TAG: ${{ needs.resolve-tag.outputs.tag }}
```

Replace the inline `printf` release-body block in `Publish to GitHub Release` with:

```bash
NOTES_FILE="${RUNNER_TEMP:-/tmp}/release-notes-${VERSION}.md"
node scripts/release/render-release-notes.mjs \
  --version "$VERSION" \
  --output "$NOTES_FILE"
```

Extend `Test release contracts` to include the new Node tests:

```yaml
run: >-
  node --test
  scripts/release/release-catalog.test.mjs
  scripts/release/prepare-release.test.mjs
  scripts/verify/update-manifest.test.mjs
  scripts/verify/verify-release-version.test.mjs
  scripts/verify/tauri-release-signing.test.mjs
  scripts/verify/cli-update-ownership.test.mjs
```

- [ ] **Step 8: Run all release contract tests**

Run:

```bash
node --test scripts/release/release-catalog.test.mjs scripts/release/prepare-release.test.mjs scripts/verify/update-manifest.test.mjs scripts/verify/verify-release-version.test.mjs scripts/verify/tauri-release-signing.test.mjs scripts/verify/cli-update-ownership.test.mjs
node scripts/verify/verify-release-version.mjs --tag v0.7.0-beta
```

Expected: all tests PASS, the real catalog validates, and no release prose remains embedded in the workflow.

- [ ] **Step 9: Commit Task 2 only**

```bash
git add .github/workflows/tauri-release.yml scripts/release/release-catalog.test.mjs scripts/release/render-release-notes.mjs scripts/verify/verify-release-version.mjs scripts/verify/verify-release-version.test.mjs scripts/verify/update-manifest.mjs scripts/verify/update-manifest.test.mjs scripts/verify/generate-tauri-update-manifest.mjs scripts/verify/tauri-release-signing.test.mjs
git diff --cached --check
git commit -m "feat(release): generate metadata from reviewed notes"
```

---

### Task 3: Add the app-owned native acknowledgment lifecycle

**Files:**
- Create: `src-tauri/src/services/whats_new_service.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/models/types.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/verboo-bridge.ts`

**Interfaces:**
- Consumes: compile-time `option_env!("VERBOO_RELEASE_TAG")`, runtime `VERBOO_WHATS_NEW_PREVIEW`, current Tauri package version, and app-data directory.
- Produces: `WhatsNewService::status() -> Result<Option<WhatsNewStatus>, String>`, `WhatsNewService::acknowledge(&str) -> Result<WhatsNewAcknowledgeResult, String>`, bridge calls `getWhatsNewStatus()` and `acknowledgeWhatsNew(version)` for Task 5.

- [ ] **Step 1: Define mirrored IPC types before the service tests**

Add to `src-tauri/src/models/types.rs` after update types:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WhatsNewStatus {
    pub version: String,
    pub tag: String,
    pub preview: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WhatsNewAcknowledgeResult {
    pub persisted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
```

Add matching types to `src/shared/types.ts` after `InstallUpdateResult`:

```ts
export type WhatsNewStatus = {
  version: string
  tag: string
  preview: boolean
}

export type WhatsNewAcknowledgeResult = {
  persisted: boolean
  error?: string
}
```

- [ ] **Step 2: Write failing native lifecycle tests**

Create `src-tauri/src/services/whats_new_service.rs` with the test module first, importing the production type that will be added below:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn tagged(root: &Path, current: &str) -> WhatsNewService {
        WhatsNewService::new(
            root.to_path_buf(),
            current.to_string(),
            Some(format!("v{current}")),
            false,
        )
    }

    #[test]
    fn first_tagged_launch_is_eligible_then_acknowledgment_survives_restart() {
        let root = tempdir().unwrap();
        let service = tagged(root.path(), "0.7.0-beta");
        assert_eq!(service.status().unwrap().unwrap().version, "0.7.0-beta");
        assert!(service.acknowledge("0.7.0-beta").unwrap().persisted);
        assert!(service.status().unwrap().is_none());
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_none());
    }

    #[test]
    fn newer_version_is_eligible_and_downgrade_is_suppressed() {
        let root = tempdir().unwrap();
        tagged(root.path(), "0.7.0-beta").acknowledge("0.7.0-beta").unwrap();
        assert!(tagged(root.path(), "0.8.0-beta").status().unwrap().is_some());
        assert!(tagged(root.path(), "0.6.2").status().unwrap().is_none());
    }

    #[test]
    fn absent_or_mismatched_build_tag_is_not_eligible() {
        let root = tempdir().unwrap();
        let absent = WhatsNewService::new(root.path().into(), "0.7.0-beta".into(), None, false);
        let mismatch = WhatsNewService::new(
            root.path().into(),
            "0.7.0-beta".into(),
            Some("v0.6.2".into()),
            false,
        );
        assert!(absent.status().unwrap().is_none());
        assert!(mismatch.status().unwrap().is_none());
    }

    #[test]
    fn preview_shows_once_per_process_without_writing_state() {
        let root = tempdir().unwrap();
        let preview = WhatsNewService::new(root.path().into(), "0.7.0-beta".into(), None, true);
        assert!(preview.status().unwrap().unwrap().preview);
        let result = preview.acknowledge("0.7.0-beta").unwrap();
        assert!(!result.persisted);
        assert!(result.error.is_none());
        assert!(!root.path().join("release-state.json").exists());
        assert!(preview.status().unwrap().is_none());
    }

    #[test]
    fn corrupt_state_is_repaired_and_suppressed_without_showing() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("release-state.json"), b"not json").unwrap();
        let service = tagged(root.path(), "0.7.0-beta");
        assert!(service.status().unwrap().is_none());
        let repaired: ReleaseState = serde_json::from_slice(
            &fs::read(root.path().join("release-state.json")).unwrap(),
        ).unwrap();
        assert_eq!(repaired.acknowledged_version, "0.7.0-beta");
    }

    #[test]
    fn unsupported_schema_is_repaired_and_unknown_fields_are_ignored() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("release-state.json"),
            br#"{"schemaVersion":1,"acknowledgedVersion":"0.7.0-beta","futureField":true}"#,
        ).unwrap();
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_none());

        fs::write(
            root.path().join("release-state.json"),
            br#"{"schemaVersion":2,"acknowledgedVersion":"0.7.0-beta"}"#,
        ).unwrap();
        assert!(tagged(root.path(), "0.8.0-beta").status().unwrap().is_none());
        let repaired: ReleaseState = serde_json::from_slice(
            &fs::read(root.path().join("release-state.json")).unwrap(),
        ).unwrap();
        assert_eq!(repaired.schema_version, 1);
        assert_eq!(repaired.acknowledged_version, "0.8.0-beta");
    }

    #[test]
    fn closing_the_process_without_acknowledging_keeps_the_release_eligible() {
        let root = tempdir().unwrap();
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_some());
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_some());
    }

    #[test]
    fn direct_acknowledgment_from_a_downgraded_build_never_lowers_the_record() {
        let root = tempdir().unwrap();
        tagged(root.path(), "0.8.0-beta").acknowledge("0.8.0-beta").unwrap();
        tagged(root.path(), "0.7.0-beta").acknowledge("0.7.0-beta").unwrap();
        let state: ReleaseState = serde_json::from_slice(
            &fs::read(root.path().join("release-state.json")).unwrap(),
        ).unwrap();
        assert_eq!(state.acknowledged_version, "0.8.0-beta");
    }

    #[test]
    fn cli_files_cannot_change_app_release_eligibility() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("cli-update")).unwrap();
        fs::write(
            root.path().join("cli-update/current.json"),
            br#"{"version":"999.0.0"}"#,
        ).unwrap();
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_some());
    }

    #[test]
    fn failed_persistence_suppresses_only_the_current_process() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("release-state.json")).unwrap();
        let service = tagged(root.path(), "0.7.0-beta");
        let result = service.acknowledge("0.7.0-beta").unwrap();
        assert!(!result.persisted);
        assert!(result.error.is_some());
        assert!(service.status().unwrap().is_none());
    }
}
```

- [ ] **Step 3: Run the focused native test and confirm the expected red state**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib whats_new_service -- --nocapture
```

Expected: FAIL because `WhatsNewService` and `ReleaseState` are not defined.

- [ ] **Step 4: Implement the native service with session suppression and atomic writes**

Add the production implementation above the test module in `src-tauri/src/services/whats_new_service.rs`:

```rust
use crate::models::types::{WhatsNewAcknowledgeResult, WhatsNewStatus};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReleaseState {
    schema_version: u32,
    acknowledged_version: String,
}

enum LoadedState {
    Missing,
    Valid(ReleaseState),
    Invalid(String),
}

pub struct WhatsNewService {
    state_path: PathBuf,
    current_version: String,
    build_tag: Option<String>,
    preview: bool,
    suppressed_for_session: Mutex<bool>,
}

impl WhatsNewService {
    pub fn new(
        app_data_dir: PathBuf,
        current_version: String,
        build_tag: Option<String>,
        preview: bool,
    ) -> Self {
        Self {
            state_path: app_data_dir.join("release-state.json"),
            current_version,
            build_tag,
            preview,
            suppressed_for_session: Mutex::new(false),
        }
    }

    pub fn status(&self) -> Result<Option<WhatsNewStatus>, String> {
        if *self.suppressed_for_session.lock().map_err(|_| "what's new session lock poisoned")? {
            return Ok(None);
        }
        let current = Version::parse(&self.current_version)
            .map_err(|error| format!("invalid running app version {}: {error}", self.current_version))?;
        let tag = if self.preview {
            format!("v{}", self.current_version)
        } else {
            let Some(tag) = self.build_tag.clone() else { return Ok(None) };
            if tag != format!("v{}", self.current_version) {
                eprintln!("[verboo:whats-new] release tag {tag} does not match {}", self.current_version);
                return Ok(None);
            }
            tag
        };

        if !self.preview {
            match self.load_state() {
                LoadedState::Missing => {}
                LoadedState::Valid(state) if state.schema_version == STATE_SCHEMA_VERSION => {
                    let acknowledged = Version::parse(&state.acknowledged_version).map_err(|error| {
                        format!("invalid acknowledged app version {}: {error}", state.acknowledged_version)
                    });
                    match acknowledged {
                        Ok(acknowledged) if current <= acknowledged => return Ok(None),
                        Ok(_) => {}
                        Err(error) => return self.repair_and_suppress(error),
                    }
                }
                LoadedState::Valid(state) => {
                    return self.repair_and_suppress(format!(
                        "unsupported release state schema {}",
                        state.schema_version,
                    ));
                }
                LoadedState::Invalid(error) => return self.repair_and_suppress(error),
            }
        }

        Ok(Some(WhatsNewStatus {
            version: self.current_version.clone(),
            tag,
            preview: self.preview,
        }))
    }

    pub fn acknowledge(&self, version: &str) -> Result<WhatsNewAcknowledgeResult, String> {
        if version != self.current_version {
            return Err(format!("cannot acknowledge app version {version} while running {}", self.current_version));
        }
        let expected_tag = format!("v{}", self.current_version);
        if !self.preview && self.build_tag.as_deref() != Some(expected_tag.as_str()) {
            return Err("cannot acknowledge an untagged or mismatched app build".into());
        }
        *self.suppressed_for_session.lock().map_err(|_| "what's new session lock poisoned")? = true;
        if self.preview {
            return Ok(WhatsNewAcknowledgeResult { persisted: false, error: None });
        }
        let acknowledged_version = match self.load_state() {
            LoadedState::Valid(state) if state.schema_version == STATE_SCHEMA_VERSION => {
                match Version::parse(&state.acknowledged_version) {
                    Ok(existing) if existing > Version::parse(&self.current_version)
                        .map_err(|error| format!("invalid running app version {}: {error}", self.current_version))? => {
                        state.acknowledged_version
                    }
                    _ => self.current_version.clone(),
                }
            }
            _ => self.current_version.clone(),
        };
        let state = ReleaseState {
            schema_version: STATE_SCHEMA_VERSION,
            acknowledged_version,
        };
        match atomic_write_json(&self.state_path, &state) {
            Ok(()) => Ok(WhatsNewAcknowledgeResult { persisted: true, error: None }),
            Err(error) => Ok(WhatsNewAcknowledgeResult { persisted: false, error: Some(error) }),
        }
    }

    fn load_state(&self) -> LoadedState {
        let bytes = match fs::read(&self.state_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LoadedState::Missing,
            Err(error) => return LoadedState::Invalid(format!("failed to read {}: {error}", self.state_path.display())),
        };
        match serde_json::from_slice(&bytes) {
            Ok(state) => LoadedState::Valid(state),
            Err(error) => LoadedState::Invalid(format!("invalid {}: {error}", self.state_path.display())),
        }
    }

    fn repair_and_suppress(&self, reason: String) -> Result<Option<WhatsNewStatus>, String> {
        eprintln!("[verboo:whats-new] {reason}; suppressing and repairing current release state");
        *self.suppressed_for_session.lock().map_err(|_| "what's new session lock poisoned")? = true;
        let repaired = ReleaseState {
            schema_version: STATE_SCHEMA_VERSION,
            acknowledged_version: self.current_version.clone(),
        };
        if let Err(error) = atomic_write_json(&self.state_path, &repaired) {
            eprintln!("[verboo:whats-new] state repair failed: {error}");
        }
        Ok(None)
    }
}

fn atomic_write_json(path: &Path, value: &ReleaseState) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "release state path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("failed to create release state directory: {error}"))?;
    let filename = path.file_name().and_then(|name| name.to_str())
        .ok_or_else(|| "release state filename is invalid".to_string())?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize release state: {error}"))?;
    bytes.push(b'\n');
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|error| format!("failed to create temporary release state: {error}"))?;
        file.write_all(&bytes).map_err(|error| format!("failed to write temporary release state: {error}"))?;
        file.flush().map_err(|error| format!("failed to flush temporary release state: {error}"))?;
        file.sync_all().map_err(|error| format!("failed to sync temporary release state: {error}"))?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("failed to atomically replace release state: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!("failed to atomically replace release state: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    OpenOptions::new().read(true).open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync release state directory: {error}"))
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}
```

- [ ] **Step 5: Register the module, state, commands, and typed bridge**

Add to `src-tauri/src/services/mod.rs`:

```rust
pub mod whats_new_service;
```

Add two commands near the existing update commands in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn get_whats_new_status(
    service: tauri::State<'_, crate::services::whats_new_service::WhatsNewService>,
) -> Result<Option<WhatsNewStatus>, String> {
    service.status()
}

#[tauri::command]
fn acknowledge_whats_new(
    version: String,
    service: tauri::State<'_, crate::services::whats_new_service::WhatsNewService>,
) -> Result<WhatsNewAcknowledgeResult, String> {
    service.acknowledge(&version)
}
```

Immediately after the setup callback creates `app_data_dir` and calls `create_dir_all(&app_data_dir)`, manage the service with this block:

```rust
let whats_new_preview = std::env::var("VERBOO_WHATS_NEW_PREVIEW")
    .map(|value| value == "1")
    .unwrap_or(false);
app.manage(crate::services::whats_new_service::WhatsNewService::new(
    app_data_dir.clone(),
    app.package_info().version.to_string(),
    option_env!("VERBOO_RELEASE_TAG").map(str::to_owned),
    whats_new_preview,
));
```

Register both names in `tauri::generate_handler!` under the update commands:

```rust
get_whats_new_status,
acknowledge_whats_new,
```

Import `WhatsNewStatus` and `WhatsNewAcknowledgeResult` in `src/renderer/verboo-bridge.ts`, then add:

```ts
getWhatsNewStatus: () => invoke<WhatsNewStatus | undefined>('get_whats_new_status'),
acknowledgeWhatsNew: (version: string) =>
  invoke<WhatsNewAcknowledgeResult>('acknowledge_whats_new', { version }),
```

- [ ] **Step 6: Run native and type-contract checks**

Run:

```bash
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib whats_new_service -- --nocapture
npx tsc --noEmit
```

Expected: all ten native lifecycle tests PASS and the renderer bridge type-checks.

- [ ] **Step 7: Commit Task 3 only**

```bash
git add src-tauri/src/services/whats_new_service.rs src-tauri/src/services/mod.rs src-tauri/src/models/types.rs src-tauri/src/lib.rs src/shared/types.ts src/renderer/verboo-bridge.ts
git diff --cached --check
git commit -m "feat(app): persist versioned whats-new state"
```

---

### Task 4: Build the accessible localized modal

**Files:**
- Create: `src/renderer/features/whats-new/releaseCatalog.ts`
- Create: `src/renderer/features/whats-new/releaseCatalog.test.ts`
- Create: `src/renderer/features/whats-new/WhatsNewModal.tsx`
- Create: `src/renderer/features/whats-new/WhatsNewModal.test.tsx`
- Create: `src/renderer/styles/whats-new.css`
- Modify: `src/renderer/styles/app.css`
- Modify: `src/renderer/i18n.tsx`

**Interfaces:**
- Consumes: `release-notes/releases.json`, `WhatsNewStatus`, `WhatsNewAcknowledgeResult`, current `LanguageCode`, `openUrl`, and existing `I18nProvider`.
- Produces: `getReleaseCopy(version, language)`, `releaseTagUrl(version)`, and `<WhatsNewModal status onAcknowledge onDismiss />` for Task 5.

- [ ] **Step 1: Write failing catalog adapter tests**

Create `src/renderer/features/whats-new/releaseCatalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { getReleaseCopy, releaseTagUrl } from './releaseCatalog'

describe('releaseCatalog', () => {
  it('returns approved copy in the active locale', () => {
    expect(getReleaseCopy('0.7.0-beta', 'pt-BR')?.title).toBe('O Verboo Code 0.7.0-beta chegou')
    expect(getReleaseCopy('0.7.0-beta', 'en-US')?.items).toHaveLength(6)
  })

  it('returns undefined for a version absent from the bundled catalog', () => {
    expect(getReleaseCopy('9.9.9', 'en-US')).toBeUndefined()
  })

  it('derives only the fixed repository tag URL from a canonical version', () => {
    expect(releaseTagUrl('0.7.0-beta')).toBe(
      'https://github.com/graseeel/verboo_app/releases/tag/v0.7.0-beta',
    )
    expect(() => releaseTagUrl('../malicious')).toThrow(/canonical/i)
  })
})
```

- [ ] **Step 2: Write failing mounted modal tests**

Create `src/renderer/features/whats-new/WhatsNewModal.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../i18n'
import { WhatsNewModal } from './WhatsNewModal'

const status = { version: '0.7.0-beta', tag: 'v0.7.0-beta', preview: false }

function renderModal(overrides: Partial<ComponentProps<typeof WhatsNewModal>> = {}) {
  const onAcknowledge = vi.fn(async () => ({ persisted: true }))
  const onDismiss = vi.fn()
  const openReleaseUrl = vi.fn(async () => undefined)
  const view = render(
    <div>
      <button type="button">Background action</button>
      <I18nProvider language="en-US">
        <WhatsNewModal
          status={status}
          onAcknowledge={onAcknowledge}
          onDismiss={onDismiss}
          openReleaseUrl={openReleaseUrl}
          {...overrides}
        />
      </I18nProvider>
    </div>,
  )
  return { view, onAcknowledge, onDismiss, openReleaseUrl }
}

afterEach(() => vi.restoreAllMocks())

describe('WhatsNewModal', () => {
  it('renders version, summary, six highlights, and exactly two actions', () => {
    renderModal()
    expect(screen.getByRole('dialog', { name: 'Verboo Code 0.7.0-beta is here' })).toBeVisible()
    expect(screen.getByText(/major update for working with iOS apps/i)).toBeVisible()
    expect(screen.getByText('Built-in iOS Simulator — macOS')).toBeVisible()
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(within(screen.getByRole('dialog')).getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Background action' })).toHaveAttribute('inert')
  })

  it('starts on Close, traps focus, handles Escape, and ignores backdrop clicks', async () => {
    const { onAcknowledge, onDismiss } = renderModal()
    const close = screen.getByRole('button', { name: 'Close' })
    const learnMore = screen.getByRole('button', { name: 'Learn more' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(learnMore).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.click(screen.getByTestId('whats-new-backdrop'))
    expect(onAcknowledge).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith('0.7.0-beta'))
    expect(onDismiss).toHaveBeenCalledWith({ persisted: true })
  })

  it('opens the exact tag and acknowledges only after a successful open', async () => {
    const { openReleaseUrl, onAcknowledge, onDismiss } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }))
    await waitFor(() => expect(openReleaseUrl).toHaveBeenCalledWith(
      'https://github.com/graseeel/verboo_app/releases/tag/v0.7.0-beta',
    ))
    await waitFor(() => expect(onAcknowledge).toHaveBeenCalledWith('0.7.0-beta'))
    expect(openReleaseUrl.mock.invocationCallOrder[0]).toBeLessThan(onAcknowledge.mock.invocationCallOrder[0])
    expect(onDismiss).toHaveBeenCalledWith({ persisted: true })
  })

  it('keeps the modal open and does not acknowledge when opening fails', async () => {
    const openReleaseUrl = vi.fn(async () => { throw new Error('browser unavailable') })
    const { onAcknowledge, onDismiss } = renderModal({ openReleaseUrl })
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not open the release page/i)
    expect(onAcknowledge).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('dismisses with a non-fatal result when acknowledgment IPC rejects', async () => {
    const onAcknowledge = vi.fn(async () => { throw new Error('IPC unavailable') })
    const { onDismiss } = renderModal({ onAcknowledge })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith({
      persisted: false,
      error: 'IPC unavailable',
    }))
  })
})
```

- [ ] **Step 3: Run the focused renderer tests and confirm the expected red state**

Run:

```bash
npx vitest run src/renderer/features/whats-new/releaseCatalog.test.ts src/renderer/features/whats-new/WhatsNewModal.test.tsx
```

Expected: FAIL because both renderer modules are absent.

- [ ] **Step 4: Implement typed bundled-catalog lookup and fixed URL derivation**

Create `src/renderer/features/whats-new/releaseCatalog.ts`:

```ts
import catalogJson from '../../../../release-notes/releases.json'
import type { LanguageCode } from '../../../shared/types'

export type ReleaseHighlight = { title: string; body: string }
export type ReleaseCopy = { title: string; summary: string; items: ReleaseHighlight[] }
type ReleaseCatalog = {
  schemaVersion: 1
  releases: Record<string, Record<LanguageCode, ReleaseCopy>>
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const catalog = catalogJson as ReleaseCatalog

export function getReleaseCopy(version: string, language: LanguageCode): ReleaseCopy | undefined {
  return catalog.releases[version]?.[language]
}

export function releaseTagUrl(version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`release version must be canonical: ${version}`)
  }
  return `https://github.com/graseeel/verboo_app/releases/tag/v${version}`
}
```

- [ ] **Step 5: Add generic localized labels**

Add to the English map in `src/renderer/i18n.tsx`:

```ts
'whatsNew.eyebrow': "What's new",
'whatsNew.openFailed': 'Could not open the release page. Try again.',
'whatsNew.persistenceFailed': 'The app could not remember this acknowledgment. The update notes may appear again next time.',
'whatsNew.preview': 'Preview',
```

Add to the Portuguese map:

```ts
'whatsNew.eyebrow': 'Novidades',
'whatsNew.openFailed': 'Não foi possível abrir a página da versão. Tente novamente.',
'whatsNew.persistenceFailed': 'O app não conseguiu salvar esta confirmação. As novidades podem aparecer novamente na próxima vez.',
'whatsNew.preview': 'Prévia',
```

Reuse existing `access.learnMore` and `common.close` for the two actions.

- [ ] **Step 6: Implement the modal with focus ownership and ordered async actions**

Create `src/renderer/features/whats-new/WhatsNewModal.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { WhatsNewAcknowledgeResult, WhatsNewStatus } from '../../../shared/types'
import { useI18n } from '../../i18n'
import { getReleaseCopy, releaseTagUrl } from './releaseCatalog'

type WhatsNewModalProps = {
  status: WhatsNewStatus
  onAcknowledge: (version: string) => Promise<WhatsNewAcknowledgeResult>
  onDismiss: (result: WhatsNewAcknowledgeResult) => void
  openReleaseUrl?: (url: string) => Promise<void>
}

export function WhatsNewModal({
  status,
  onAcknowledge,
  onDismiss,
  openReleaseUrl = openUrl,
}: WhatsNewModalProps) {
  const { language } = useI18n()
  const copy = getReleaseCopy(status.version, language)
  if (!copy) {
    console.error(`[verboo:whats-new] no bundled release copy for ${status.version}`)
    return null
  }
  return (
    <WhatsNewDialog
      status={status}
      copy={copy}
      onAcknowledge={onAcknowledge}
      onDismiss={onDismiss}
      openReleaseUrl={openReleaseUrl}
    />
  )
}

type WhatsNewDialogProps = Omit<WhatsNewModalProps, 'openReleaseUrl'> & {
  copy: NonNullable<ReturnType<typeof getReleaseCopy>>
  openReleaseUrl: (url: string) => Promise<void>
}

function WhatsNewDialog({
  status,
  copy,
  onAcknowledge,
  onDismiss,
  openReleaseUrl,
}: WhatsNewDialogProps) {
  const { t } = useI18n()
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const acknowledgeActionRef = useRef<() => Promise<void>>(async () => undefined)
  const [busy, setBusy] = useState(false)
  const [openError, setOpenError] = useState(false)

  async function finishAcknowledgment() {
    try {
      return await onAcknowledge(status.version)
    } catch (error) {
      return {
        persisted: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async function acknowledge() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const result = await finishAcknowledgment()
    onDismiss(result)
  }
  acknowledgeActionRef.current = acknowledge

  async function learnMore() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setOpenError(false)
    try {
      await openReleaseUrl(releaseTagUrl(status.version))
    } catch {
      busyRef.current = false
      setBusy(false)
      setOpenError(true)
      return
    }
    const result = await finishAcknowledgment()
    onDismiss(result)
  }

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
    const inertedElements: HTMLElement[] = []
    let activeBranch: HTMLElement | null = backdropRef.current
    while (activeBranch?.parentElement) {
      const parent = activeBranch.parentElement
      for (const sibling of Array.from(parent.children)) {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) continue
        if (!sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '')
          inertedElements.push(sibling)
        }
      }
      activeBranch = parent
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        void acknowledgeActionRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
      } else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      for (const element of inertedElements) element.removeAttribute('inert')
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return (
    <div ref={backdropRef} className="whats-new-backdrop" data-testid="whats-new-backdrop">
      <section
        ref={dialogRef}
        className="whats-new-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        aria-describedby="whats-new-summary"
      >
        <header className="whats-new-header">
          <span className="whats-new-mark" aria-hidden="true"><Sparkles size={19} /></span>
          <div>
            <span className="whats-new-eyebrow">
              {t('whatsNew.eyebrow')} · v{status.version}
              {status.preview ? ` · ${t('whatsNew.preview')}` : ''}
            </span>
            <h2 id="whats-new-title">{copy.title}</h2>
            <p id="whats-new-summary">{copy.summary}</p>
          </div>
        </header>
        <div className="whats-new-content">
          <ul className="whats-new-list">
            {copy.items.map(item => (
              <li key={item.title}>
                <span aria-hidden="true" />
                <div><strong>{item.title}</strong><p>{item.body}</p></div>
              </li>
            ))}
          </ul>
          {openError && <p className="whats-new-error" role="alert">{t('whatsNew.openFailed')}</p>}
        </div>
        <footer className="whats-new-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => { void learnMore() }}>
            {t('access.learnMore')} <ExternalLink size={15} aria-hidden="true" />
          </button>
          <button ref={closeRef} type="button" className="primary" disabled={busy} onClick={() => { void acknowledge() }}>
            {t('common.close')}
          </button>
        </footer>
      </section>
    </div>
  )
}
```

- [ ] **Step 7: Add the focused visual system and reduced-motion behavior**

Create `src/renderer/styles/whats-new.css`:

```css
.whats-new-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: grid;
  place-items: center;
  padding: clamp(18px, 4vw, 48px);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(10px) saturate(.85);
  animation: whats-new-backdrop-in 180ms ease-out both;
}

.whats-new-modal {
  width: min(760px, 100%);
  max-height: min(760px, calc(100dvh - 36px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
  border-radius: 24px;
  background: color-mix(in srgb, var(--bg-elevated) 96%, var(--accent) 4%);
  box-shadow: 0 30px 90px rgb(0 0 0 / .34), 0 0 0 1px rgb(255 255 255 / .03) inset;
  animation: whats-new-card-in 220ms cubic-bezier(.2, .8, .2, 1) both;
}

.whats-new-header {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 14px;
  padding: 26px 28px 18px;
}

.whats-new-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent);
}

.whats-new-eyebrow {
  display: block;
  margin: 1px 0 7px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.whats-new-header h2 {
  margin: 0;
  color: var(--text);
  font-size: clamp(24px, 3.2vw, 34px);
  line-height: 1.08;
  letter-spacing: -.035em;
}

.whats-new-header p {
  margin: 10px 0 0;
  max-width: 62ch;
  color: var(--text-muted);
  line-height: 1.55;
}

.whats-new-content {
  min-height: 0;
  overflow: auto;
  padding: 4px 28px 22px;
  scrollbar-gutter: stable;
}

.whats-new-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.whats-new-list li {
  display: grid;
  grid-template-columns: 7px 1fr;
  gap: 11px;
  min-width: 0;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  border-radius: 15px;
  background: color-mix(in srgb, var(--bg-soft) 78%, transparent);
}

.whats-new-list li > span {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 58%, transparent);
}

.whats-new-list strong {
  color: var(--text);
  font-size: 13px;
  line-height: 1.35;
}

.whats-new-list p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.whats-new-error {
  margin: 14px 0 0;
  color: var(--danger);
  font-size: 12px;
}

.whats-new-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 28px 22px;
  border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
}

.whats-new-actions button {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 17px;
  border-radius: 12px;
  font-weight: 700;
}

.whats-new-actions .secondary {
  color: var(--text);
  border: 1px solid var(--border-strong);
  background: var(--bg-soft);
}

.whats-new-actions .primary {
  color: white;
  border: 1px solid color-mix(in srgb, var(--accent) 72%, white 28%);
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
}

.whats-new-actions button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.whats-new-actions button:disabled {
  cursor: wait;
  opacity: .68;
}

@keyframes whats-new-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes whats-new-card-in {
  from { opacity: 0; transform: translateY(8px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 680px) {
  .whats-new-list { grid-template-columns: 1fr; }
  .whats-new-header { padding: 22px 20px 16px; }
  .whats-new-content { padding: 4px 20px 18px; }
  .whats-new-actions { padding: 14px 20px 20px; }
}

@media (max-width: 440px) {
  .whats-new-backdrop { padding: 10px; }
  .whats-new-actions { flex-direction: column-reverse; }
  .whats-new-actions button { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .whats-new-backdrop,
  .whats-new-modal {
    animation: none;
  }
}
```

Import it in `src/renderer/styles/app.css` before `responsive.css`:

```css
@import './whats-new.css';
```

- [ ] **Step 8: Run mounted component, CSS, and type checks**

Add one CSS contract assertion to `WhatsNewModal.test.tsx` using `readFileSync` and `resolve`:

```ts
it('removes modal movement when reduced motion is requested', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/whats-new.css'), 'utf8')
  expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.whats-new-modal[\s\S]*animation:\s*none/)
})
```

Run:

```bash
npx vitest run src/renderer/features/whats-new/releaseCatalog.test.ts src/renderer/features/whats-new/WhatsNewModal.test.tsx
npx tsc --noEmit
```

Expected: all focused tests PASS and TypeScript reports no errors.

- [ ] **Step 9: Commit Task 4 only**

```bash
git add src/renderer/features/whats-new/releaseCatalog.ts src/renderer/features/whats-new/releaseCatalog.test.ts src/renderer/features/whats-new/WhatsNewModal.tsx src/renderer/features/whats-new/WhatsNewModal.test.tsx src/renderer/styles/whats-new.css src/renderer/styles/app.css src/renderer/i18n.tsx
git diff --cached --check
git commit -m "feat(ui): add accessible whats-new modal"
```

---

### Task 5: Integrate startup precedence and verify the packaged behavior

**Files:**
- Create: `src/renderer/features/whats-new/useWhatsNew.ts`
- Create: `src/renderer/features/whats-new/useWhatsNew.test.tsx`
- Modify: `src/renderer/App.cliBootstrapGate.test.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: Task 3 bridge functions, Task 4 modal, `configLoaded`, `settingsLoaded`, `updateSnapshot`, `cliBootstrapRequired`, `cliBootstrapSuccessVisible`, and the existing toast service.
- Produces: one startup query after all mandatory blockers, one session dismissal, a non-fatal persistence toast, and mounted proof on login and unlocked app surfaces.

- [ ] **Step 1: Write failing hook lifecycle tests**

Create `src/renderer/features/whats-new/useWhatsNew.test.tsx`:

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WhatsNewAcknowledgeResult } from '../../../shared/types'
import { useWhatsNew } from './useWhatsNew'

const pending = { version: '0.7.0-beta', tag: 'v0.7.0-beta', preview: false }

describe('useWhatsNew', () => {
  it('does not query before startup is ready and queries once after readiness', async () => {
    const getStatus = vi.fn(async () => pending)
    const acknowledge = vi.fn(async () => ({ persisted: true }))
    const { result, rerender } = renderHook(
      ({ enabled }) => useWhatsNew({ enabled, getStatus, acknowledge }),
      { initialProps: { enabled: false } },
    )
    expect(getStatus).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toEqual(pending))
    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it('dismisses for the process even when persistence reports a non-fatal error', async () => {
    const getStatus = vi.fn(async () => pending)
    const acknowledge = vi.fn(async () => ({ persisted: false, error: 'disk unavailable' }))
    const { result } = renderHook(() => useWhatsNew({ enabled: true, getStatus, acknowledge }))
    await waitFor(() => expect(result.current.status).toEqual(pending))
    let response: WhatsNewAcknowledgeResult | undefined
    await act(async () => { response = await result.current.acknowledge('0.7.0-beta') })
    expect(response).toEqual({ persisted: false, error: 'disk unavailable' })
    expect(result.current.status).toBeUndefined()
  })

  it('dismisses for the process even when the bridge rejects unexpectedly', async () => {
    const getStatus = vi.fn(async () => pending)
    const acknowledge = vi.fn(async () => { throw new Error('IPC unavailable') })
    const { result } = renderHook(() => useWhatsNew({ enabled: true, getStatus, acknowledge }))
    await waitFor(() => expect(result.current.status).toEqual(pending))
    await act(async () => {
      await expect(result.current.acknowledge('0.7.0-beta')).rejects.toThrow('IPC unavailable')
    })
    expect(result.current.status).toBeUndefined()
  })
})
```

- [ ] **Step 2: Write a failing mounted App precedence test**

Extend the existing shared-type import in `src/renderer/App.cliBootstrapGate.test.tsx`:

```ts
import type {
  UserSettings,
  UpdateSnapshot,
  WhatsNewAcknowledgeResult,
  WhatsNewStatus,
} from '../shared/types'
```

Add explicit spies to `knownBridge` inside `createBridge()`:

```ts
getWhatsNewStatus: vi.fn<() => Promise<WhatsNewStatus | undefined>>(async () => undefined),
acknowledgeWhatsNew: vi.fn<(version: string) => Promise<WhatsNewAcknowledgeResult>>(
  async () => ({ persisted: true }),
),
```

Add this fixture beside `bootstrapSnapshot`:

```ts
const pendingWhatsNew = {
  version: '0.7.0-beta',
  tag: 'v0.7.0-beta',
  preview: false,
} satisfies WhatsNewStatus
```

Then add these two tests to the existing describe block named `App first CLI installation gate`:

```tsx
it('waits for CLI bootstrap and its success animation before showing release notes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  bridge.getWhatsNewStatus.mockResolvedValue(pendingWhatsNew)
  render(<App />)

  expect(await screen.findByText('Preparing Verboo')).toBeVisible()
  expect(bridge.getWhatsNewStatus).not.toHaveBeenCalled()

  act(() => updateListener?.({
    ...bootstrapSnapshot,
    status: 'idle',
    cliBootstrapRequired: false,
    percent: 100,
  }))
  expect(screen.getByText('Verboo is ready')).toBeVisible()
  expect(bridge.getWhatsNewStatus).not.toHaveBeenCalled()

  await act(async () => { await vi.advanceTimersByTimeAsync(1_400) })
  expect(await screen.findByRole('dialog', { name: 'Verboo Code 0.7.0-beta is here' })).toBeVisible()
  expect(bridge.getWhatsNewStatus).toHaveBeenCalledTimes(1)
})

it('shows on the login surface for a first tagged clean install and closes once', async () => {
  bridge.getUpdateStatus.mockResolvedValue({
    status: 'idle',
    channel: 'beta',
    currentVersion: '0.7.0-beta',
    cliBootstrapRequired: false,
  })
  bridge.getWhatsNewStatus.mockResolvedValue(pendingWhatsNew)
  bridge.acknowledgeWhatsNew.mockResolvedValue({ persisted: true })
  bridge.getCliAuthStatus.mockResolvedValue({ loggedIn: false })
  bridge.getCredentialStatus.mockResolvedValue({ hasApiKey: false })
  bridge.listModels.mockResolvedValue({ models: [], source: 'none', stale: false })
  render(<App />)

  expect(await screen.findByRole('dialog')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(bridge.acknowledgeWhatsNew).toHaveBeenCalledWith('0.7.0-beta'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run the hook and App tests and confirm the expected red state**

Run:

```bash
npx vitest run src/renderer/features/whats-new/useWhatsNew.test.tsx src/renderer/App.cliBootstrapGate.test.tsx
```

Expected: FAIL because the hook is absent and `App` never mounts the modal.

- [ ] **Step 4: Implement the one-shot lifecycle hook**

Create `src/renderer/features/whats-new/useWhatsNew.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WhatsNewAcknowledgeResult, WhatsNewStatus } from '../../../shared/types'

type UseWhatsNewOptions = {
  enabled: boolean
  getStatus?: () => Promise<WhatsNewStatus | undefined>
  acknowledge?: (version: string) => Promise<WhatsNewAcknowledgeResult>
}

export function useWhatsNew({
  enabled,
  getStatus = window.verboo.getWhatsNewStatus,
  acknowledge = window.verboo.acknowledgeWhatsNew,
}: UseWhatsNewOptions) {
  const [status, setStatus] = useState<WhatsNewStatus | undefined>()
  const requested = useRef(false)

  useEffect(() => {
    if (!enabled || requested.current) return
    requested.current = true
    let active = true
    void getStatus()
      .then(next => { if (active) setStatus(next) })
      .catch(error => console.error('[verboo:whats-new] failed to read release state', error))
    return () => { active = false }
  }, [enabled, getStatus])

  const acknowledgeCurrent = useCallback(async (version: string) => {
    try {
      return await acknowledge(version)
    } finally {
      setStatus(undefined)
    }
  }, [acknowledge])

  return { status, acknowledge: acknowledgeCurrent }
}
```

- [ ] **Step 5: Wire readiness and render the modal on both App surfaces**

Import in `src/renderer/App.tsx`:

```ts
import { WhatsNewModal } from './features/whats-new/WhatsNewModal'
import { useWhatsNew } from './features/whats-new/useWhatsNew'
```

After `cliAgentActionsBlocked` is computed, add:

```ts
const whatsNewReady = configLoaded
  && settingsLoaded
  && updateSnapshot !== undefined
  && !cliBootstrapRequired
  && !cliBootstrapSuccessVisible
const whatsNew = useWhatsNew({ enabled: whatsNewReady })

function whatsNewOverlay() {
  if (!whatsNew.status) return null
  return (
    <WhatsNewModal
      status={whatsNew.status}
      onAcknowledge={whatsNew.acknowledge}
      onDismiss={result => {
        if (result.error) toast(t('whatsNew.persistenceFailed'), 'error')
      }}
    />
  )
}
```

Inside the `shouldShowLogin` return, place the overlay after `FeedbackDialog` and inside the existing `I18nProvider`:

```tsx
{whatsNewOverlay()}
```

Inside the unlocked app return, place the same call as the last child inside `I18nProvider`, after all normal dialogs/panels:

```tsx
{whatsNewOverlay()}
```

Do not mount it inside `CliBootstrapGate`, the sidebar updater card, Settings, or a conversation component.

- [ ] **Step 6: Run focused mounted behavior tests**

Run:

```bash
npx vitest run src/renderer/features/whats-new/releaseCatalog.test.ts src/renderer/features/whats-new/WhatsNewModal.test.tsx src/renderer/features/whats-new/useWhatsNew.test.tsx src/renderer/App.cliBootstrapGate.test.tsx
```

Expected: all focused tests PASS; the mutation “query while `cliBootstrapRequired` is true” makes the precedence test fail.

- [ ] **Step 7: Run complete automated gates**

Run:

```bash
node --test scripts/release/release-catalog.test.mjs scripts/release/prepare-release.test.mjs scripts/verify/update-manifest.test.mjs scripts/verify/verify-release-version.test.mjs scripts/verify/tauri-release-signing.test.mjs scripts/verify/cli-update-ownership.test.mjs
npx tsc --noEmit
npx vitest run
cargo +1.89.0 test --manifest-path src-tauri/Cargo.toml --lib
npm run build:renderer
scripts/verify/browser-windows-check.sh
git diff --check
```

Expected:

- all Node release contracts PASS;
- all Vitest tests PASS;
- all Rust library tests PASS with only pre-existing documented ignores;
- renderer production build completes;
- the existing Windows cross-check passes;
- no whitespace errors are reported.

If the Windows cross-check cannot run because its documented toolchain bootstrap fails outside the codebase, record that exact environmental limitation and rely on the unchanged `ci-verify.yml` Windows/Linux matrix before merge; do not claim local Windows graphical QA.

- [ ] **Step 8: Build and inspect a stamped macOS artifact**

Build the same release contract used by GitHub Actions:

```bash
VERBOO_RELEASE_TAG=v0.7.0-beta npm run tauri:build
```

Expected: a current `Verboo Code.app` and DMG are produced for the host architecture, and the compiled app contains the matching tag contract.

Record sizes without changing artifacts:

```bash
du -sh src-tauri/target/release/bundle/macos/Verboo\ Code.app
find src-tauri/target/release/bundle/dmg -maxdepth 1 -type f -name '*.dmg' -exec ls -lh {} \;
```

- [ ] **Step 9: Perform packaged behavioral QA without losing the user's acknowledgment state**

Resolve the app-data path for identifier `ai.verboo.code.desktop`, move only the release-state file into an isolated backup, and restore it after QA:

```bash
QA_BACKUP_DIR=$(mktemp -d)
QA_STATE_DIR="$HOME/Library/Application Support/ai.verboo.code.desktop"
QA_STATE_FILE="$QA_STATE_DIR/release-state.json"
mkdir -p "$QA_STATE_DIR"
if [ -f "$QA_STATE_FILE" ]; then
  mv "$QA_STATE_FILE" "$QA_BACKUP_DIR/release-state.json"
fi
open "src-tauri/target/release/bundle/macos/Verboo Code.app"
```

Manually verify in the packaged app:

1. `0.7.0-beta` appears centered after mandatory bootstrap finishes.
2. Portuguese and English follow the current app language.
3. Six highlights are present; the iOS Simulator item says macOS.
4. Background interaction is blocked, focus begins on Close, focus loops, and backdrop click does nothing.
5. Learn more opens exactly tag `v0.7.0-beta`.
6. Close unlocks the app; relaunching the same artifact does not repeat.
7. Short-window resizing keeps the action row reachable and scrolls only content.
8. `VERBOO_WHATS_NEW_PREVIEW=1 npm run tauri:dev` shows a Preview marker and does not modify `release-state.json`.

After closing the app, preserve the QA-generated record as evidence and restore the prior user record if it existed:

```bash
if [ -f "$QA_STATE_FILE" ]; then
  mv "$QA_STATE_FILE" "$QA_BACKUP_DIR/qa-release-state.json"
fi
if [ -f "$QA_BACKUP_DIR/release-state.json" ]; then
  mv "$QA_BACKUP_DIR/release-state.json" "$QA_STATE_FILE"
fi
ls -l "$QA_BACKUP_DIR"
```

Do not delete the backup directory until the QA result has been reported and the user confirms it is no longer needed.

- [ ] **Step 10: Inspect scope and commit Task 5 only**

Before committing:

```bash
git status --short
git diff --stat
git diff -- src/renderer/App.tsx src/renderer/App.cliBootstrapGate.test.tsx src/renderer/features/whats-new/useWhatsNew.ts src/renderer/features/whats-new/useWhatsNew.test.tsx
git diff --check
```

Then commit:

```bash
git add src/renderer/App.tsx src/renderer/App.cliBootstrapGate.test.tsx src/renderer/features/whats-new/useWhatsNew.ts src/renderer/features/whats-new/useWhatsNew.test.tsx
git commit -m "feat(app): show release notes once per version"
```

- [ ] **Step 11: Final review before any push or merge**

Run:

```bash
git status --short --branch
git log --oneline --decorate -8
git diff origin/dev...HEAD --stat
git diff origin/dev...HEAD --check
rg -n "EDITORIAL_COPY_REQUIRED|This beta brings a macOS embedded browser" release-notes scripts .github src
```

Expected:

- only the approved design/plan commits and five implementation commits are ahead of `origin/dev`;
- no unrelated dirty files remain;
- the first search matches only the intentional sentinel constant and its tests, never the `0.7.0-beta` catalog or workflow;
- the stale inline release sentence has no match;
- no push, squash, merge, or tag has occurred.

At handoff, report separately:

- macOS packaged behavioral results;
- automated renderer/Rust/release-script results;
- Windows cross-check result;
- Windows/Linux graphical packaged QA not performed locally;
- exact `.app` and DMG sizes;
- the app path ready for user testing.
