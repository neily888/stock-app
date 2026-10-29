# Stock

A small installable web app (PWA) for tracking consumables in the van (Mobile) and at home (Base).
It runs on Cloudflare Pages, and the counts are stored in a Cloudflare D1 database so your phone and laptop share them.

## What's in the repo

- `public/` the app: `index.html`, `manifest.webmanifest`, `sw.js` (offline support), `icons/`
- `functions/api/[[path]].js` the backend (Pages Function) that reads and writes the D1 database

There is no build step.

## Set up on Cloudflare (one time)

1. **Create the database.** Cloudflare dashboard, Storage & Databases, D1, Create database. Name it `stock-db`. You don't need to create any tables, the app creates them on first use.
2. **Create the Pages project.** Workers & Pages, Create, Pages, Connect to Git, choose this repo.
   - Production branch: `main`
   - Framework preset: None
   - Build command: leave empty
   - Build output directory: `public`
3. **Connect the database.** Open the project, Settings, Bindings, Add, D1 database.
   - Variable name: `DB` (must be exactly this)
   - Database: `stock-db`
   - Add it for both Production and Preview.
4. **Redeploy.** Deployments, open the latest one's menu, Retry deployment, so the binding takes effect.
5. Open the project's `*.pages.dev` address. The first visit loads the starter item list (every count at zero) into the database.

## Install on your phone

- iPhone: open the address in Safari, Share, Add to Home Screen.
- Android: open it in Chrome, menu, Install app.
- Laptop: Chrome or Edge, install icon in the address bar.

## How saving works

- The whole inventory is stored as one record with a version number.
- If you change something on one device while another has newer data, the older device reloads the latest and asks you to repeat the change.
- With no signal the app still opens and shows the last stock it saw, but changes are refused and undone.
- The first change each day keeps a copy of the previous day's data. The last 30 copies are kept and can be restored from the menu in the app.
- Export in the menu gives you a JSON backup file. Import accepts that file, and also backups from the older inventory app.

## Usage log

Every change to a count is recorded with its type, the item, the location, the amount and the time. Open More, then Usage log, pick a day and you see what was used, with a Copy list button for invoices.

- **Used** means stock taken out: reducing Mobile, or reducing Base with "Used up" ticked.
- Buying, adding, moving stock from Base to Mobile and stock-take corrections are logged too, in a separate section so they never count as used.
- Tap an entry to move it to another day (for a job you logged late) or undo it. Undo puts the stock back and removes the entry.
- Entries are kept for about 400 days. The log starts from the day it was added, and importing a backup or restoring a copy does not add entries.

## No login

Anyone who has the address can read and change the data. If you want to lock it down later, turn on Cloudflare Access for the project (Zero Trust, Access, Applications). The app needs no changes for that.

## Changing the app

Push to a branch other than `main` and Cloudflare builds a preview address for it. Merge to `main` to make it live. Preview deployments use the same database as production when the binding is added for Preview, so test changes with that in mind. The daily copies are the safety net.
