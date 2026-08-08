# I'm the Warranty

A service and maintenance log for every car and bike you own, stored as a single JSON file
in your own Google Drive, so Windows and Android read and write the same log.

- **The landing page is your fleet.** Every vehicle is a photo tile with its year, make and
  model — three across on a phone, more on a wider screen. Tap one to open it.
- **A vehicle page** leads with its photo and name, then what it has cost you: a lifetime
  total, broken down into Service, Repair, Maintenance and Upgrade.
- **Records are date, mileage, type and cost**, newest first. Tap a row to open it — the
  fields become editable and a notes box appears, sizing itself to fit however much you
  write and shrinking back as you delete. The date is a proper date picker, so back-filling
  a service from 2019 is a normal thing to do, not a fight.
- **Photos** are picked from the camera or the gallery and resized on the device before
  they're uploaded. Tap the photo on a vehicle page to see it full size.
- **"Sold" doesn't delete.** The vehicle leaves the grid but keeps its photo, its records
  and its totals, and you'll find it under **Sold** — with a **Back in the Garage** button
  if you sell it to a friend and buy it back. Individual records *do* delete; a typo isn't
  history.
- **Conflicts** are detected, not guessed at: if the other device saved first, you're asked
  which version to keep.
- **Offline** edits — including photos you've just taken — are kept on the device and pushed
  when the connection is back.

It's a PWA — plain HTML/CSS/JS, no build step, no npm install. Deploy by copying files.

---

## Try it first, no setup

