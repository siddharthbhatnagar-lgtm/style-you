# Style You 6.4.2

Style You is a free, local-first personal styling PWA. This release is a **hardening update to 6.4.1**: it focuses on data integrity, privacy, recovery, accessibility and narrow-screen robustness rather than adding a new styling flow.

## What changed in 6.4.2

- Transactional backup restore with media rollback on failure and on Undo.
- Temporary AI-helper photos are memory-only unless the user explicitly chooses to keep a styling photo.
- AI Inbox keeps the full unmatched text reply for recovery and lets the user copy it.
- Modal focus is contained in the active sheet; the underlying app is inert while a sheet is open.
- 320 px Settings layout no longer forces the appearance selector or Delete Everything button off-screen.
- Weather attribution has a larger touch target.
- AI prompts do not infer adulthood or gender/presentation from the user's photograph.
- Android Share Target now caps the total incoming image payload as well as each image.

See `QA_REPORT.md` for the tests that were actually run and `PHONE_TEST_CHECKLIST.md` for the remaining real-device release gate.

## Put it online (GitHub Pages)

1. Open your repository on github.com.
2. Delete the old app files (keep the repository itself).
3. Choose **Add file → Upload files** and drag in **everything inside the `upload` folder**. Include the hidden `.nojekyll` file if your computer shows it. Tap **Commit changes**.
4. Wait 1–2 minutes, then open the site on your phone.
5. Phones that already have Style You should show **"New version – tap to update"**. Tap it. Your wardrobe and looks should remain; verify this with the phone checklist.

People on 6.2, 6.3, 6.4.0 or 6.4.1 are expected to keep their data. Verify the upgrade on a real phone before wide release.

## What 6.4 changed from 6.3

**Fixes**

- **Sending to the AI (D1).** The steps now match what this phone can really do:
  - Phones that can share pictures straight into Gemini or ChatGPT get one **Send** button.
  - Other phones get **Save your photo** and **Save the wardrobe sheet** buttons, then "attach them, paste the request".
  - Style You never says it sent a photo when it didn't.
- **Requests stand alone (D2).** The styled-picture and "this doesn't match" requests refer to the photo attached to that message, and the photo is sent with both. A new chat, or switching between Gemini and ChatGPT, works.
- **Photo check (D3).** The request says "Image 1 is my photo, Image 2 is the clothes sheet", and the AI checks Image 1 only.
- **Return link (D4).** If a link from the AI app opens a browser where Style You holds nothing, you're told to open Style You from your Home Screen. You no longer land on setup.
- **Replies find their occasion (D5).** The AI is asked to repeat the occasion's code at the top of its reply. A shared or pasted reply goes to that occasion. Without the code, it goes to the only occasion waiting for it, or you choose.
- **AI app for each step (D6, D7).**
  - The occasion's ⋯ menu has **AI for this occasion**, where you pick Gemini or ChatGPT for Looks, Shopping and Styled preview. That choice always wins.
  - "Use … instead" now works on the "This doesn't match" panel.
- **Style DNA (D8, D9).**
  - "Add a preference" opens an empty box and saves nothing blank.
  - Your style notes and your learned preferences are both sent, labelled. Today, Plan my week and occasions all use them.
  - Learning uses more of your ratings and choices, needs a thing to happen twice, and never makes up a generic sentence.
  - Rebuild keeps lines you wrote yourself.
- **Outfit engine (D10).**
  - Season tags are matched to the weather: a "Hot"-only piece isn't suggested on a cold day while other pieces fit.
  - Occasion tags give a boost.
  - A clashing second colour lowers a match.
  - Pieces without tags behave exactly as before.
- **Item editor (D11).** The second colour has a **None** option. Every tag on a piece, including ones the AI added, is shown and can be removed.
- **Readability (D12).** The AI screens are readable in light and dark mode.
- **iPhone tip (D13).** Every iPhone user in a Safari tab is told to add Style You to the Home Screen.
- **Name optional (D14).** You can finish setup and save your profile without a name.
- **Sharper wardrobe sheet (D15).** The clothes sheet sent to the AI is made from the larger photos.

**Improvements**

- **AI apps screen (I4).** Simpler wording. Browser details moved to Settings → About → Troubleshooting, in plain words.
- **Home shortcuts (I5).** Mix & Match and Plan my week are on Home again.
- **AI suggestion vs what you wore (I6).** On a saved look you see the AI picture beside "What I wore", side by side or with a slider. Tap a picture to see it full screen. If one of them is missing, the look offers to add it, including **See it on me**.
- **Steps show their app (I7).** The progress bar of an occasion shows which app each step uses. Tap it to change.
- **Laundry's back (I8).** One tap on Today or in Wardrobe brings every laundry piece back, with Undo. **Mark Available** is always shown on a piece in the laundry. Nothing comes back by itself.
- **Use only my wardrobe (I9).** A switch on the occasion questions: the looks use only your clothes and the shopping step is skipped.
- **Insights (I10).** Wardrobe shows your most worn pieces, pieces not worn in 60 days and the colours you love.
- **I bought this (I11).** On a saved look, a missing piece can be added to your wardrobe in one tap.

**Owner decisions kept**

- Adults only, and Gemini is the default.
- Products come before the styled picture when pieces are missing.
- Your original full-length photo isn't kept after an occasion, unless you turn on "Keep my photo" in Settings → Storage & privacy.

## For a developer

The app is written as separate files in `developer/src` and turned into the flat upload folder by one build step:

```
cd developer
node build.mjs                   # writes dist/ — the same files as the upload folder
```

- **Version:** the version number lives in one place, `src/version.json`. The build writes it into `app.js` and `sw.js`, along with the list of files the app keeps for offline use. Change the version for every release, or installed phones won't update.
- **Modules:** each module in `src/js` is listed in `src/ORDER`.
- **Tests:** `tests/run-all.sh` runs every check. That is the release gate described in `QA_REPORT.md`. It needs Node 18+, Python 3 and Playwright with Chromium:

  ```
  npm install playwright@1.56 axe-core
  ```

  The undefined-name check also needs `npm install eslint@9 globals@15`. The tests find these in a `node_modules` folder next to `tests`, or wherever `SY_NODE_MODULES` (Playwright and axe-core) and `SY_NODE_MODULES_LINT` (ESLint) point.
- **Baseline:** `tests/baseline63` holds the 6.3.0 modules. One test uses them to prove the outfit engine gives the same results as 6.3 for pieces without tags.

## Credits

Weather data by [Open-Meteo.com](https://open-meteo.com/). It's free for non-commercial use, and the credit is shown in the app. Fonts are Figtree and Manrope under the SIL Open Font License, stored with the app.
