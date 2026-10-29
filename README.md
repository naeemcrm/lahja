# Lahja — Arabic dialect → English subtitles (phone web app)

Open any public YouTube video, tap **Translate**, and Gemini listens to it:
detects the dialect (Emirati, Saudi, Egyptian…), writes the Arabic as spoken and
translates it to English. Subtitles are saved on your phone, so rewatching is free and the
transcript works offline.

## Host it (pick one, all free, HTTPS is required)
- **Netlify Drop (easiest):** open app.netlify.com/drop on a computer, drag this folder in,
  you get a https link in seconds.
- **GitHub Pages:** upload these files to a repo → Settings → Pages → deploy from main.
- **Your own hosting (e.g. Hostinger):** upload the files to a folder or subdomain.

## Install on Android
1. Open the https link in **Chrome**.
2. Menu ⋮ → **Add to Home screen** → Install.
3. In the YouTube app: **Share → Lahja** opens the video in the app.

## Setup
Settings (gear) → paste your Gemini API key (aistudio.google.com/apikey) → Save.
Recommended: Gemini 3.6 Flash, 10-minute parts.

## Notes
- Nothing is sent to Gemini until you tap **Translate**. **Stop** finishes the current part, then stops.
- Saved subtitles: stored in the app's on-phone storage (IndexedDB), protected from automatic cleanup when Android allows.
- Videos still stream from YouTube (internet needed). Some owners block playback inside other apps.
- Keep the screen on while watching; phones pause embedded videos when the screen turns off.
- Transcript: tap a line to jump there; **Copy** or **Save .txt** to read it offline.
