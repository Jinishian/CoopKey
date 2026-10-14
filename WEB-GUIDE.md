# Run CoopKey in any browser (Cloudflare Pages)

CoopKey is a single web app, so the same files work in a browser, as an installed app, and inside the Android app.

## Host it
1. Put this project in a GitHub repo (the same one you use for the Android build is fine).
2. In the Cloudflare dashboard go to **Workers & Pages > Create > Pages > Connect to Git** and choose the repo.
3. Build settings: framework **None**, build command **leave empty**, build output directory **`www`**.
4. Choose **Save and Deploy**. You get an address like `https://coopkey.pages.dev`. Every commit to the repo updates it.
5. Optional: add your own domain under the Pages project's **Custom domains**.

## Turn on accounts and sync
Follow `worker/DEPLOY-GUIDE.md`, then set the Worker address in `www/config.js`.
Without it, CoopKey still works in a browser, but each browser keeps its own separate data.

## Install it on a phone or computer
- **Android (Chrome):** open the address, menu (three dots), **Install app**.
- **iPhone (Safari):** Share, **Add to Home Screen**.
- **Computer (Chrome or Edge):** the install icon in the address bar.
Once installed it opens like an app and works offline. Changes sync the next time you're online.

## When you release a new version
Edit the version name in `www/sw.js` (the line starting `const CACHE`) so installed copies refresh.

## Good to know
- iPhone browsers can clear a website's saved data after about a week of not using it, unless the app is added to the Home Screen. Cloud sync protects against that. Without sync, use Settings > Your data > Export now and then.
- Edits are merged by time, so device clocks should be set automatically.
- Existing data on a device from before you turned on accounts doesn't move over by itself. Export it from the old setup (Settings > Your data) and import it after signing in.
- Photos stay on the device that took them.
- Browsers need HTTPS for the camera, copy buttons, and installing. Cloudflare Pages provides it.
