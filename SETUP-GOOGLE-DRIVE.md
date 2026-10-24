# Turning on Google Drive sync

You do this once, as the person hosting the app. Anyone using the app afterwards (you, your partner) just taps **Connect Google Drive** and signs in with their own Google account. Each person's boards go to their own Drive and stay private to them.

It takes about 10 minutes. You need your GitHub Pages address, for example `https://yourname.github.io/moodboard/`.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com> and sign in with your Google account.
2. Open the project picker at the top of the page and choose **New project**. Name it `Moodboard` and create it. Make sure it's selected afterwards.

## 2. Turn on the Google Drive API

1. In the search bar at the top, search for **Google Drive API** and open it.
2. Click **Enable**.

## 3. Set up the sign-in screen

1. Search for **Google Auth Platform** (it may also appear as **OAuth consent screen**) and open it. Click **Get started** if asked.
2. **App information**: app name `Moodboard`, and pick your email as the support email.
3. **Audience**: choose **External**.
4. **Contact information**: your email. Agree to the policy and click **Create**.

## 4. Choose the Drive permission

1. In Google Auth Platform, open **Data Access** and click **Add or remove scopes**.
2. Tick the scope ending in `/auth/drive.file`, described as access to only the specific Google Drive files you use with this app. Click **Update**, then **Save**.

This is the narrowest Drive permission: the app can only see files it creates itself. It can't read anything else in anyone's Drive.

## 5. Create the client ID

1. Open **Clients** and click **Create client**.
2. Application type: **Web application**. Name: `Moodboard web`.
3. Under **Authorised JavaScript origins**, add your GitHub Pages origin: just the scheme and host, with no path and no trailing slash, for example `https://yourname.github.io`.
4. Leave **Authorised redirect URIs** empty and click **Create**.
5. Copy the **Client ID**. It looks like `1234567890-abc123.apps.googleusercontent.com`.

## 6. Fill in the branding details, then publish

Google won't publish the app until it has a homepage and a privacy policy. Both are already part of the app, so upload the app to GitHub first (step 7 can come after).

1. In Google Auth Platform, open **Branding**.
2. Check **App name** (`Moodboard`) and **User support email** are filled in.
3. **Application home page**: your app's address, for example `https://yourname.github.io/moodboard/`
4. **Application privacy policy link**: the same address followed by `privacy.html`, for example `https://yourname.github.io/moodboard/privacy.html`
5. Leave **Terms of service** and the logo empty. (Adding a logo triggers a manual review by Google.)
6. **Authorised domains**: add `yourname.github.io` (your own GitHub Pages domain, not just `github.io`).
7. **Developer contact information**: your email. Click **Save**.
8. Open **Audience** and click **Publish app**, then confirm.

If Google still won't publish, or asks for verification, you can leave the app in **Testing** instead. The catch: only email addresses you add under **Test users** can connect, and everyone has to reconnect every 7 days. Because the app only asks for the narrow `drive.file` permission, Google shouldn't need to review it. The first time someone connects, Google may still show a "Google hasn't verified this app" screen; tap **Advanced**, then **Go to Moodboard**. That's a one-off per person.

## 7. Put the client ID in the app

1. Open `js/config.js` and paste the client ID between the quotes:
   ```js
   export const GOOGLE_CLIENT_ID = '1234567890-abc123.apps.googleusercontent.com';
   ```
2. Open `sw.js` and change `VERSION` at the top (for example to `moodboard-v1.1.1`) so phones pick up the change.
3. Upload both files to your GitHub repository.

The client ID isn't a secret: it only works from your GitHub Pages address, and it gives no access on its own.

## 8. Connect each device

On each phone or laptop: open the app → Settings (the sliders icon) → **Connect Google Drive** → choose the Google account → **Allow**.

Connect the device that already has boards first; other devices then download them on their first sync.

## How it behaves day to day

- Changes sync a few seconds after you make them, when you return to the app, and every minute while it's open.
- Google's browser sign-in lasts about an hour. After that, the cloud icon turns into a yellow **Sync** button; one tap renews it (usually without typing a password) and syncs. Changes made in between are kept on the device and sent on that tap.
- If the same card is changed on two devices before they sync, the most recent change wins.
- In Drive you'll see a `Moodboard` folder containing `moodboard-data.json`, a `files` folder (images and attachments), `backups` (a full backup zip each week, newest 4 kept) and `shared` (board copies you've shared). Don't edit these by hand.
- **Disconnect** (in Settings) stops syncing on that device. Boards stay on the device and in Drive.
