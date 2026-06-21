# Screenshot shot list

The README's gallery expects the 13 PNGs below in this folder. Capture them from your running
instance and save with the **exact filenames** — the README will then render.

> These need to be captured from a real, logged-in dashboard (it's behind a login, so they
> can't be generated automatically). It takes ~10 minutes.

## One-time setup before shooting

1. Sign in to the dashboard.
2. **Settings → Customize:**
   - **Dashboard name** → `An-Noor Institute`
   - **Wallpaper → Custom wallpaper image** → paste:
     ```
     https://external-content.duckduckgo.com/iu/?u=https%3A%2F%2Fwallpapercave.com%2Fwp%2Fwp9361158.jpg&f=1&nofb=1&ipt=241338667c6808ed55e15f77d3144917aa42d1e02cf735f82e14c59d176cb484
     ```
   - **Theme** → Dark (for most shots), **accent** → your favourite.
3. Have **2–3 apps installed** so the dashboard, app menus, logs and terminal shots look real.
4. **Settings → Advanced:** turn on **Allow custom apps** and **Enable app shells** (needed for
   the community, compose, and terminal shots). Add one community app store so the Community tab
   has content.

## Capture tips

- Browser window **~1600–1920 px wide**, **100% zoom**, bookmarks bar hidden — clean and crisp.
- Capture the **viewport** (not the whole scrolled page) for a tidy framed look. On Chrome/Edge:
  DevTools (F12) → Ctrl/Cmd+Shift+P → "Capture screenshot". Or just use the OS screenshot tool.
- Save as **PNG** into this folder (`docs/screenshots/`).

## The 13 shots

| File | Screen | What to show |
|------|--------|--------------|
| `01-dashboard.png` | **Dashboard** (home) | "Good …, An-Noor Institute", live stat strip, your apps grid, dock — on the custom wallpaper. This is the hero. |
| `02-login.png` | **Login** | Sign out first. Capture the "Welcome back" sign-in card. |
| `03-app-store.png` | **App Store** | The catalog grid of app cards. |
| `04-install-dialog.png` | **Install dialog** | Click **Install** on an app — show the dialog with its settings fields. |
| `05-community.png` | **3rd Party → Community apps** | App Store → 3rd Party App → Community apps tab, with apps from an added store. |
| `06-compose.png` | **3rd Party → Docker Compose** | The paste-a-Compose form (name + compose + env). |
| `07-app-menu.png` | **App card menu** | On the dashboard, open an app card's ⋮ menu (Open / Restart / Shut down / Logs / Pin / Remove). |
| `08-logs.png` | **Logs window** | App ⋮ → View logs — the draggable window with the traffic-light controls. |
| `09-terminal.png` | **Terminal window** | App ⋮ → Open shell (or Settings → Advanced → Open root terminal). |
| `10-files.png` | **File manager** | The Files page with folders/files listed. |
| `11-file-editor.png` | **File editor / viewer** | Click a text file (editor window) or an image (viewer window). |
| `12-settings.png` | **Settings → Customize** | Theme, accent swatches, wallpapers, clock options. |
| `13-light-mode.png` | **Light mode** | Switch Theme to Light and capture the dashboard (shows both themes are first-class). |

When all 13 are in this folder, commit them and the README gallery is complete.
