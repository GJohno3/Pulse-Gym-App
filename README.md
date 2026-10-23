# PulseGym

A 4-day split & Assault Bike HIIT tracker, built as an installable web app for iPhone (Safari → Share → Add to Home Screen).

- **Everything runs on the phone.** Workouts are saved in the browser's local storage for the site's address — there is no server or account. Use **App / Export → Save .json** (or the in-app backup reminder) to keep a copy.
- **Works offline** at the gym via a service worker (`site/sw.js`).

## Layout

```
site/                  The app, published as-is
  index.html           All markup, styles and logic (Tailwind via CDN)
  sw.js                Offline cache
  manifest.webmanifest Home Screen app details
  *.png                App icons
netlify.toml           Tells Netlify to publish site/ with no build step
```

## Deploying

Netlify is linked to this repository: every push to `main` is published automatically to the existing site address, so data saved on the phone carries over.

Keep the site on the same address — a new address starts with empty storage on the phone.

## Running locally

Serve the `site/` folder over HTTP (the service worker won't register from `file://`), e.g.:

```
npx serve site
```