Open `index.html` through a local server (see [Run it locally](#2-run-it-locally)) with `?mock=1`:

```
http://localhost:8010/?mock=1
```

That runs the whole app against a fake in-browser Drive. Nothing touches Google and nothing
leaves the machine — it's just to see the thing work before you do the setup below.

---

## 1. Google setup (once, ~10 minutes)

You need an OAuth client ID so the app can ask for permission to your Drive. Make this a
**new project with its own client ID**, not one shared with another app — `drive.file` access
is keyed to the client ID, so a separate one keeps this app walled off from everything else.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a project
   (name it anything, e.g. `im-the-warranty`).

2. **Enable the Drive API.** *APIs & Services → Library →* search **Google Drive API** → **Enable**.

3. **Configure the consent screen.** *APIs & Services → OAuth consent screen*. Choose
   **External**, fill in an app name, and use your own Gmail address for both the support
   and developer contact fields.

4. **Publish it.** On the consent screen / Audience page, click **Publish app**. There's no
   review to wait for — this app only asks for the `drive.file` permission, which Google
   classes as non-sensitive. Leaving it in *Testing* mode instead means periodically
   re-granting access, so publish.

5. **Create the client ID.** *Credentials → Create credentials → OAuth client ID →
   Application type: **Web application***. Under **Authorized JavaScript origins**, add both:

   ```
   http://localhost:8010
   https://YOUR-GITHUB-USERNAME.github.io
   ```

   The first is for running it locally, the second for the deployed site. Add the second once
   you know your GitHub Pages address — you can edit this later. Origins only: no paths, no
   trailing slash, and no redirect URI is needed. Sign-in only works from origins listed here,
   so if you ever serve the app from somewhere new, add that origin too.

6. **Paste the client ID into `config.js`:**

   ```js
   GOOGLE_CLIENT_ID: "1234567890-abcdefg.apps.googleusercontent.com",
   ```

That client ID is not a secret. Browser OAuth client IDs are public by design — the
authorized-origins list is what stops anyone else using it.

### What the app can see

The permission requested is `drive.file`, the narrowest one Drive offers: an app can only
open files it created itself. This app creates `vehicledata/` and can touch nothing else in
your Drive — not your documents, not your photo library, not even a `vehicledata` folder you
made by hand. That last part is why the app creates its own folder on first run.

---

## 2. Run it locally

`file://` won't work — Google sign-in requires a real origin. From the project folder:

```bash
python -m http.server 8010
```

Then open <http://localhost:8010>.

---

## 3. Put it online

Any static host works. GitHub Pages is free and fine:

1. Create a repo and push these files to `main`.
2. *Settings → Pages → Source: Deploy from a branch → `main` / `(root)`.*
3. Wait a minute, then visit `https://YOUR-USERNAME.github.io/REPO-NAME/`.
4. Go back to step 1.5 above and make sure `https://YOUR-USERNAME.github.io` is in the
   authorized JavaScript origins.

The repo will be public unless you pay for private Pages — that's fine, there are no secrets
in it. Your vehicles and photos live in your Drive, never in the repo.

---

## 4. Install it as an app

Easiest on every platform: open the site and press the **Install** button in the top bar. It
appears only when the browser considers the app installable and it isn't installed already, so
if you can see it, it will work.

Failing that, the browser menus still do it. **Windows** — *⋯ menu → Apps → Install this site
as an app*. **Android** — *⋮ menu → Add to Home screen*. **iPhone** — Safari doesn't support
the Install button, so it's *Share → Add to Home Screen*.

Both installs are just the website, so a push to `main` updates both. Reopen the app to pick
up a change.

---

## How syncing works

The app keeps the exact text of the data file as it last saw it. Before every write it
re-reads the file and compares. If the contents have changed, your phone and PC have diverged
and you're asked which version to keep, rather than one silently overwriting the other.

(An earlier version of the sister app compared Drive's `version` counter instead. Don't go
back to that: Drive bumps that counter for its own server-side metadata changes, which
produces phantom conflicts on a file that nothing else has touched.)

Saves are automatic, about a second after you stop typing. Bringing the app back to the
foreground re-reads from Drive, so opening it on your phone picks up what you did on the PC.

There is a narrow race — if both devices write in the same fraction of a second, the check can
pass on both. For one person on two devices it isn't a practical concern.

---

## How photos work

Each vehicle gets two JPEGs in `vehicledata/photos/`: a thumbnail for the grid and header,
and a full-size copy for when you tap it. Both are produced **on the device that picked the
file** — a 12 MP phone photo is resized before anything is uploaded, so you're sending
kilobytes rather than megabytes.

They are deliberately *not* inlined into `vehicles.json` as base64. Conflict detection
re-downloads that file before every write, and a one-second autosave that drags several
megabytes with it would make typing a note feel broken. Keeping images out means the data
file stays a few hundred bytes per vehicle.

Local copies live in the browser's Cache API, keyed by vehicle and photo revision. That's
what makes the grid paint instantly on the second visit, work with no signal, and avoid
re-downloading a photo that hasn't changed. A photo you take offline is usable immediately
and uploads itself when the connection returns.

Replacing a photo bumps its revision, so the other device knows its cached copy is stale
without comparing bytes, and the superseded files are removed from Drive.

**One iPhone caveat:** photos come off an iPhone as HEIC. Safari can decode those, so
picking one *on the phone* works fine — it's converted to JPEG before upload. Dropping a raw
`.HEIC` file into the app on Windows will not work, because desktop Chrome can't decode the
format. The app says so rather than failing silently.

---

## The data file

`vehicledata/vehicles.json` is readable JSON; you can open it in Drive and edit it by hand if
you ever want to.

```json
{
  "schema": 1,
  "updatedAt": "2026-08-07T18:20:11.000Z",
  "vehicles": [
    {
      "id": "45e9…",
      "year": 2019,
      "make": "Toyota",
      "model": "Tacoma",
      "photoRev": "a71c…",
      "thumbFileId": "1AbC…",
      "photoFileId": "1DeF…",
      "soldAt": null,
      "createdAt": "2026-08-07T18:18:40.000Z",
      "records": [
        {
          "id": "9f2c…",
          "date": "2026-07-14",
          "mileage": 48210,
          "type": "Service",
          "cost": 89,
          "notes": "Oil + filter.\nShop on 5th.",
          "createdAt": "2026-08-07T18:19:02.000Z",
          "updatedAt": "2026-08-07T18:19:02.000Z"
        }
      ]
    }
  ]
}
```

`date` is a plain calendar day, not a timestamp — it's the day the work happened, which has
no time zone. `soldAt` and the `createdAt`/`updatedAt` stamps *are* instants, and are
converted to your local day before being shown.

`photoRev` changes every time you replace the photo; the two `FileId` fields point at the
JPEGs in Drive and are null while an upload is still queued. Vehicles are shown in the order
they were added.

The app repairs whatever it finds. Missing fields get defaults, an unknown service type falls
back to the first one in `SERVICE_TYPES`, records are re-sorted newest-first, and a junk date
becomes today. You can't corrupt it into a state that won't load.

---

## Settings worth knowing about

All in `config.js`:

| Setting | Does what |
| --- | --- |
| `SERVICE_TYPES` | The dropdown. Add or rename freely — anything in the file that isn't on the list falls back to the first entry |
| `CURRENCY` | Formatting only, nothing is converted |
| `THUMB_PX` / `PHOTO_PX` | Longest edge of the two generated JPEGs |
| `JPEG_QUALITY` | 0–1. Raise it if photos look soft, at the cost of size |
| `FOLDER_NAME` / `FILE_NAME` | Where it lives in Drive. Changing these after first run orphans the old folder |

---

## Files

| File | What it does |
| --- | --- |
| `index.html` | Markup, screens and dialogs |
| `app.css` | Styling, light and dark |
| `app.js` | State, screens, records, photo handling, auto-save |
| `drive.js` | Google auth, the Drive read/write calls, photo upload/download |
| `config.js` | Your client ID, folder names, service types, photo sizes |
| `sw.js` | Service worker — makes it installable and work offline |
| `dev/mock.js` | Fake Drive for `?mock=1`. Dev only; inert otherwise |
| `manifest.webmanifest`, `icons/` | Install metadata and app icons |

Changing a shell file? Bump `CACHE` in `sw.js` so devices drop the old copy. Note that it
only ever sweeps up old `itw-shell-*` caches — the photo cache is left alone, or every
deploy would strip the images off the device.
