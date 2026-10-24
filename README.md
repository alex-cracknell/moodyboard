# Moodboard

A Milanote-style moodboard app that runs in Chrome on your phone or laptop. Every board, card, image and file is stored on the device itself (in the browser's IndexedDB storage). GitHub Pages only serves the app's code. Optionally, each person can sync their boards between their own devices through their own Google Drive (see SETUP-GOOGLE-DRIVE.md).

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `moodboard`.
2. Upload everything in this folder to the root of the repository (keep the folder structure: `index.html`, `sw.js`, `manifest.webmanifest`, `css/`, `js/`, `fonts/`, `icons/`).
3. In the repository, go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
4. After a minute or so the app is live at `https://<your-username>.github.io/moodboard/`.

## Install it on the phone

1. Open the address above in Chrome on the phone.
2. Tap the ⋮ menu and choose **Install app** (or **Add to home screen**).
3. Open it from the home screen icon from now on.

Installing matters: the installed app opens full screen, works offline, can receive images shared from other apps, and Chrome is much less likely to clear its storage.

## Sync between phone and laptop

The same address works in Chrome on a laptop (you can install it there too from the address bar). To keep devices in step, turn on Google Drive sync: follow SETUP-GOOGLE-DRIVE.md once, then tap **Connect Google Drive** in Settings on each device. Each person signs in with their own Google account, so their boards stay private.

With sync on, a full backup zip is also saved to Drive each week, and the backup reminder only appears if sync stops working.

To give someone a copy of one board: open it, ⋮ → **Share a copy**. The board goes into your Drive with a link you can send. They download it and use Settings → Import a backup → Add to my boards. (Without Drive connected, use ⋮ → Export this board and send the file.)

## Backups

- **Back up**: Settings → Back up now. The app builds a single `.zip` file (a `manifest.json` describing your boards plus a `files/` folder of images and attachments), then lets you save it to a folder you choose (where Chrome supports that) or download it to Downloads. Move a copy off the phone, for example to Google Drive or your NAS.
- **Export one board**: open the board, ⋮ → Export this board. Same format, just that board and anything inside it.
- **Restore**: Settings → Import a backup (or "Restore a backup" on an empty home screen). Choose **Add to my boards** to keep what's there and add or update boards from the file, or **Replace everything** to wipe the phone first.
- **Reminders**: a banner on the home screen reminds you to back up. Dismiss it with the ✕ (it comes back the next day), change how often in Settings, or turn reminders off. It only appears when something has changed since your last backup.

## What you can put on a board

Notes (bold, italic, strikethrough, headings, lists, quotes), headings, images (gallery, camera, paste or shared from other apps), to-do lists, links (YouTube links show their thumbnail), columns, boards inside boards, colour swatches, sketches, lines and arrows between cards, comments, files of any type (video and audio play inline) and voice notes.

## Using the canvas

- Drag empty space to move around; pinch to zoom. On a laptop, scroll to move and Ctrl+scroll (or pinch the trackpad) to zoom.
- On a laptop you can drag image files, other files or links straight onto a board, and paste with Ctrl+V.
- Tap a card to select it; tap it again (or double-tap) to edit or open it.
- Drag a card to move it; drag it onto a column to put it in the column.
- Double-tap empty space to drop a note there; press and hold empty space to choose what to add there.
- Press and hold a card for more options. The yellow dot on a selected card resizes it.
- Select a card and tap **Connect**, then tap another card, to draw an arrow between them. Drag a line's ends onto cards to attach them.
- Undo and redo are in the top bar.

## Updating the app later

When you change any file, also change `VERSION` at the top of `sw.js` (for example `moodboard-v1.0.1`). Phones then download the new version and show an "An update is ready" message with a Reload button. Your boards are not affected by updates.

## Limits worth knowing

- Without sync, data lives in Chrome on that one device. Clearing Chrome's site data for the app, or uninstalling it, deletes your boards. Back up, or turn on sync.
- Websites block other sites from reading their pages, so link cards can't fetch previews automatically; you can add your own picture to a link card.
- Chrome on Android may not offer sharing a `.zip` file through the share sheet; the Download and Save to a folder options always work.
