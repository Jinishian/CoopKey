# Set up the CoopKey cloud (Cloudflare Worker + database)

Everything here is done in the Cloudflare dashboard in your browser. No installs, so it works on a Chromebook.
Menu names change now and then, so if a label differs slightly, look for the closest match.

You need two files from this folder: `schema.sql` and `worker.js`.

## Part 1: the database
1. Sign in at dash.cloudflare.com.
2. Go to **Storage & Databases > D1 SQL Database** and choose **Create database**. Name it `coopkey`.
3. Open the new database and go to the **Console** tab.
4. Open `schema.sql`, copy everything, paste it into the console, and run it.
   You should now see three tables: `users`, `vaults`, and `rate`.

## Part 2: the Worker
1. Go to **Workers & Pages > Create > Create Worker**. Name it `coopkey-api` and choose **Deploy** (the sample code is fine for now).
2. Choose **Edit code**. Select all the sample code, delete it, paste in the full contents of `worker.js`, and choose **Deploy**.
3. Open the Worker's **Settings > Bindings > Add > D1 database**.
   - Variable name: `DB` (exactly this, capital letters)
   - Database: `coopkey`
   Save and deploy.
4. Go to **Settings > Variables and Secrets > Add**.
   - Type: **Secret**, name: `JWT_SECRET`
   - Value: a long random string, at least 40 characters (a password manager's generator is ideal).
   Keep a copy somewhere safe. If you ever change it, everyone is signed out.
5. Optional but recommended once your web address exists: add a **Text** variable named `ALLOWED_ORIGINS`
   with your web address, for example `https://coopkey.pages.dev`. Separate several addresses with commas.
   The Android app is always allowed. Leave it empty to allow any address while testing.
6. Check it works: open `https://coopkey-api.YOUR-SUBDOMAIN.workers.dev/health` in your browser.
   You should see `{"ok":true}`. The Worker's page shows its exact address.

## Part 3: connect the app
1. In your GitHub repo, open `www/config.js`, choose the pencil icon, and put your Worker address between the quotes:
   `window.COOPKEY_CLOUD = 'https://coopkey-api.YOUR-SUBDOMAIN.workers.dev';`
2. Commit. Your web app and the next Android build both pick it up. No other file needs to change.
3. Open the app. The sign-in screen now says cloud sync is on. Create your account.

## What it does
- Passwords are salted and hashed (PBKDF2). Sign-in tokens last 60 days. Changing a password signs out other devices.
- Sign-in and sign-up are rate limited.
- Data syncs record by record, so edits from two devices merge instead of one overwriting the other.
- A vault can hold about 1.5 MB of data. Photos are not included and stay on the device that took them.

## Good to know
- There is no password reset email yet. It's on the roadmap. Until then, a forgotten password means asking you to help.
- The Worker already supports changing a password and deleting an account, but the app has no screens for them yet.
- Cloudflare's free tier covers a few hundred test users. Check their current limits before inviting many people.
