# PulseGym

A 4-day split & Assault Bike HIIT tracker, built as an installable web app for iPhone (Safari → Share → Add to Home Screen).

- **Workouts stay on the phone.** They're saved in the browser's local storage for the site's address — no account, and logs are never sent anywhere. Use **App / Export → Save .json** (or the in-app backup reminder) to keep a copy.
- **Works offline** at the gym via a service worker (`site/sw.js`).
- **Push reminders** (optional, Reminders screen): a small Netlify function sends a notification before each training session. iPhone allows this for Home Screen apps only (iOS 16.4+).

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
netlify/functions/     Push reminders: push.mjs (API at /api/push/*), push-reminders.mjs (runs every 5 min)
netlify/lib/           Shared push logic (validation, due times, sending)
netlify.toml           Build command, published folder, functions and security headers
```

## Deploying

Netlify is linked to this repository: every push to `main` is published automatically to the existing site address, so data saved on the phone carries over. Each deploy runs `npm run build`, which regenerates `site/styles.css` from the classes used in `index.html`.

Keep the site on the same address — a new address starts with empty storage on the phone.

## Push reminders

- Turning notifications on sends the server this device's push address, the training days, workout names, reminder time and time zone. Workout logs never leave the phone.
- They're stored in Netlify Blobs, along with the push signing keys, which are generated automatically on first use. There's nothing to configure.
- Every 5 minutes, `push-reminders.mjs` sends any reminders that are due, in each device's own time zone. Devices that have unsubscribed are removed.

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
