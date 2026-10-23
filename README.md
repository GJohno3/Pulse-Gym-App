# PulseGym

A 4-day split & Assault Bike HIIT tracker, built as an installable web app for iPhone (Safari → Share → Add to Home Screen).

- **Everything runs on the phone.** Workouts are saved in the browser's local storage for the site's address — there is no server or account. Use **App / Export → Save .json** (or the in-app backup reminder) to keep a copy.
- **Works offline** at the gym via a service worker (`site/sw.js`).

## Layout

```
site/                  The app, published as-is
  index.html           All markup, app styles and logic
  styles.css           Tailwind styles, generated from index.html (npm run build)
  sw.js                Offline cache
  manifest.webmanifest Home Screen app details
  *.png                App icons
src/styles.css         Tailwind source for site/styles.css
tailwind.config.js     Tailwind theme (app colours and fonts)
netlify.toml           Build command, published folder and security headers
```

## Deploying

Netlify is linked to this repository: every push to `main` is published automatically to the existing site address, so data saved on the phone carries over. Each deploy runs `npm run build`, which regenerates `site/styles.css` from the classes used in `index.html`.

Keep the site on the same address — a new address starts with empty storage on the phone.

## Security

- `netlify.toml` sends a Content Security Policy and other security headers: the page can only load its own files and Google Fonts.
- Saved data and imported backups are checked before use, so a tampered backup can't inject code into the app.

## Running locally

```
npm install
npm run build
npx serve site
```

Serve over HTTP — the service worker won't register from `file://`.
