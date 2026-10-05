# Zen sidebar anatomy (reference: `zen-sidebar.png`)

The target look for Zepper's default layout, read top to bottom from the reference screenshot.

## Window
- **No top toolbar.** Web content runs to the top edge, and all chrome lives in the sidebar ("single toolbar" layout).
- **Native macOS vibrancy.** The desktop wallpaper shows through the sidebar and window frame, blurred and darkened. In Chromium terms this is an `NSVisualEffectView` behind a transparent frame. Helium's `native-frame-materials.patch` is the starting point.
- **Floating content card.** Web content sits in a rounded rectangle (~8–10px radius) inset ~6–8px from the window edges, with a soft shadow and no border chrome.

## Sidebar, top to bottom
1. **Title row:** traffic lights, then a sidebar/home toggle, back, forward and reload as plain icon buttons with no backgrounds.
2. **URL pill:** lock icon plus the bare host (`discord.com`, no scheme or path). It's a rounded (~8px) slightly lighter translucent fill, and clicking it opens the floating URL bar.
3. **Essentials grid:** large rounded tiles (~10px radius) holding a centred favicon. The grid has 2 columns at this width and adds columns as the sidebar widens. Tiles have a translucent white fill. The **active** tile gets a 1.5px accent-colored border and an accent-tinted fill.
4. **Space header:** emoji icon plus the space name ("Personal") in muted text.
5. **Space-pinned tabs:** favicon plus title, small (~12–13px) text. No background until hovered, and the active tab gets a translucent pill.
6. **Separator:** a 1px low-opacity line between pinned and regular tabs.
7. **"+ New Tab" row:** muted text and icon.
8. **Regular tabs:** same style as pinned tabs.
9. **Bottom bar:** settings gear on the left, the space switcher in the centre (one icon per space, current one full opacity, others dimmed), downloads on the right.

## Behaviour called out by Dewan
- **Pinned tabs are permanent.** Essentials and space-pinned tabs survive closing the window and relaunching the app, whatever the session-restore setting is. Closing a pinned tab only *unloads* it; the entry stays in the sidebar. Implementation: a dedicated pinned-tabs store in the profile, separate from `SessionService`.
