# Helium browser: architecture and build research (for a Zen-style Chromium fork)

Researched 2026-10-05 from shallow clones of `imputnet/helium` (HEAD `860a42de`, 2026-10-03), `imputnet/helium-macos` (HEAD `95911fb3`, 2026-10-02), `imputnet/helium-linux`, the `helium-windows` file listing, the Chromium GitHub mirror at tag `154.0.8037.97`, and the issue trackers.

---

## 0. TL;DR

| Item | Value |
|---|---|
| Chromium version tracked | **154.0.8037.97** (`helium/chromium_version.txt`). Chrome Mac stable on 2026-10-02 was 154.0.8037.98, so Helium is current. |
| Helium version | **0.18.3.1**, built from `version.txt`=0, chromium major − 136 = 18, `revision.txt`=3, platform `revision.txt`=1 |
| Base | A fork of **ungoogled-chromium**. The repo still merges u-c upstream (`merge: update ungoogled-chromium to …`). |
| Patch system | **quilt** patch series (`patches/series`, 345 patches) applied to a stock Chromium tarball or clone |
| macOS repo | `helium-macos` pulls in the main repo as a **git submodule** at `helium-chromium/` |
| Build tool | **Siso** via `autoninja`, with `use_siso=true`. System ninja is not used. Toolchain (clang, rust, node, gn, siso, go, esbuild, tsc) comes from Chromium's own scripts and CIPD. |
| Dev build | `source dev.sh && he setup && he build && he run`. The app is at `build/src/out/Default/Helium.app`. |
| Release build | `./build.sh [-d] [arm64]`. Produces `build/helium_154.0.8037.97-3.1_macos.dmg`. |
| Already in Helium | Layouts (Classic / Compact / **Vertical** / Dynamic), **Zen mode** (auto-hide chrome), centered/minimal address bar, split view (side-by-side plus stacked), bundled **uBlock Origin as an MV2 component extension**, the `helium://` scheme, custom keyboard shortcuts, native macOS frame materials, rounded frame |
| Chromium-native features in m154 | Vertical tabs **fully launched** (flags removed). Side-by-side split **launched**; stacked split behind `split-view-horizontal`. **Tab Groups Focusing** (`tab-groups-focusing`) works with a two-finger swipe between groups in the vertical tab strip, which is a ready-made "Spaces" primitive. |
| License | Helium-original code is GPL-3.0. Imported u-c code is BSD-3, Chromium is BSD-3, Brave patches are MPL-2.0, uBlock is GPL-3.0. In practice your distributed fork is GPL-3.0. |

---

## 1. Repository architecture

### 1.1 Main repo `imputnet/helium` (shared patches and tooling)

```
helium/
├── chromium_version.txt     # "154.0.8037.97": the Chromium tag to fetch
├── revision.txt             # Helium patch revision for this Chromium version (3)
├── version.txt              # Helium "major" (0)
├── downloads.ini            # Chromium source tarball (chromium-<ver>-lite.tar.xz from commondatastorage)
├── deps.ini                 # Extra downloads unpacked into the tree after fetch:
│                            #   search_engines_data (helium-nonfree-assets), onboarding page
│                            #   (helium-onboarding release), uBlock Origin 1.75.0 (imputnet/uBlock fork)
├── flags.gn                 # Common GN args (no Google API keys, safe_browsing_mode=0,
│                            #   enable_widevine=true, treat_warnings_as_errors=false, ...)
├── patches/
│   ├── series               # Ordered quilt series (345 entries)
│   ├── upstream-fixes/      # Backports of Chromium fixes (1: missing-dependencies.patch)
│   ├── ungoogled-chromium/  # 71: de-Googling, MV2 keep-alive, many chrome://flags additions
│   ├── inox-patchset/  iridium-browser/  bromite/  debian/   # Small numbers of vendor patches
│   ├── brave/               # 4: importer, MRU tab cycling (MPL-2.0)
│   └── helium/
│       ├── core/            # 124 incl. subdirs: search/, sync/ (private "sync vault"), noise/
│       │                    #   (fingerprint noise), network/; uBlock, branding, helium:// scheme,
│       │                    #   flags, keyboard shortcuts, importers (Arc, Zen), etc.
│       ├── settings/        # 26: settings WebUI changes
│       ├── hop/             # 2: "Helium Opinionated Policy" provider (default policies)
│       └── ui/              # 104: visual changes; ui/layout/ (20) holds the layout system
├── domain_regex.list        # Regex pairs that rewrite Google and other domains to *.qjz9zk
├── domain_substitution.list # ~17.6k source files the domain regexes are applied to
├── pruning.list             # ~14k prebuilt binaries/test data deleted from the tarball
├── resources/
│   ├── branding/            # app_icon/raw.png, product_logo.{png,svg,icon}, mono/white variants
│   ├── favicons/            # Internal-page favicons
│   ├── generate_resources.txt   # "input size output": resized PNG generation
│   └── helium_resources.txt     # "src dst": copies branding into chrome/app/theme/chromium/... etc.
├── i18n/                    # Helium's own translations (applied by utils/i18n_apply.py)
├── utils/                   # Build-time scripts (all Python):
│   ├── clone.py             #   git clone of chromium/src at the tag, plus gclient sync --no-history,
│   │                        #   PGO profiles, LASTCHANGE, gn bootstrap (used when the tarball is missing)
│   ├── downloads.py         #   retrieve/unpack for downloads.ini and deps.ini
│   ├── prune_binaries.py    #   applies pruning.list
│   ├── patches.py           #   apply/merge quilt series (uses `patch`)
│   ├── domain_substitution.py
│   ├── name_substitution.py + name_substitution_utils.py   # Chrome/Chromium -> Helium in .grd/.xtb
│   ├── i18n_apply.py
│   ├── helium_version.py    #   appends HELIUM_MAJOR/MINOR/PATCH/PLATFORM to chrome/VERSION
│   ├── generate_resources.py / replace_resources.py
│   └── install_cipd_deps.py #   fetches gn, siso, typescript, dawn's Go, devtools esbuild from DEPS via CIPD
└── devutils/                # Dev scripts: validate_config/patches, update_platform_patches.py
                             #   (merge/unmerge), update_lists.py, i18n tooling, set_quilt_vars.sh, linters
```

