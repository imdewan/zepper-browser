# Zepper Browser: feature list

Everything Zepper replicates from Zen Browser (1.23.x), grouped by area. Zen Mods are out of scope.

**Phases:** **P1** = first prototype, **P2** = next, **P3** = later.
**Sources:** the full measured specs are in [`research/`](research/); the visual target is [`reference/zen-sidebar.png`](reference/zen-sidebar.png).

## 1. Window and layout
| Feature | Phase |
|---|---|
| Single-toolbar layout: no top toolbar, all chrome in the sidebar | P1 |
| Floating web content: rounded card inset 8px from the window, shadow `0 3px 8px rgba(0,0,0,.24)`, no inset on the sidebar side | P1 |
| macOS vibrancy: the wallpaper shows through the sidebar; inactive windows grey out | P1 |
| Traffic lights in the sidebar's top row, next to back / forward / reload | P1 |
| Sidebar resize (min 163px, default 230px, max 500px); double-click the handle to reset | P1 |
| Dragging the sidebar below 60px switches to compact mode | P2 |
| Collapsed (icon-only, 60px) sidebar; sidebar on the right | P2 |
| Classic top-toolbar layout | P3 |

## 2. Sidebar, top to bottom
1. **Top row:** sidebar/compact toggle, back, forward, reload. (P1)
2. **URL pill:** lock icon plus bare domain; clicking it opens the URL bar. (P1)
3. **Essentials grid:** large rounded tiles, shared by every space. (P1)
4. **Space header:** emoji and name; clicking it collapses or expands that space's pinned tabs. (P1)
5. **Space-pinned tabs**, then the separator with a **Clear** button that closes all unpinned tabs. (P1)
6. **"+ New Tab"**, then normal tabs, newest first. (P1)
7. **Bottom bar:** settings, space switcher icons (inactive ones greyed; they collapse to dots when they overflow), and a downloads/library button. (P1)

