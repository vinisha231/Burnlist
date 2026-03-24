# Burnlist

A small web app that builds a **mood-based Spotify playlist** from your **liked songs**, then **removes each track** after you’ve heard about **20 seconds** of it or **skipped** it. After the **last** track is removed, the app **unfollows** the whole playlist (Spotify’s equivalent of deleting it from your library).

**Live site:** [https://vinisha231.github.io/Burnlist/](https://vinisha231.github.io/Burnlist/)

## How it works

1. Pick a **mood** (happy, sad, angry, chill, love, hype) and how many **songs** you want (1–50).
2. **Log in with Spotify** (OAuth with PKCE).
3. The app scans your **liked tracks** in a **random order** each run (shuffled pages and songs per page), keeps ones whose artists’ genres fit the mood, then **shuffles** the final pick so the same mood twice in a row usually yields a **different** set and order. It creates a **public, non-collaborative** playlist. Spotify does not offer a Web API to “pin” a playlist to your profile; **public** playlists can appear under **Public playlists** on your profile if your [Spotify privacy settings](https://www.spotify.com/account/privacy/) allow that.
4. **Open the playlist in Spotify** and play it from any device.
5. **Keep the Burnlist tab open** in your browser: it polls Spotify’s playback API. While this playlist is playing:
   - after **~20 seconds** on a track, that track is **removed** from the playlist;
   - if you **skip** to the next track first, the **previous** track is **removed**.
   - when you skip the **last** track (or playback stops), the final track is removed after a short idle detection; as soon as **no songs are left**, the app **unfollows the entire playlist** so it disappears from **Your Library** (Spotify may briefly show an empty list in some clients).

If there aren’t enough mood matches, you’ll get fewer songs than you asked for.

### Blocked artists, takedowns, and unplayable tracks

Spotify’s API exposes **`is_playable`** and sometimes **`restrictions`** (e.g. market, licensing). Burnlist **skips** liked songs that are already marked **not playable** or **restricted** when scanning likes, then **re-checks** every chosen track with **`GET /v1/tracks`** and **`market=from_token`** (often stricter than saved-tracks alone). After the playlist is created, a **cleanup** pass removes anything still flagged unplayable.

**“Blocked” in the Spotify app (Don’t play this artist)** is **not** in the Web API, so the app cannot read your block list. If a blocked artist’s song is still in your **liked songs**, it can be picked until Spotify marks it unplayable on the endpoints above.

**Optional:** set a **manual block list** in the browser (same device you use for Burnlist). In DevTools → Console, run once, using the artist’s Spotify ID (from the artist URL: `spotify.com/artist/<ID>`):

```js
localStorage.setItem('burnlistBlockedArtistIds', 'ARTIST_ID_1,ARTIST_ID_2');
```

Burnlist will skip any track that credits those artists. Clear with `localStorage.removeItem('burnlistBlockedArtistIds')`.

You can also **remove that like** in Spotify so it won’t be chosen again.

**If a track still won’t play:** use **Skip** in the app — the Burnlist tab removes rows when playback moves on. **Dead / `null` rows** may need a manual remove in Spotify; the API usually needs a track URI.

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