Patches are quilt-format unified diffs (`--- a/… +++ b/…`, no git headers). Vendor directories exist so you can tell where each patch came from. New Helium-authored files carry a header that says "Copyright 20xx The Helium Authors … GPL-3.0". Commit scope style: `helium/ui/layout: …`, `merge: update to chromium …`.

Directories Helium creates inside the Chromium tree: `chrome/browser/ui/helium/` (layout state controller), `chrome/browser/ui/views/helium/` (frame corner radius, native frame materials), `chrome/browser/ui/browser_shortcuts/` (custom shortcuts service), `components/helium_services/`, `components/sync/engine/sync_vault/`, `chrome/browser/sync/private_sync/`, `third_party/blink/renderer/core/helium_noise/`, `third_party/ublock/`, `components/extstore_fixups/`, `chrome/browser/ui/webui/onboarding/`.

### 1.2 Platform repo `imputnet/helium-macos`

```
helium-macos/
├── helium-chromium/         # git SUBMODULE -> imputnet/helium (pinned to 57a40ad = "revision: bump to 3")
├── build.sh                 # Release build entry point
├── dev.sh                   # `source dev.sh` defines the `he` dev command
├── env.sh                   # Paths: build/src, build/src/out/Default, build/download_cache, ...
├── sign_and_package_app.sh  # Sign (Chromium sign_chrome.py plus notarytool, or ad-hoc) then pkg-dmg
├── retrieve_and_unpack_resource.sh  # -g: source plus deps; -d: tarball instead of clone; -t: toolchain
├── flags.macos.gn           # is_official_build=true, use_siso=true, symbol_level=1, enable_rust, ...
├── downloads.ini            # Sparkle 2.10.0 source (third_party/sparkle)
├── revision.txt             # Platform revision (1)
├── patches/
│   ├── series               # 24 macOS patches (applied AFTER the main series)
│   ├── helium/macos/        # Product dir name, keychain name, signing, main menu, immersive
│   │                        #   fullscreen, AppleScript, updater/ (Sparkle 2), resize jank, ...
│   ├── rebel/macos/sparkle-integration.patch
│   └── ungoogled-chromium/macos/  # fix-disabling-safebrowsing, fix-dsymutil, no-unknown-warnings
├── resources/
│   ├── assets/              # AppIcon.icon (macOS 26+/27 Icon Composer), Assets.car, app.icns, ...
│   ├── platform_resources.txt   # Assets.car and app.icns -> chrome/app/theme/chromium/mac/
│   └── dmg_background.png, dmg_dsstore, dmg.json
├── devutils/
│   ├── shared.sh            # Shared functions: prepare_sources, write_gn_args, configure_build, helium_build
│   ├── build_tools.sh       # CIPD deps install and siso configure
│   ├── update_patches.sh    # Wraps helium-chromium/devutils/update_platform_patches.py merge|unmerge
│   └── set_quilt_vars.sh    # QUILT_PATCHES=helium-macos/patches, QUILT_SERIES=series.merged
├── docs/building.md
└── .github/                 # CI: Xcode 26, Python 3.13, sccache, multi-phase builds under 6h job limits
```

How the main repo is consumed:

* `prepare_sources` (release) applies `helium-chromium/patches` and then `helium-macos/patches` with `utils/patches.py apply`. It then runs domain substitution, name substitution, i18n, versioning and resources.
* For development, `he merge` (`update_platform_patches.py merge`) copies the main repo's patches into `helium-macos/patches/` and writes `series.merged` (main series first, platform series after) so one quilt stack covers both. `he unmerge` moves patches back. Patches that sit before the platform block (including new ones you add there) go back to the submodule's `patches/`. Patches after it stay in the platform repo.
* `helium-linux` and `helium-windows` use the same submodule pattern (`helium-chromium` → `imputnet/helium`).

### 1.3 Pipeline order (`devutils/shared.sh: prepare_sources`)

1. `rm -rf build/src/out`, then fetch the source. Release `build.sh` defaults to `utils/clone.py -p mac-arm` (git clone plus gclient, with PGO profiles). `build.sh -d` downloads the `-lite` tarball instead. `downloads.ini` (Sparkle) and `deps.ini` (uBlock, onboarding, search data) are also fetched and unpacked.
2. `prune_binaries.py` with `pruning.list`.
3. Toolchain (`retrieve_and_unpack_resource.sh -t`): `tools/rust/update_rust.py`, `tools/clang/scripts/update.py --package clang|objdump|clang-tidy|libclang`, `third_party/node/update_node_binaries` (node-darwin-arm64 is moved into `third_party/node/mac_arm64`).
4. `patches.py apply` (main, then platform).
5. `domain_substitution.py apply`, then `name_substitution.py --sub`, then `i18n_apply.py`, then `helium_version.py`.
6. Resources: `generate_resources.py`, then `replace_resources.py` for the platform resources and the Helium resources.
7. `write_gn_args`: concatenates `flags.gn` + `flags.macos.gn` + `target_cpu`, and adds a cc_wrapper (sccache or ccache if found). For PGO it adds `chrome_pgo_phase=2`. Then `install_cipd_deps.py`, `configure_siso.py`, and `gn gen out/Default --fail-on-unused-args`.
8. `autoninja -C out/Default chrome chromedriver chrome/installer/mac`, then `sign_and_package_app.sh`.

---

## 2. macOS build: exact steps

### 2.1 Prerequisites (from `docs/building.md` and the CI scripts)

