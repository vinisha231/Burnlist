# Burnlist

A small web app that builds a **mood-based Spotify playlist** from your **liked songs**, then **removes each track** after you’ve heard about **20 seconds** of it or **skipped** it. When the playlist is empty, it unfollows itself so it drops out of your library.

**Live site:** [https://vinisha231.github.io/Burnlist/](https://vinisha231.github.io/Burnlist/)

## How it works

1. Pick a **mood** (happy, sad, angry, chill, love, hype) and how many **songs** you want (1–50).
2. **Log in with Spotify** (OAuth with PKCE).
3. The app scans your **liked tracks**, keeps ones whose artists’ genres fit the mood, and creates a **public** playlist.
4. **Open the playlist in Spotify** and play it from any device.
5. **Keep the Burnlist tab open** in your browser: it polls Spotify’s playback API. While this playlist is playing:
   - after **~20 seconds** on a track, that track is **removed** from the playlist;
   - if you **skip** to the next track first, the **previous** track is **removed**.

If there aren’t enough mood matches, you’ll get fewer songs than you asked for.

## Spotify setup (for forks / local dev)

- Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
- Add a **Redirect URI** that matches `REDIRECT_URI` in `auth.js` (GitHub Pages uses `https://vinisha231.github.io/Burnlist/`).
- Put your **Client ID** in `auth.js` as `CLIENT_ID`.

Scopes used: playlist modification, library read, private playlist read, and **playback state** (to know position and skips).

## Run locally

Serve the folder over HTTP (ES modules and OAuth need a real origin). For example:

```bash
npx serve .
```

Use a redirect URI registered in the Spotify app that matches how you open the app (e.g. `http://127.0.0.1:3000/` if you use that port).

## Files

| File        | Role |
|------------|------|
| `index.html` | Mood + song count + login UI |
| `main.js`    | Playlist build, burn logic, playback polling |
| `auth.js`    | PKCE OAuth helpers |
| `style.css`  | Styles |
