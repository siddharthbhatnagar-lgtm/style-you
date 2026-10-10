# Style You 6.4.2 — real-phone release checklist

Run on at least one iPhone and one Android phone. Record phone/browser, pass/fail and a screenshot for every failure. Items marked **must pass** block release.

## A. Update and existing data

1. **(must pass)** Upgrade an existing 6.4.1 installation to 6.4.2. Wardrobe, Looks, actual-outfit photos, Style DNA, active occasions and AI Inbox history remain.
2. Settings → About shows **6.4.2**.

## B. Backup integrity

3. **(must pass)** Make a backup containing wardrobe photos, an AI preview and a What I wore photo. Delete everything, restore the backup, and confirm every image plus metadata returns.
4. **(must pass)** Immediately tap **Undo** after restore. The previous state and previous images return; images that existed only in the restored backup are gone.
5. Repeat restore with the phone nearly full or using a deliberately oversized backup if practical. A failed restore must say nothing was changed and must not leave imported orphan images.

## C. Temporary-photo privacy

6. With “remember my styling photo” off, use **See it on me** or **My colours** with a new full-length photo. Finish the helper, close/reopen Style You, and confirm the source photo is not retained as a saved profile image.

## D. AI Inbox recovery

7. **(must pass)** Share/paste an AI reply that cannot be matched to an occasion. Open AI Inbox → **View full reply**. The complete reply is present, not only a snippet. **Copy full reply** copies the complete text.
8. With a related session, **Open related session** returns to the correct occasion.

## E. Accessibility and 320 px layout

9. At the narrowest phone width available, Settings has no horizontal scrolling. The four appearance choices are readable and Delete everything stays within the screen.
10. With a hardware keyboard if available, open Delete everything. Tab and Shift+Tab stay inside the dialog; focus returns to the launching control when it closes.
11. The Open-Meteo attribution is easy to tap without precision aiming.

## F. AI prompt/privacy rules

12. **(must pass)** Start an occasion using Both/Any. Inspect **See what we'll send**: it must not ask Gemini/ChatGPT to decide gender/presentation or whether the person looks like an adult/child.
13. The 18+ checkbox remains required during first setup.

## G. Share Target limits

14. Android: share several normal photos to Style You; they import normally.
15. Android: share an intentionally very large group of images. Style You must reject excess images without crashing and surface a readable warning in the returned text/AI Inbox.

## H. Core occasion regression

16. **(must pass)** Gemini: Brief → three looks → choose → products when missing → styled preview → save.
17. **(must pass)** Switch preview only to ChatGPT and repeat the preview in a fresh chat. The request is self-contained and includes the source photo.
18. **(must pass)** With two active occasions, return a reply containing the older occasion's `STYLEYOU_SESSION` ID. It attaches to the older occasion.
19. iPhone Home Screen → AI return link opens Safari with the “open Style You from your Home Screen” guidance rather than setup.

## I. Final smoke test

20. Offline reload works after the site has been loaded once.
21. Update banner appears after replacing the live GitHub Pages files with a newer test version.
22. No sideways scrolling, uncaught script errors or dead controls are visible on Home, Wardrobe, Create, Looks, AI Inbox, Storage, Backup and Settings.
