# Burnlist

A small web app that builds a **mood-based Spotify playlist** from your **liked songs**, then **removes each track** when you **Next** (or previous / auto-advance) — **immediately**, no minimum listen time — or after **~20 seconds** on the **same** track if you **don’t** skip. After the **last** track is removed, the app **unfollows** the whole playlist (Spotify’s equivalent of deleting it from your library).

**Live site:** [https://vinisha231.github.io/Burnlist/](https://vinisha231.github.io/Burnlist/)

## How it works

1. Pick a **feeling** (happy, sad, angry, chill, love, hype, feelings) or **theme** (Hip Hop, R&B, J-Pop) and how many **songs** you want (1–50).
2. **Log in with Spotify** (OAuth with PKCE).
3. The app builds a pool from your **liked songs** plus tracks from **playlists you own** (public or private). If you own **at least three** playlists, it uses the **first three** in Spotify’s list order (library order); otherwise it uses **every** playlist you own. It **dedupes** by track, **shuffles**, then matches **mood/theme** if the **primary artist’s genres** fit **or** if **any** credited artist is on a small **curated list** (e.g. R&B → Don Toliver, EsDeeKid). New Burnlists are **public** and **non-collaborative** by default. Spotify does not offer a Web API to “pin” a playlist to your profile; **public** playlists can appear under **Public playlists** if your [Spotify privacy settings](https://www.spotify.com/account/privacy/) allow that.
4. **Open the playlist in Spotify** and play it from any device.
5. **Keep the Burnlist tab open** in your browser: it polls Spotify’s playback API. While this playlist is playing:
   - if you **Next** (or skip away) to another track, the **previous** track is **removed** right away (any listen length);
   - if you **stay** on a track, it is **removed** after **~20 seconds** of playback.
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

Scopes used: playlist modification, library read, private and collaborative playlist read (to read tracks from playlists you own), and **playback state** (position and skips).

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
