# Versioned What's New Modal Design

**Date:** 2026-08-11

**Target version:** `0.7.0-beta`

**Status:** Approved design; implementation pending

**Platforms:** macOS, Windows, and Linux

## Summary

Every tagged Verboo Code release displays one localized What's New modal the
first time that version runs in a user profile. This applies equally to a clean
installation, an installer downloaded directly from the repository release,
and an update installed by the in-app updater. Recognizing the modal suppresses
it for the same version. Installing a later tagged app version makes the modal
eligible again.

The modal is app-release UI. A CLI-only update never triggers it and cannot
write its state. Local development builds do not consume the recognition state
for a tagged distribution build.

Release copy lives in one versioned, bilingual catalog used by both the
renderer and the release workflow. Future version preparation scaffolds a new
catalog entry, while release verification rejects missing, incomplete, stale,
or mismatched entries.

## Goals

1. Show the current tagged app release once per user profile.
2. Cover clean installs, direct repository downloads, and in-app updates with
   the same rule.
3. Never trigger from a CLI-only update, a same-version relaunch, or a
   downgrade.
4. Keep release copy available offline in Portuguese and English.
5. Open the exact repository tag from a fixed, validated URL.
6. Make future bumps require release copy without requiring modal code changes.
7. Remain accessible, responsive, and visually consistent with the app.

## Non-goals

- Fetching or rendering arbitrary GitHub release Markdown at app startup.
- Generating product claims automatically from commit messages.
- Showing an archive of previous release notes inside the app.
- Showing one modal per skipped intermediate version.
- Coupling recognition state to the CLI updater or CLI installation state.
- Calling a tagged repository artifact an official Verboo product in the UI.

## Chosen behavior

The eligibility question is:

> Has this user profile already recognized this tagged app version?

The source of installation does not matter.

| Scenario | Result |
| --- | --- |
| First launch of `0.7.0-beta` after in-app update | Show |
| First launch of `0.7.0-beta` from a direct download | Show |
| First launch of a clean `0.7.0-beta` install | Show |
| Relaunch after recognizing `0.7.0-beta` | Do not show |
| Install a later tagged app version | Show that current version once |
| Skip one or more app versions | Show only the installed current version |
| Install an older version than the recognized version | Do not show |
| Update only the Verboo CLI | Do not show |
| Clear all app data manually | Treat as a new profile and show again |

Closing the process while the modal is still pending does not recognize the
release. The modal appears again on the next launch.

## Tagged build contract

The release workflow sets a compile-time repository tag for every distributed
artifact. The tag must be exactly `v<package-version>`. The lifecycle service
enables automatic What's New eligibility only when this build tag is present
and matches the packaged app version.

This contract has two effects:

- artifacts produced by the tagged release workflow show the modal regardless
  of whether they arrived through the updater or a direct download;
- ordinary local builds do not acknowledge or suppress the future tagged
  release with the same semantic version.

Local QA uses an explicit preview environment switch. Preview mode presents
the current catalog entry but never writes release recognition state. Tests
inject the same preview contract rather than pretending a development build is
a distributed release.

The UI does not describe the build as official, independent, or a development
edition. The tag is an internal lifecycle assertion only.

## Persistent lifecycle state

The Rust lifecycle layer owns a small app-data file named
`release-state.json`:

```json
{
  "schemaVersion": 1,
  "acknowledgedVersion": "0.7.0-beta"
}
```

The state belongs to the desktop app. It is stored outside the app bundle so
normal updates preserve it, and outside every CLI-owned directory so the app
and CLI updaters remain independent.

On startup the service:

1. validates the embedded release tag against the running package version;
2. loads and validates the state file;
3. compares the current and acknowledged versions as semantic versions;
4. returns the current version and tag only when the current version is
   eligible.

No acknowledged version means the current tagged version is eligible. An equal
or newer acknowledged version suppresses the modal. A newer current version is
eligible.

Recognition writes a temporary file in the same app-data directory and renames
it atomically. A corrupt record fails safely: the service logs a diagnostic,
repairs the record to the current version, and does not show a potentially
repeated modal. A persistence failure must never trap the user in the modal;
the modal closes for the current process, reports the non-fatal failure, and
may reappear on the next launch.