* macOS 12+ (docs), **Xcode 26** (docs and CI; `github_prepare_xcode.sh` hard-codes `/Applications/Xcode_26.app`), Homebrew, Perl (for the dmg).
* Python 3. Docs: `brew install python@3.13`. CI uses 3.13. `.python-version` in the main repo is 3.10 (the minimum).
  * `pip3 install httplib2==0.22.0 requests pillow` (add `--break-system-packages` if this is not a venv).
* **Metal toolchain**: `xcodebuild -downloadComponent MetalToolchain`. Xcode 26+ no longer bundles it. Re-run this after every Xcode install or update.
* `brew install wget coreutils readline` (the scripts use `greadlink`). `brew unlink binutils` so Xcode's tools are used.
* For development: `brew install quilt`. Optional: `sccache` or `ccache` (picked up automatically), `llvm` (for `he tidy`), `gnu-sed` (`gsed`, also used by `he tidy`).
* **You do not install** depot_tools, ninja, node, gn, rust or clang. They come from the Chromium tree, CIPD and Chromium's update scripts. Dawn's Go toolchain, siso, gn, tsc and devtools esbuild are fetched by `utils/install_cipd_deps.py`.
* Open Xcode once (license, first-launch components) and make sure `xcode-select -p` points at it.
* **Disk**: no official number. Estimate: about 35–45 GB for source plus toolchains, 40–60 GB for a component (dev) `out/`, 25–35 GB for an official `out/`, plus download and sccache caches. **Plan on 150 GB or more free** on an APFS volume, and keep the path free of spaces.

### 2.2 Development build (recommended for feature work)

```sh
git clone --recurse-submodules https://github.com/imputnet/helium-macos.git
cd helium-macos
source dev.sh          # defines `he`, adds a balloon to PS1
he setup               # = presetup + merge + `quilt push -a --refresh` + configure
                       #   presetup: tarball download (falls back to git clone), prune, toolchain,
                       #   resources, dev GN args (is_official_build -> is_component_build,
                       #   devtools_skip_typecheck=false), helium_version
                       #   configure: cipd deps, siso config, `gn gen out/Default --export-compile-commands`
he build               # autoninja -C out/Default chrome chromedriver -k 0   (siso)
he run                 # build/src/out/Default/Helium.app/Contents/MacOS/Helium
                       #   --user-data-dir="$HOME/Library/Application Support/net.imput.helium.dev"
                       #   --enable-ui-devtools --use-mock-keychain --disable-features=DialMediaRouteProvider
```

Notes:
* **The dev setup does NOT apply domain or name substitution.** Strings will say "Chromium" until you run `he sub` (and `he translate` for i18n). Run `he unsub` before refreshing or creating patches so the substitutions don't end up in diffs. The cache lives in `build/subs.tar.gz` and `build/namesubs.tar`.
* Run `he` with no arguments for the full menu: `setup, presetup, configure, resources, sub/unsub, namesub/nameunsub, translate, transgen, merge/unmerge, push/pop, pull, validate config|patches|series, format, tidy, lint, build, run, reset`.
* `he reset` deletes `build/src` entirely.

### 2.3 Incremental rebuilds after editing source

Edit files directly in `build/src/` and rebuild. Siso only recompiles what changed.

```sh
# from helium-macos/, with dev.sh sourced
he build                                   # chrome + chromedriver, keeps going on errors (-k 0)

# chrome only, or with extra siso/autoninja flags (e.g. limit parallelism on 24 GB RAM):
./devutils/shared.sh build -j 10           # passes args through to autoninja (targets chrome chromedriver)

# fully manual equivalent:
cd build/src
SISO_PATH="$PWD/third_party/siso/cipd/siso" \
  python3 third_party/depot_tools/autoninja.py -C out/Default chrome
```

