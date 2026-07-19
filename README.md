# Alarmind Desktop

A lightweight desktop app for Alarmind. It's a dedicated window around the live
site (`https://alarmind.in`): it opens the login page, keeps you inside the app
(login → dashboard), and never shows the marketing landing page.

Because it loads the live site, any change you deploy to the website appears in
the desktop app automatically — no rebuild needed for content changes.

## Requirements

- Node.js (18+; tested on 22) and npm

## Run in development

```bash
npm install
npm start
```

This launches the app pointing at the live site.

## Build installers

The output goes to the `release/` folder.

```bash
# Windows .exe (NSIS installer)
npm run dist:win

# Linux AppImage + .deb
npm run dist:linux

# macOS .dmg  (must be built on a Mac)
npm run dist:mac
```

Notes:

- **Local Windows builds are unsigned.** Official releases are built on GitHub
  Actions and code-signed via SignPath (see below); only those should be
  distributed.
- **macOS** is configured but realistically must be built on a Mac.
- Distribute the signed installer from a GitHub Release via a download link on
  your website. No app store is involved.

## Releases & code signing

Official Windows releases are built by the GitHub Actions workflow in
`.github/workflows/release.yml` (triggered by pushing a `v*` tag) and signed
with a code-signing certificate.

Free code signing provided by [SignPath.io](https://signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

## License

This project is licensed under the [MIT License](LICENSE).

## How it behaves

- Opens `https://alarmind.in/login` on launch.
- After login the site sends you to `/dashboard`; you stay logged in across
  launches (the window keeps its own browser profile).
- Clicking the login-page logo (which links to `/`) redirects to the dashboard
  instead of showing the landing page.
- Links to non-Alarmind sites open in your real browser.
- No internet → a friendly offline screen with a Retry button.

## Files

- `main.js` — the Electron main process (window, navigation guard, menu, offline).
- `preload.js` — intentionally empty; keeps the shell hardened.
- `offline.html` — the offline fallback screen.
- `build/icon.png` — the app icon (the Alarmind "A").
- `package.json` — dependencies and electron-builder config.