## Release catalog and bump automation

A repository-level JSON catalog is the single content source. Its schema is:

```text
schemaVersion
releases
  <app-version>
    pt-BR
      title
      summary
      items[]
        title
        body
    en-US
      title
      summary
      items[]
        title
        body
```

The tag URL is not editable catalog content. It is derived from the validated
version as:

```text
https://github.com/graseeel/verboo_app/releases/tag/v<app-version>
```

This prevents release copy from injecting an arbitrary external destination.

A release-preparation command accepts the next app version and scaffolds its
catalog entry. It does not invent highlights from Git history. The author or
release agent fills the bilingual editorial copy and reviews the product
claims.

Release verification requires:

- the tag, `package.json`, `Cargo.toml`, and `tauri.conf.json` versions to
  match;
- a catalog entry for that exact version;
- both `pt-BR` and `en-US` content;
- non-empty title and summary values;
- four to six complete highlight items per locale;
- no placeholder markers; and
- a valid `v<version>` repository tag.

The release workflow reads the same entry to generate the GitHub release body
and the updater manifest summary. This removes the currently duplicated,
version-stale release text from the workflow. Adding a future version therefore
requires editorial content, but modal display, tag routing, one-time behavior,
and workflow formatting remain automatic.

## Modal presentation

The modal mounts only after mandatory startup and CLI-bootstrap blockers are
resolved. It overlays whichever app surface is otherwise active.

Presentation:

- a full-window dimmed and softly blurred backdrop;
- a centered, responsive card with the current version, title, summary, and
  four to six highlights;
- a bounded scroll region on short windows;
- exactly two visible actions: **Learn more / Saiba mais** and
  **Close / Fechar**;
- a short opacity-and-scale entrance using the existing motion language; and
- a reduced-motion path without scale movement.

There is no close icon. Backdrop clicks do not dismiss the modal accidentally.
Escape is equivalent to Close.

Learn more opens the exact derived tag URL in the system browser. A successful
open recognizes the version and closes the modal. If opening fails, the modal
stays open and shows a recoverable error. Close recognizes the version and
releases the app immediately.

Accessibility requirements:

- `role="dialog"`, `aria-modal="true"`, and labelled title/description;
- focus moves into the modal and starts on Close;
- Tab and Shift+Tab remain inside the modal;
- the background is inert while open;
- focus returns to its prior owner after close when that owner still exists;
- all content and action labels follow the current app locale; and
- contrast, scrolling, and keyboard behavior work at supported window sizes.

## Startup and overlay precedence

The modal must not compete with the managed Node/CLI bootstrap gate. Startup
order is:

1. hydrate app configuration and settings;
2. resolve mandatory runtime/CLI preparation;
3. evaluate the pending tagged release;
4. show What's New before normal interactive modals.

What's New blocks pointer and keyboard interaction with the app while visible,
but it does not start, cancel, or alter background update operations. It does
not emit an updater snapshot and does not share state with the sidebar update
card.

## Approved `0.7.0-beta` content

### Português (Brasil)

**Title:** O Verboo Code 0.7.0-beta chegou

**Summary:** Uma grande atualização para trabalhar com apps iOS, provedores
externos e uma instalação mais leve.

1. **Simulador de iOS integrado — macOS**

   Abra iPhones e iPads ao lado da conversa, interaja com o app, use controles
   do sistema e envie seleções ao chat.
2. **Várias contas Claude e Codex**

   Conecte contas adicionais, escolha qual conta cada conversa utiliza e
   preserve o histórico visível ao trocar.
3. **Planos e limites no lugar certo**

   Consulte o plano, as janelas de uso e os horários de renovação diretamente
   em Provedores.
4. **Atualizações independentes do CLI**

   O app e o CLI agora podem receber atualizações assinadas separadamente,
   mantendo um único fluxo seguro de reinicialização.