* Do **not** run plain `ninja -C out/Default chrome`. `use_siso=true` is set and Helium switched every build path to siso in Sept 2026 (helium-macos #359). `autoninja` sees `use_siso` in args.gn and dispatches to siso.
* After changing `args.gn` or BUILD.gn structure, `he configure` re-runs `gn gen`.
* To make your edits durable, capture them with quilt:
  ```sh
  cd build/src
  quilt new zenium/ui/spaces.patch     # path is relative to helium-macos/patches (merged series)
  quilt add chrome/browser/ui/...      # BEFORE editing
  # edit, he build, he run
  quilt refresh
  he unmerge                           # moves patches back into main repo vs platform repo
  he validate series
  ```
  Use `he pull` to rebase onto upstream: it pops all patches, unmerges, rebases both repos, then merges and pushes again.

### 2.4 Release build

```sh
git clone --recurse-submodules https://github.com/imputnet/helium-macos.git && cd helium-macos
./build.sh            # arm64 default; git clone + PGO (chrome_pgo_phase=2)
./build.sh -d         # use the -lite source tarball instead of git clone (no PGO)
./build.sh x86_64     # cross-build Intel on Apple Silicon
```
* Builds `chrome chromedriver chrome/installer/mac`, then `sign_and_package_app.sh`. Without `MACOS_CERTIFICATE_NAME` it signs ad-hoc (`codesign --force --deep --sign -`).
* Output: `build/src/out/Default/Helium.app` (signed copy in `out/Default/signed/stable/Helium.app` when using a Developer ID). The DMG is `build/helium_<chromium_version>-<revision>.<platform_revision>_macos.dmg`.
* Notarization env vars: `MACOS_CERTIFICATE_NAME`, `PROD_MACOS_NOTARIZATION_APPLE_ID`, `…_TEAM_ID`, `…_PWD`, and optionally `PROD_MACOS_SPECIAL_ENTITLEMENTS_PROFILE_PATH`.
* If a release build fails after download, delete `build/src` (or `build/downloads_cache` for download failures) and re-run. `prepare_sources` is not idempotent because patches are already applied.

### 2.5 Build time on an M5 Pro / 24 GB (estimates, not measured)

* Target counts from user logs: about **57k actions** for the official build and about **74k** for the component dev build.
* Clean component (dev) build: about **2–4 h**. Clean official build with ThinLTO and PGO: about **3–6 h**. The final `Chromium Framework` link in official mode is memory hungry, and 24 GB can swap. If you see memory pressure, use `-j` to lower siso concurrency or prefer component builds day to day. Helium's own CI needs several 6-hour phases on GitHub runners, even with sccache, and "hours" on Depot runners.
* Incremental after a one-file `.cc` change in `chrome/browser/ui/...` (component build): typically about **1–5 min**, mostly linking.
* Fetching: the tarball is a few GB to download and unpack. `clone.py` (gclient `--no-history`) is slower and larger.

### 2.6 Gotchas with Xcode 27 / macOS 27 SDK

* **Chromium m154's official SDK is macOS 26.5** (`build/config/mac/mac_sdk.gni`: `mac_sdk_official_version = "26.5"`, build `25F70`, `mac_deployment_target = "13.0"`, `mac_sdk_min = "15"`). Chromium's docs say a newer SDK "usually works". Helium's CI and maintainers use **Xcode 26.x** (a maintainer builds on macOS 26.6.2). Xcode 27 is not the tested path.
* Xcode 27 broke Chromium's `sandbox/mac/seatbelt.cc` because `kSBXProfilePureComputation` is gone from the macOS 27 SDK. Helium-macos #314 (2026-08-03) backported Chromium CL 8025516 (`main@{#1655528}`). That fix is **upstream in m152+**, so it is not needed for 154. It was dropped from the series in 0.16.1.1, and `kProfilePureComputation` is absent from m154 `seatbelt.h`.
* The same PR added `MACOSX_DEPLOYMENT_TARGET=13.0` to the Sparkle `xcodebuild` invocation (`patches/helium/macos/updater/fixup-sparkle-glue.patch`). That only matters when `enable_sparkle=true` (CI only).
* Xcode 27 **removed ld64 / `-ld_classic`** and raised the minimum macOS deployment target to 12. Chromium links with its own `lld` and its own clang (`third_party/llvm-build`), so this mostly matters for side builds that call `xcodebuild`, such as Sparkle.
* Xcode 27 requires macOS 26.6+ on Apple silicon. You need the Metal toolchain component again for Xcode 27 (`xcodebuild -downloadComponent MetalToolchain`).
* `treat_warnings_as_errors=false` (in `flags.gn`) protects you from new SDK deprecation warnings. If something odd breaks, try a side-by-side Xcode 26.x and point `DEVELOPER_DIR` / `xcode-select` at it to match CI.
* Open build issue to watch: helium-macos **#349** (Sept 2026). The first-time component build fails on `obj/base/base/precompile.h-cc.gch` with "missing 'export module' declaration in module interface unit". Maintainers couldn't reproduce it, and it is unresolved.
* **Python environment**: your `python3` resolves to Anaconda (`~/anaconda3/bin/python3`). The scripts call bare `python3`, so the pip packages must be installed into whatever `python3` is first on PATH. A clean brew `python@3.13` venv is the documented and CI path. (Issue #315 was an Anaconda user hitting a missing-Go Dawn step, which `install_cipd_deps.py` now handles.)

---

## 3. Chromium version

* `helium/chromium_version.txt`: **154.0.8037.97** (merged 2026-10-02, PR #2623). Helium `revision.txt` is 3 and the platform revision is 1, which gives Helium **0.18.3.1**.
* Cadence: Helium follows Chromium stable point releases within about 0–3 days (153.0.8010.36, then .47, then .52, then 154.0.8037.57, then .92, then .97 between Sept and Oct 2026). Each bump is `merge: update ungoogled-chromium to X`, then `patches: refresh for X`, then `revision: reset/bump`.

---

## 4. Helium features relevant to a Zen-style fork

### 4.1 Built-in uBlock Origin (component extension, MV2)

* The source is Helium's fork `imputnet/uBlock`, release `uBlock0_1.75.0.chromium.zip`, pulled in through `deps.ini` and unpacked into `third_party/ublock`. When bumping, the assets must be re-stripped with `devutils/clear-ublock-assets.js`.
* `helium/core/ublock-setup-sources.patch` adds `third_party/ublock/BUILD.gn` plus `generate_file_list.py`. These generate a GRD, compile it with grit (brotli-compressed text assets) into `ublock_resources.pak`, add it to `chrome_paks.gni`, and register it in `chrome_component_extension_resource_manager.cc`. The patched `manifest.json` gets a public `key`, so the ID is fixed.
* `helium/core/ublock-install-as-component.patch` adds `ComponentLoader::AddUBlock()`, which loads `IDR_UBLOCK_MANIFEST_JSON` as a **component extension** and localizes it. It also allowlists the ID **`blockjmkbacgjkknlgpkjjiijinjdanf`** (`components/helium_services/extension_ids.h`; the Web Store ID `cjpalhdlnbpafiamejdnhcphjbkeiagm` is kept for migration). A `ResourceBundle` tweak returns an empty resource instead of nullptr.
* `ungoogled-chromium/extensions-manifestv2.patch` keeps MV2 working.
* `helium/core/ublock-reconfigure-defaults.patch` covers permissions, incognito and management-policy tweaks so a component extension behaves like a user extension.
* `helium/core/ublock-helium-services.patch` routes filter-list updates through Helium services (`services.helium.imput.net`) and adds a settings toggle.
* `helium/core/ublock-dns-uncloaking.patch` adds a `dns` API extension and HostResolver changes for CNAME uncloaking.
* `helium/ui/ublock-show-in-settings.patch` shows it in `chrome://extensions` with special handling.
* A sibling pattern for another bundled component is `helium/core/fixups-component-setup.patch` (`components/extstore_fixups`).

### 4.2 Layout system: vertical tabs, compact, dynamic, Zen mode (`patches/helium/ui/layout/`)

* `layout/core.patch` adds `chrome/browser/ui/helium/helium_layout_state_controller.{h,cc}`, attached per window via `BrowserWindowFeatures` / UnownedUserData. It defines `enum HeliumLayoutType { kClassic, kCompact, kVertical, kDynamic }`, stored in the pref `helium.browser.layout`, plus `helium.browser.vertical_right_aligned`.
  * It **replaces Chromium's `vertical_tabs.enabled` pref** by rewiring `VerticalTabStripStateController` to read `kHeliumLayout`. Expand-on-hover is disabled.
  * **Helium's vertical tabs are Chromium's native vertical tab strip**, restyled and extended.
* `layout/vertical.patch` (1,661 lines) modifies `views/frame/vertical_tab_strip_region_view.*`, `views/tabs/vertical/*` (adds `vertical_new_tab_button.*`), `views/tabs/common/*` (tab_view, tab_strip_view, group header/line), `browser_view_tabbed_layout_impl.cc`, `side_panel.cc` and `tab_menu_model.cc`. It adds right alignment and spacing changes.
* `layout/compact.patch`: tabs go into the toolbar row (single-row UI). It touches `browser_view_tabbed_layout_impl`, `toolbar_view` and `horizontal_tab_strip_region_view`.
* `layout/dynamic.patch`: the horizontal tab strip is hidden while only one tab is open and shown when there are more.
* `layout/zen-mode.patch` (2,453 lines) and `zen-mode-wiring.patch`: **auto-hide browser chrome until hover**. The top toolbar and the vertical sidebar slide in from the edges, with grace timers. Chrome stays visible while the omnibox is focused or a bubble or menu is open, and the caption buttons fade with the toolbar.
  * Prefs: `helium.browser.zen_mode`, `…zen_mode_sidebar_pinned`, `…zen_mode_top_chrome_pinned`. Command: `IDC_TOGGLE_ZEN_MODE_TOP_CHROME_PIN`. There is a "new tab opened" toast in Zen mode.
  * `zen-caption-buttons.patch` handles the mac traffic lights (`browser_frame_view_mac.mm`).
  * macOS-specific: `helium-macos/patches/helium/macos/helium-immersive-fullscreen.patch`.
* Other layout patches:
  * `centered-address-bar.patch`: pref `kHeliumCenteredLocationBar`.
  * `minimal-location-bar.patch`: shows only the origin (`kHeliumMinimalLocationBar`).
  * `toolbar-layout.patch`, `toolbar-overflow.patch` and `toolbar-actions.patch`: responsive toolbar, a sidebar collapse toolbar button, and the `kShowVerticalTabsCollapseButton` / `kShowDynamicNewTabButton` prefs.
  * `shortcuts.patch`: **⌘S toggles vertical tab collapse** (`IDC_CTRL_S_SHORTCUT`, pref `kVerticalCollapseShortcut`).
  * `context-menu.patch`: a layout switcher in the window-frame right-click menu (`IDC_BROWSER_LAYOUT_*`).
  * `settings.patch`: a "Browser layout" dropdown in Appearance.
  * `min-window-width.patch` (400dp), `frame-grab-handle.patch`, `horizontal-tabs.patch`.
* **Compact/minimal UI**: yes. The Compact layout, the minimal location bar and Zen mode together cover it. Related patches: `helium/ui/remove-toolbar-corners`, `remove-toolbar-dividers`, `rounded-frame-corners`, `frame-radius-helper`, `native-frame-materials` (`views/helium/native_frame_materials_mac.mm`, macOS vibrancy), `default-theme`, `helium-color-scheme`, `helium-color-mixers`, `frame-background`, `disable-ink-ripple-effect`, `progress-bar` (address-bar loading progress), `status-bubble`, `find-bar`, `infobar`, `toast`.

### 4.3 Toolbar and omnibox changes

* `helium/ui/location-bar.patch` and `location-bar-page-action.patch`: icon and label bubble styling, page-action layout.
* `helium/ui/omnibox.patch`: rounded results frame and restyled result rows.
* `selected-keyword-view.patch` and `bangs-ui.patch` go with `helium/core/add-native-bangs.patch` (DuckDuckGo-style !bangs). `helium/core/clean-omnibox-suggestions.patch`, `disable-omnibox-webui.patch`.
* `helium/ui/toolbar.patch`, `toolbar-button-prefs.patch`, `tab-search-in-toolbar.patch` (adds `pinned_toolbar/tab_search_toolbar_button_controller`), `app-menu-*`, `remove-dead-toolbar-actions`, `hide-page-actions-flag`, `page-zoom-indicator`, and `pwa-toolbar`.
* `helium/core/enable-glow-up-features.patch` turns on Chromium's in-progress 2026 UI refresh flags: `kToolbarGlowUp` (with back/forward disabled), `kTabGroupColorRefresh`, `kWebuiRefresh2026`, `kRoundedIcons` and `kWebUIRoundedIcons`.

### 4.4 Split view and side panel

* `helium/ui/split-view.patch` enables **`kSplitViewHorizontal` (stacked split) by default**, adds a right-click context menu on the resize handle, and changes snap points.
* `multi-contents-view.patch`, `multi-contents-drop-target.patch` (lowers the drop-target delay to 500 ms), `remove-split-view-mini-toolbar.patch`, `fix-layout-separators.patch`.
* `helium/ui/side-panel.patch`, `side-panel-webui-general.patch`, `side-panel-webui-customize.patch`, `fix-customize-side-panel.patch`, and `helium/core/disable-side-panel-flyover.patch`.

### 4.5 Branding approach (Chromium to Helium)

1. **`chrome/app/theme/chromium/BRANDING`** via `helium/core/change-chromium-branding.patch`: COMPANY_* and PRODUCT_* become "Helium", `MAC_BUNDLE_ID=net.imput.helium`, `MAC_TEAM_ID=S4Q33XPHB4`, and the crash product name is "Helium". Helium builds the **Chromium branding** (not `is_chrome_branded`) and swaps its contents. The Linux repo has its own `helium/linux/change-chromium-branding.patch`.
2. **String substitution at build time** (`utils/name_substitution.py`): a regex rewrites `(Google )?Chrom(e|ium)` to `Helium` and `chrome://` to `helium://` across all `.grd`/`.grdp` and `.xtb` files. It recomputes GRIT message fingerprints so translations keep matching. It deliberately leaves "Chrome Web Store", "Chrome Root Program" and "Chrome Remote Desktop" alone.
3. **Icons and logos**: `resources/branding/*` and `resources/favicons/*` are copied over `chrome/app/theme/chromium/*`, `components/resources/default_*/chromium/*`, and the vector `.icon` files (`chrome_product.icon`, `product.icon`, `product_refresh.icon`, …) through `helium_resources.txt`. On macOS, `resources/assets/{Assets.car, app.icns}` replace `chrome/app/theme/chromium/mac/*`. `AppIcon.icon` is the Icon Composer source (`generate_icons.sh`). Also `helium/ui/helium-logo-icons.patch`.
4. **macOS identity patches**:
   * `change-product-dir-name.patch`: `~/Library/Application Support/net.imput.helium`.
   * `change-keychain-name.patch`: "Helium Storage Key" / "Helium". Changing this later orphans existing users' encrypted data.
   * `chromium-signing.patch`: signing config, entitlements, and `chromium_config.py`.
   * `clean-main-menu.patch`.
5. **Versioning**: `helium_version.py` appends `HELIUM_*` to `chrome/VERSION`, wired up by `helium/core/add-helium-versioning.patch`.
6. **UA**: `helium/core/spoof-chrome-ua-brand.patch`. Service endpoints you would need to replace: `https://services.helium.imput.net` (services and uBlock lists), `https://updates.helium.computer/` (updates and Sparkle feed), `https://crash.helium.computer/crash`. The onboarding page (`helium-onboarding` release tarball) is fetched through `deps.ini`.

### 4.6 Settings and internal pages

* **`helium://` scheme** (`helium/core/override-chrome-protocol.patch`): it registers `helium` as a standard, secure, CORS and service-worker scheme (`content::kHeliumUIScheme`). Navigating to `helium://x` is rewritten to `chrome://x` in `browser_navigator.cc`. For display, `chrome://` is rewritten to `helium://` in the omnibox (`kFormatReplaceChromeProtocol`), copy and paste, the status bubble, hover cards and tab search.
  * In other words it is a cosmetic alias. All WebUIs remain `chrome://` internally.
* Only new WebUI host: **`helium://setup`** (`kHeliumSetupHost`, the onboarding page in `chrome/browser/ui/webui/onboarding/`, from `helium/core/onboarding-page.patch`).
* Settings patches (`patches/helium/settings/`):
  * `setup-behavior-settings-page.patch`: a new Appearance > "Behavior" subpage that holds the layout, Zen and shortcut toggles.
  * `custom-keyboard-shortcuts-page.patch`: `system_page/browser_shortcuts_page`, mojo `browser_shortcuts.mojom`, and the service in `chrome/browser/ui/browser_shortcuts/`.
  * `network-and-security-page`, `helium-noise-settings`, `crash-reporting-settings`, and `sync-setup-contract`.
  * A Privacy > "Helium services" page (`services_page.ts`) from `helium/core/services-prefs.patch`.
  * Removals: autofill, safety hub, translate, profile sections. Plus reordering and icons.
* Flags: `helium/core/flags-setup.patch` adds `chrome/browser/helium_flag_entries.h` and `helium_flag_choices.h`, similar to u-c's flag headers. `exclude-irrelevant-flags.patch` hides irrelevant flags.

### 4.7 Other notable bits

* Importers: `helium/core/add-zen-importer.patch` and `add-arc-importer.patch` (on top of Brave's custom importer).
* Private sync: `helium/core/sync/*`, a "sync vault" backend with a loopback server and an extension provider API. Saved tab groups and tab sync can work without Google.
* `tab-cycling-mru` (Ctrl+Tab MRU), `lazy-session-restore`, `infinite-tab-freezing`, `hibernate-tab-context-menu`, `mute-tab-context-menu`, `close-tabs-to-left`, and `enable-back-to-opener`.
* Fingerprint noise: `helium/core/noise/*` (canvas, audio, hardwareConcurrency).

---

## 5. Chromium-native vertical tabs, tab groups, split view and side panel (state at m154)

The milestone history comes from `BASE_FEATURE` declarations at each branch tag in `chrome/browser/ui/tabs/features.cc` and `chrome/browser/ui/ui_features.cc`:

| Feature | m142 | m146 | m148 | m150–152 | m153 | **m154** |
|---|---|---|---|---|---|---|
| `kVerticalTabs` | off | off | off | off | off | **removed (launched)** |
| `kVerticalTabsLaunch` | – | – | off | off | **on** | **removed (launched)** |
| `kVerticalTabsExpandOnHover` | – | – | off | off | off | off (`vertical-tabs-expand-on-hover`) |
| `kSideBySide` (split view) | off | **on** | removed (launched) | – | – | – |
| `kSplitViewHorizontal` (stacked) | – | – | – | off | off | **off** (`split-view-horizontal`). Helium turns it on. |
| `kSplitViewTabRestore` | – | – | – | off | on | removed (launched) |
| `kTabStripUnification` | – | – | – | off (152) | off | off (`tab-strip-unification`) |
| `kTabGroupsFocusing` | | | | | | **off** (`tab-groups-focusing`) |
| `kTabGroupRibbon` | | | | | | off (`tab-group-ribbon`). Declared, but no UI found yet. |
| `kTabGroupHome` | | | | | | off (`tab-group-home`, `chrome://tab-group-home`) |

### 5.1 Vertical tabs (launched; pref-controlled)
* State and prefs: `chrome/browser/ui/tabs/vertical_tab_strip_state_controller.{h,cc}`, `vertical_tab_strip_state.h`, `tab_strip_prefs.cc`.
  * Prefs: `vertical_tabs.enabled`, `vertical_tabs.collapsed_state`, uncollapsed width, `…expand_on_hover`.
  * Also `vertical_tab_iph_controller`, `vertical_tab_strip_metrics`.
* Region view: `chrome/browser/ui/views/frame/vertical_tab_strip_region_view.{h,cc}` and `vertical_tab_strip_background_blur_backdrop.*`. Layout lives in `chrome/browser/ui/views/frame/layout/browser_view_tabbed_layout_impl.{h,cc}` (with `browser_view_layout_delegate*` and a `README.md` there).
* Vertical-specific views in `chrome/browser/ui/views/tabs/vertical/`: `vertical_tab_strip_top_container`, `vertical_tab_strip_bottom_container`, `top_container_button`, `vertical_tab_strip_scroll_bar`, `vertical_tab_strip_expand_on_hover_lock`, **`vertical_tab_strip_focus_swipe_controller`**.
* A new collection-based tab strip, shared with the future unified horizontal strip, lives in `chrome/browser/ui/views/tabs/common/`: `tab_strip_view`, `tab_view` (+ horizontal/vertical layouts), `tab_collection_node`, `root_tab_collection_node`, `pinned_tab_container_view`, `unpinned_tab_container_view`, `tab_group_view`, `tab_group_header_view`, `split_tab_view`, `tab_drag_handler`, `tab_strip_collection_controller`, …
  * Shared widgets are in `views/tabs/shared/` (`new_tab_button`, `tab_strip_combo_button`, `tab_strip_flat_edge_button`, `rounded_scroll_bar`).
* Model layer: `components/tabs/public/` holds `tab_strip_collection.h`, `pinned_tab_collection.h`, `unpinned_tab_collection.h`, `tab_group_tab_collection.h`, `split_tab_collection.h`, `split_tab_data.h`, `tab_collection_observer.h` and `tab_interface.h`. `chrome/browser/ui/tabs/tab_strip_model.{h,cc}` sits on top.

### 5.2 Tab groups, saved tab groups and focusing (the Spaces building blocks)
* **Tab Groups Focusing** (`features::kTabGroupsFocusing`, flag `tab-groups-focusing`, off by default). Its description: "When a tab group is focused, the tabstrip constrains visibility to the tabs in that group."
  * API: `TabStripModel::GetFocusedGroup()`, `SetFocusedGroup(std::optional<TabGroupId>)` and `RotateFocusedGroup(bool forward)`. Observers are notified through `NotifyTabGroupFocusChanged`.
  * Focus state is wired into `browser.cc`, `browser_commands.cc`, `browser_actions.cc`, `tab_menu_model.cc`, `session_restore.cc`, `session_service_base.cc` and `browser_live_tab_context.cc`, with `focused_tab_group` in `browser_init_state`.
  * **`VerticalTabStripFocusSwipeController`** handles a **two-finger horizontal trackpad swipe on the vertical tab strip** (Mac `OnScrollEvent`) that cycles between the unfocused strip and each tab group.
  * Together that is close to a Zen/Arc "Spaces" model built from tab groups. `kTabGroupsFocusFreezing` (a param) freezes background groups.
* **Tab Group Ribbon** (`tab-group-ribbon`): "a vertical ribbon on the left side of the browser window for quickly switching between tab groups". Only the feature declaration exists in m154, so expect the implementation in later milestones.
* Saved tab groups: `components/saved_tab_groups/` (TabGroupSyncService, `delegate/`, `internal/`, `proto/`, `public/`) and `chrome/browser/ui/tabs/saved_tab_groups/` (controller, model listener, `tab_group_sync_delegate_desktop`, `local_tab_group_listener`, on-close helper). Desktop tab groups are in `chrome/browser/ui/tabs/tab_group_desktop.*`, `tab_group_model.*` and `tab_group_theme.*`. Tab Group Home WebUI: `chrome/browser/ui/tabs/tab_group_home/`.

### 5.3 Split view ("side by side")
* Launched in m146–148, limited to **two tabs per split**.
* Model:
  * `components/split_tabs/split_tab_visual_data.h`: `SplitTabLayout { kSideBySide, kStacked }` and `split_ratio`.
  * `split_tab_id.h`.
  * `components/tabs/public/split_tab_collection.h` and `split_tab_data.h`.
* Chrome UI logic: `chrome/browser/ui/tabs/split_tab_menu_model.*`, `split_tab_swap_menu_model.*`, `split_view_layout_menu_model.*`, `split_tab_util.*`, `split_tab_highlight_controller.*` and `split_view_iph_controller.*`.
* Views: `chrome/browser/ui/views/frame/multi_contents_view.*`, `multi_contents_resize_area.*`, `multi_contents_drop_target_view.*`, `multi_contents_view_drop_target_controller.*`, `multi_contents_view_mini_toolbar.*`, `multi_contents_background_view.*`, `contents_container_view.*` and `contents_container_outline.*`. The toolbar button is `views/toolbar/split_tabs_button.cc`.
* Feature params: `kSplitViewTabDraggingUpdates` and `kSplitViewDragAndDropVelocity` (both on).
* For more than two panes (Zen allows up to 4) you would need to extend `SplitTabCollection` and `MultiContentsView` yourself.

### 5.4 Side panel
* Model and registry: `chrome/browser/ui/side_panel/` (`side_panel_entry*`, `side_panel_registry`, `side_panel_ui*`, `side_panel_prefs`).
* Views: `chrome/browser/ui/views/side_panel/` (`side_panel.cc`, `side_panel_coordinator`, `side_panel_header*`, `side_panel_resize_area`, `side_panel_web_ui_view`, `side_panel_toolbar_pinning_controller`, plus `bookmarks/`, `history/`, `reading_list/`, `extensions/`, `customize_chrome/` …). It can be left- or right-aligned.
* Flyover animation: `kSidePanelFlyoverAnimation`, which Helium disables. Helium also restyles the panel in `helium/ui/side-panel.patch`.

---

## 6. Licensing notes for forking and rebranding

* Helium's `LICENSE` is **GPL-3.0**: "All code, patches, modified portions of imported code or patches, and any other content that is unique to Helium … is licensed under GPL-3.0".
  * Imported material keeps its original license. `LICENSE.ungoogled_chromium` is **BSD-3-Clause**.
  * Helium-authored files carry a GPL-3.0 header. The platform repos use the same split.
* Chromium itself is **BSD-3-Clause**, with many third-party licenses inside the tree. Helium's `helium/ui/licenses-in-credits.patch` and `update-credits.patch` keep `chrome://credits` complete.
* Vendor patches:
  * Brave (`patches/brave/*`) is **MPL-2.0**, a file-level copyleft that is GPL-compatible.
  * Bromite is GPL-3.0. Inox, Iridium and Debian are mostly BSD-style.
  * Bundled **uBlock Origin is GPL-3.0** (`third_party/ublock/README.chromium`).
* Practical consequence: a binary that includes Helium's patches is a GPL-3.0 combined work. When you distribute it, you must provide the complete corresponding source: your patch repos, build scripts, and the exact Chromium version and deps. Any new patches you add on top of Helium's must be GPL-3.0-compatible. Pure-Chromium-derived code you write from scratch could be BSD, but once it is combined with Helium patches the distribution is effectively GPL-3.0.
* **Trademarks and identity are not covered by the GPL.** Remove or replace all of these:
  * The "Helium" name and logos (`resources/branding`, macOS `resources/assets`, `helium-logo-icons.patch`).
  * `BRANDING`, the `net.imput.helium` bundle ID and product directory, and `MAC_TEAM_ID S4Q33XPHB4` (Helium's Apple team).
  * The keychain service name, the `helium://` scheme and the `name_substitution` target string.
  * Service and updater endpoints (`services.helium.imput.net`, `updates.helium.computer`, `crash.helium.computer`), the Sparkle feed and keys, the onboarding bundle, and the `imputnet/uBlock` fork (or keep it with attribution).
  * "Chrome" and "Google Chrome" are Google trademarks. "Chromium-based" is fine.
  * "Zen" is the name of the MPL-2.0 Zen Browser. Consider name-collision risk for "Zenium".
* Widevine: `enable_widevine=true` makes the CDM component-updater-downloadable, but working DRM on macOS needs proper signing and entitlements (see helium-macos #296). Commercial Widevine distribution needs a Google agreement.
* Repo policy: the Helium repo has an `AGENTS.md` (symlinked as `CLAUDE.md`) that says the maintainers don't accept AI-assisted contributions to imputnet repos. Their CONTRIBUTING.md warns of bans for AI-generated PRs and issues. That governs upstream contributions, not your fork. If you fork the repo, replace that file, because Claude Code will otherwise auto-load it as project instructions. Don't open AI-generated PRs or issues upstream.

---

## 7. Suggested fork strategy (brief)

1. Fork `imputnet/helium` (shared patches) and `imputnet/helium-macos`, and point the macOS repo's `helium-chromium` submodule at your fork.
2. Add your own vendor directory, e.g. `patches/zenium/{core,ui,settings}/`, at the end of the main `series` (and `patches/zenium/macos/` in the platform series). This keeps upstream Helium merges mostly conflict-free.
3. Rebrand by editing `change-chromium-branding.patch`, `name_substitution_utils.py` (target string and scheme), `override-chrome-protocol.patch` (scheme name), `resources/branding`, the macOS assets, `change-product-dir-name.patch`, `change-keychain-name.patch` and the service URLs. Don't forget `sign_and_package_app.sh` (Helium names, `net.imput.helium` identifier) and `dev.sh` (`he run` data dir).
4. For Spaces, build on Chromium's **tab-groups-focusing** (`TabStripModel::SetFocusedGroup` plus `VerticalTabStripFocusSwipeController`) and **saved tab groups**, layered over Helium's vertical layout and Zen mode. For split view, extend Helium's split patches. Chromium's model only supports two panes today.
5. Develop with `he setup` once, then edit in `build/src`, use `he build` / `./devutils/shared.sh build -j N`, `he run`, `quilt refresh`, `he unmerge`. Rebase with `he pull` after each upstream Chromium bump.

---

## Sources
* https://github.com/imputnet/helium (README, CONTRIBUTING.md, patches/series, utils/, devutils/, deps.ini, flags.gn, chromium_version.txt)
* https://github.com/imputnet/helium-macos (README, docs/building.md, build.sh, dev.sh, devutils/shared.sh, sign_and_package_app.sh, retrieve_and_unpack_resource.sh, .github/scripts/*, patches/series)
* https://github.com/imputnet/helium-macos/pull/314 (Xcode 27 fixes); issues #349, #315, #296
* https://github.com/imputnet/helium-linux, https://github.com/imputnet/helium-windows
* Chromium mirror at tags 142.0.7444.0 … 154.0.8037.97: `chrome/browser/ui/tabs/features.cc`, `chrome/browser/ui/ui_features.cc`, `chrome/browser/about_flags.cc`, `chrome/browser/flag_descriptions.h`, `components/split_tabs/`, `components/tabs/public/`, `chrome/browser/ui/views/tabs/vertical/`, `build/config/mac/mac_sdk.gni`, `docs/mac_build_instructions.md`
* https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac
* [Xcode 27 Is Out: Requirements, Targets, and What Broke](https://blakecrosley.com/blog/xcode-27-release)
* [AlternativeTo: Helium debuts experimental vertical tabs](https://alternativeto.net/news/2026/2/helium-browser-debuts-experimental-vertical-tabs-for-improved-user-experience)
* [Neowin: Helium 0.9.1.1 rolls out vertical tabs](https://www.neowin.net/software/helium-browser-0911-rolls-out-vertical-tabs-along-with-new-updates/)