## 3. Spaces
| Feature | Phase |
|---|---|
| Create (inline form inside the sidebar), rename (double-click), delete (with confirmation; you can't delete the last one) | P1 |
| Space icon: emoji picker plus ~86 built-in SVG icons | P1 |
| Gradient theme per space. P1 has preset swatches and an opacity control; P2 adds Zen's full dot-based generator (color harmonies, light/dark choice, grain texture wheel) | P1/P2 |
| Switching: bottom icons, `Ctrl+1…9`, `⌘⌥←/→`, two-finger swipe on the sidebar (with resistance at the ends), `Ctrl`+scroll | P1 |
| Switch animation: 250ms critically damped spring slide, plus a crossfade between the two spaces' backgrounds | P1 |
| Each space remembers its last selected tab; opening a tab from another space switches to that space | P1 |
| Reorder spaces by dragging their bottom icons | P2 |
| Swipe past the last space to create a new one | P2 |
| Unload space / unload all other spaces | P2 |
| Per-space profile: separate cookies per space (an Electron session partition, Zen's "containers") | P3 |
| Space Routing: URL rules that send links to a specific space | P3 |

## 4. Essentials and pinned tabs (two tiers, both persistent)
Pinned tabs come back after you close the window or quit the app, whatever the session-restore setting. Closing one only unloads it.

| Feature | Phase |
|---|---|
| **Essentials:** grid of up to 12 tiles shared across spaces; 2–4 columns that rebalance with width; the active tile has an accent-tinted fill and a favicon-colored glow | P1 |
| **Space-pinned list:** each space has its own pinned tabs above the separator | P1 |
| Each pinned tab remembers its URL. When you navigate away, the row shows the original favicon / slash / current page | P1 |
| Hovering the pinned favicon shows "Back to pinned url" and clicking resets the tab; ⌘-click instead splits the current page off into a new tab ("Separate from pinned tab") | P1 |
| `⌘W` on a pinned tab resets its URL, unloads it and switches away (Zen's default); middle-click unloads it, and middle-clicking an already-unloaded one closes it | P1 |
| Double-click an Essential to reset it to its URL | P1 |
| Pin/unpin with `⌘⇧D` or the context menu; "Add to Essentials" | P1 |
| Drag tabs between Essentials, the pinned list and normal tabs (dropping pins or unpins) | P2 |
| Edit pinned URL / replace it with the current URL; custom tab name and icon | P2 |

## 5. Normal tabs
| Feature | Phase |
|---|---|
| Open animation (fade in, scale 0.95→1 and expand height, 120ms) and close animation (100ms) | P1 |
| Close button on hover only; audio indicator and mute | P1 |
| **Clear** (`⌘⇧K`) closes unpinned tabs, keeping any that are playing audio, followed by an undo toast | P1 |
| Closing a tab selects the most recently used one | P1 |
| Tab context menu: pin, add to Essentials, duplicate, move to space, copy link, close | P1 |
| Drag to reorder; rename by double-clicking; unload tab | P2 |

## 6. Folders
Nested up to 5 levels deep, with an animated folder icon that opens and closes. A collapsed folder keeps its active tab visible. You can rename a folder, change its icon, unpack it, delete it or convert it to a space. (P2)

Hover-to-search inside a folder and live folders (RSS, GitHub PRs/issues) are P3.

## 7. URL bar / command palette
| Feature | Phase |
|---|---|
| `⌘T` / `⌘L` open a floating, centered palette instead of a new-tab page. Size: width `min(90%, 62rem)`; style: radius 15px, deep shadow `0 30px 140px -15px`; it opens with a 150ms grow | P1 |
| Results: open tabs (switch to tab), history, search suggestions, typed-URL detection | P1 |
| Enter opens a new tab, Esc returns to the page; typed text is kept for 45 seconds | P1 |
| Actions mode: press Tab in an empty bar for ~37 commands with fuzzy search and shortcut chips; a ranking that learns what you use | P2 |
| `` ` `` searches only within spaces; typing a space's name switches to it | P2 |

## 8. Glance (link preview)
Opens with ⌥-click on a link or "Open Link in Glance". The overlay is 80% of the content width and arcs out from the link in 350ms. The page behind scales to 0.97 and fades to 30% opacity. Side buttons: close, expand (`⌘O`), split. Esc closes it. Links to other sites opened from pinned tabs and Essentials open in Glance automatically. (P2)

## 9. Split view
| Feature | Phase |
|---|---|
| Up to 4 panes as a grid, side by side or stacked: `⌘⌥G` / `⌘⌥V` / `⌘⌥H`; unsplit `⌘⌥U` | P2 |
| Drag a tab onto a content edge to split; drag dividers to resize (each pane keeps at least 7%); each pane gets a hover header to rearrange or unsplit; the focused pane gets an outline | P2 |
| Split groups show as a single combined row in the sidebar | P2 |

## 10. Compact mode
`⌘S` hides the sidebar. Hovering a 5px strip at the edge brings it back as a floating card: 0.25s spring with a slight overshoot. It stays 150ms after the pointer leaves, and stays open while a menu or popup is open. A toast appears when a background tab opens. (P2)

## 11. Ad and tracker blocking (built in)
| Feature | Phase |
|---|---|
| Ghostery engine with uBlock Origin's filter lists: EasyList, EasyPrivacy, uBO filters/badware/privacy/unbreak, Peter Lowe's list | P1 |
| Network blocking plus hiding page elements and anti-adblock scripts (covers YouTube ads); lists cached on disk and refreshed daily | P1 |
| Per-site pause, and a blocked counter in the site panel | P2 |

## 12. Other UI
| Feature | Phase |
|---|---|
| **Toasts:** top-right, 42–48px tall, radius 14px, accent-colored gradient, spring entrance, auto-hide after 2s (paused while hovered) | P1 |
| Copy URL `⌘⇧C` (tracking parameters stripped) with a toast; copy as Markdown `⌘⌥⇧C` | P1 |
| Find in page, zoom, page context menu (open link in new tab / Glance / split, copy link, inspect) | P1 |
| Loading pill: a small pulsing bar at the top-center of the page instead of tab spinners | P1 |
| Session restore for normal tabs, which reload only when you open them | P1 |
| Site panel: permissions, ad-block toggle, share, bookmark, screenshot | P2 |
| Media controls in the sidebar: a now-playing card that follows the most recently played media (play/pause, mute, hide), a "N playing · Pause others" strip, and an offer (or setting to auto-pause) when a new tab starts playing over another | P2 |
| Picture-in-picture: leaving a playing video floats it in a rounded, resizable, always-on-top player sized relative to the screen (small/medium/large), with back-to-tab, play/pause, mute and close | P2 |
| Windows: `⌘N` new window, `⌘⇧N` private window (separate in-memory session, no history, wiped on close) | P2 |
| Google sign-in compatibility: on accounts.google.com only, the page sees a complete `window.chrome` and no passkeys, so Google offers the password step | P1 |
| Downloads with a fly-to-button arc animation | P2 |
| Settings page; keyboard shortcut editor | P2 |
| Library panel (history, downloads, spaces overview), Boosts (per-site colors, fonts, CSS and hiding page elements), onboarding, bookmarks, DRM | P3 |

## 13. Keyboard shortcuts (P1 set)
| Area | Shortcuts |
|---|---|
| Tabs | `⌘T` palette · `⌘W` close (pinned: reset+unload) · `⌘⇧T` reopen closed · `⌘1–8` tab N · `⌘9` last tab · `⌃Tab` / `⌃⇧Tab` cycle |
| Spaces | `⌃1–9` space N · `⌘⌥→` / `⌘⌥←` next / previous space |
| Pinning | `⌘⇧D` pin/unpin · `⌘⇧K` clear unpinned |
| Clipboard | `⌘⇧C` copy URL · `⌘⌥⇧C` copy as Markdown |
| Page | `⌘L` URL bar · `⌘R` / `⌘⇧R` reload · `⌘[` / `⌘]` back / forward · `⌘F` find · `⌘+` / `⌘−` / `⌘0` zoom · `⌘⌥I` devtools |
| Compact mode (P2) | `⌘S` toggle |

## Deliberately left out
- Zen Mods.
- Forced window sync, which was Zen's most disliked feature.
- Telemetry.
- Default `Ctrl+Alt` shortcuts that break on non-US keyboards.

## Design tokens (from Zen's source)
| Token | Value |
|---|---|
| Element separation (content inset) | 8px |
| Window radius (macOS) | 10px (11px on Tahoe); content card ≈ 7px |
| Tab row | 36px tall + 2px margin; radius 14px; padding 8px |
| Essentials tile | 46px tall; radius 14px; gap 4px |
| Selected tab | `color-mix(white 80% ~98%, primary)` in light mode, `rgba(255,255,255,.18)` mixed in dark mode; shadow `0 .8px 1.5px rgba(0,0,0,.15)` |
| Hover | branding-reverse colour at 7% |
| Pressed tab | scale 0.985 |
| Springs | Motion library: space switch 0.25s with bounce 0; toast 0.5s with bounce 0.2; compact reveal 0.25s with slight overshoot |
| Space header | 44px tall; name weight 600 at 70% opacity |