5. **Instalação muito mais leve**

   O Node é baixado e verificado pelo próprio app no primeiro uso, sem depender
   do Node do sistema e sem criar um aplicativo auxiliar no Dock.
6. **Uma experiência mais fluida**

   Carregamento paralelo de provedores, login mais robusto e transições
   discretas deixam a inicialização mais agradável.

### English (United States)

**Title:** Verboo Code 0.7.0-beta is here

**Summary:** A major update for working with iOS apps, external providers, and
a lighter installation.

1. **Built-in iOS Simulator — macOS**

   Open iPhones and iPads beside the conversation, interact with your app, use
   system controls, and send selections to chat.
2. **Multiple Claude and Codex accounts**

   Connect additional accounts, choose which account each conversation uses,
   and keep the visible history when switching.
3. **Plans and limits where you need them**

   See your plan, usage windows, and reset times directly in Providers.
4. **Independent CLI updates**

   The app and CLI can now receive signed updates separately while sharing one
   safe restart flow.
5. **A much lighter installation**

   Node is downloaded and verified by the app on first use, without relying on
   system Node or creating a helper app in the Dock.
6. **A smoother experience**

   Parallel provider loading, more reliable sign-in, and subtle transitions
   make startup feel better.

## Error handling

- Missing catalog content does not render an empty modal. Verification blocks
  this condition in a tagged release; a local mismatch logs a diagnostic.
- A malformed or mismatched embedded tag disables automatic presentation.
- Failure to open Learn more keeps the modal available and does not
  acknowledge the version.
- Failure to persist Close never blocks access to the app.
- Unknown future state fields are ignored; an unsupported state schema fails
  safely without repeatedly interrupting startup.

## Verification

### Native lifecycle tests

- no record plus tagged build shows the current version;
- the same acknowledged version does not show;
- a higher current semantic version shows;
- a downgrade does not show;
- an absent or mismatched build tag does not show;
- preview mode shows without writing;
- recognition survives a new service instance;
- corrupt state fails safely without repetition; and
- CLI update state cannot affect eligibility.

### Mounted renderer tests

- the modal renders the current locale and version;
- the background is inert and focus is trapped;
- Escape and Close acknowledge and dismiss;
- a backdrop click does not dismiss;
- Learn more opens the exact tag and acknowledges only after success;
- an opener failure remains visible and recoverable;
- reduced motion removes scale movement;
- a short viewport scrolls the content while keeping actions reachable; and
- the CLI bootstrap gate wins overlay precedence.

### Release-contract tests

- the current package version has complete PT/EN catalog content;
- the release workflow embeds the matching tag;
- the GitHub body and updater summary are generated from the catalog;
- stale hardcoded release highlights are absent from the workflow; and
- release preparation scaffolds a new entry but verification rejects unfilled
  placeholders.

### Packaged behavioral QA

Build the app with an isolated profile and the tagged-release contract:

1. first launch shows `0.7.0-beta`;
2. direct Close unlocks the app;
3. relaunch does not repeat the modal;
4. deleting only the process and reinstalling the same artifact preserves the
   recognition record;
5. preview mode shows without changing the record; and
6. a fixture-level newer version becomes eligible again.

Run the renderer, Rust, release-script, and cross-platform compile gates. The
packaged UI is exercised locally on macOS. Windows and Linux receive the same
state-machine and renderer coverage plus their existing CI build gates; the
handoff must state that real graphical packaged QA on those two operating
systems was not performed locally.

## Alternatives considered

### Renderer-only `localStorage`

Rejected as the primary authority. It is easy to implement but can be cleared
or partitioned with WebView data, has weaker atomicity, and makes release state
less explicit than an app-owned lifecycle record.

### Updater installation receipt

Rejected as the eligibility source. It covers only in-app updates and misses
clean installations and installers downloaded directly from the repository.

### Fetch GitHub release notes at startup

Rejected. It adds a network dependency, rate-limit and offline behavior,
untrusted Markdown rendering, and single-language content to a startup path.

### Generate highlights from commit history

Rejected. Commit history is implementation-oriented and may include incomplete
or internal work. Release claims remain editorial, reviewed, and bilingual.
