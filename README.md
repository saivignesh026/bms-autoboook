# bms-autobook

Chrome and Firefox WebExtension for monitoring saved BookMyShow seat zones, assisting checkout, and sending the payment QR and selected-seat image to a profile's Discord webhook. Payment is completed manually.

## Features

- Separate theatre profiles with contact details, ticket count, saved zones, and Discord webhook.
- Named seat zones drawn directly on the map using normalized coordinates.
- Seat checks every 500 ms and randomized sold-out reloads.
- Seat-center clicks with verification of the requested selected-seat count before Pay.
- Quantity selection, food-and-beverage Skip, contact submission, and QR payment selection.
- Bundled html2canvas 1.4.1 capture using the supplied Tampermonkey v67 screenshot routines in the page context.
- One Discord message containing `qr_code.jpg` and `seat_map.jpg`, with delivery status and retries.
- Automatic return to the saved seat map five minutes after a visible payment/booking-success confirmation. **Stop** cancels monitoring and pending restarts.

## Install in Firefox

Requires Firefox 128 or newer.

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on** and choose this folder's `manifest.json`.
4. Reload the BookMyShow tab. Disable the corresponding Tampermonkey scripts to avoid running both automations.

Temporary add-ons are removed when Firefox restarts. After updating these files, reload the extension in `about:debugging` and reload the booking tab.

## Install in Chrome / Edge

Requires Chrome 121 or newer, or a corresponding Chromium-based Edge version.

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`) and enable **Developer mode**.
3. Select **Load unpacked** and choose this repository's folder.
4. Reload the BookMyShow tab. Disable the corresponding Tampermonkey scripts to avoid running both automations.

The same manifest supports both browsers: Chrome uses the background service worker, while Firefox uses the background scripts. No manifest edits are needed. After updating these files, reload the extension on the extensions page and reload the booking tab.

## Use

1. Open the extension and select **Manage / copy profiles**.
2. Enter the theatre, email, mobile number, ticket count, and Discord webhook. Save and test Discord.
3. Open the desired show's seat layout, choose **Adjust seats**, draw and name your target zones, and save.
4. Click **Start**. Follow progress and errors in the page panel or popup.
5. When the QR arrives in Discord, complete payment yourself. Keep the booking tab open for success detection and the five-minute restart timer.
6. Click **Stop** whenever you want monitoring to end.

A running cycle uses a snapshot of its profile. Different profiles can run in separate tabs. Review saved zones when changing theatres or the map's internal zoom/pan.

## Project layout

```text
manifest.json             Chrome and Firefox extension configuration
background.js             Profiles, per-tab state, page capture bridge, Discord uploads
content.js                Seat cropper, monitoring, checkout, and restart timer
capture.js                Tampermonkey v67 screenshot and QR extraction routines
core.js                   Shared validation and canvas helpers
popup.html / popup.js     Extension popup
options.html / options.js Theatre profile settings
ui.css                    Popup and settings styles
icons/                    Extension icons
vendor/                   html2canvas 1.4.1 and its MIT license
tests/                   Runtime regression tests and minimal reference fixtures
```

## Development checks

No package installation or build step is required. With Node.js 18 or newer, run from the repository root:

```sh
node tests/runtime.test.cjs
```

The tests cover screenshot options and source parity, seat selection, checkout timing, per-tab image persistence, Discord multipart attachments, retry behavior, the five-minute restart, and Stop cancellation. Tests mock browser APIs and network delivery; they do not make bookings or send live Discord messages.

The minimal reference functions in `tests/fixtures/tampermonkey-v67.js` contain no personal configuration or credentials.

## Data and permissions

Profiles and booking images are stored in extension storage. Contact details are used for checkout; the configured Discord webhook receives notifications and captured images. Webhook details stay in the background context. Capture uses the bundled library, without browser screenshot permissions or external image hosting.

Permissions are limited to extension storage, notifications, script execution, BookMyShow hosts, and Discord. Keep webhook URLs and personal profile exports out of source control. The bundled dependency's license is in `vendor/html2canvas.LICENSE.txt`.
