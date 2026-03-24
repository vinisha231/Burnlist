import { getAccessTokenFromCode, redirectToSpotifyAuth } from './auth.js';

const BURN_MS = 20_000;
const POLL_MS = 1500;

const SONG_MIN = 1;
const SONG_MAX = 50;

function clampSongCount(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 15;
  return Math.min(SONG_MAX, Math.max(SONG_MIN, n));
}

const moodGenres = {
  happy: ['pop', 'dance', 'funk', 'party'],
  sad: ['piano', 'acoustic', 'sad'],
  angry: ['metal', 'rock', 'punk', 'phonk'],
  chill: ['lofi', 'ambient', 'chill'],
  love: ['rnb', 'romantic', 'soul', 'soft'],
  hype: ['rap', 'hip hop', 'edm']
};

function setupLogin() {
  document.getElementById('login-btn').addEventListener('click', () => {
    const mood = document.getElementById('mood').value;
    const songCount = clampSongCount(document.getElementById('song-count').value);
    document.getElementById('song-count').value = String(songCount);
    localStorage.setItem('selectedMood', mood);
    localStorage.setItem('playlistSongCount', String(songCount));
    redirectToSpotifyAuth();
  });
}

function clearOAuthQuery() {
  const path = window.location.pathname;
  window.history.replaceState({}, document.title, path);
}

/** Up to 50 IDs per request — avoids one HTTP call per track. */
async function fetchArtistMap(artistIds, headers) {
  const unique = [...new Set(artistIds)].filter(Boolean);
  const map = new Map();
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const res = await fetch(
      `https://api.spotify.com/v1/artists?ids=${encodeURIComponent(batch.join(','))}`,
      { headers }
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Artists ${res.status}: ${detail}`);
    }
    const data = await res.json();
    for (const a of data.artists || []) {
      if (a?.id) map.set(a.id, a);
    }
  }
  return map;
}

async function removeTrackFromPlaylist(playlistId, trackUri, headers) {
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: [{ uri: trackUri }] })
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn('[Burnlist] Remove track failed:', res.status, err);
  }
}

function startBurnMonitor(playlistId, headers, statusElement, openLinkEl) {
  const playlistUri = `spotify:playlist:${playlistId}`;
  let lastTrackUri = null;
  let lastProgress = 0;
  const burnedUris = new Set();
  let emptyNotified = false;

  async function maybeUnfollowIfEmpty() {
    if (emptyNotified) return;
    const countRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=total`,
      { headers }
    );
    if (!countRes.ok) return;
    const { total } = await countRes.json();
    if (total !== 0) return;
    emptyNotified = true;
    statusElement.textContent = 'Playlist burned — empty. Make a new Burnlist anytime.';
    await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
      method: 'DELETE',
      headers
    }).catch(() => {});
  }

  const tick = async () => {
    const res = await fetch('https://api.spotify.com/v1/me/player', { headers });
    if (res.status === 401) {
      statusElement.textContent = 'Session expired — log in again.';
      return;
    }
    if (res.status === 204 || !res.ok) {
      openLinkEl.hidden = false;
      statusElement.textContent =
        'Open Spotify, start playing your Burnlist playlist on any device — we will remove each track after 20s or when you skip.';
      return;
    }

    const player = await res.json();
    const ctx = player.context;
    const item = player.item;

    if (!item || !ctx || ctx.type !== 'playlist' || ctx.uri !== playlistUri) {
      openLinkEl.hidden = false;
      statusElement.textContent =
        'Play this playlist in Spotify (any device). Tracks disappear after 20 seconds or when you skip.';
      return;
    }

    openLinkEl.hidden = false;
    const currentUri = item.uri;
    const progress = player.progress_ms ?? 0;

    if (lastTrackUri === null) {
      lastTrackUri = currentUri;
      lastProgress = progress;
      statusElement.textContent = 'Burnlist active — listening…';
      return;
    }

    if (currentUri !== lastTrackUri) {
      if (!burnedUris.has(lastTrackUri)) {
        await removeTrackFromPlaylist(playlistId, lastTrackUri, headers);
        burnedUris.add(lastTrackUri);
        statusElement.textContent = 'Skipped — track removed from playlist.';
        await maybeUnfollowIfEmpty();
      }
      lastTrackUri = currentUri;
      lastProgress = progress;
      return;
    }

    if (!burnedUris.has(currentUri) && progress >= BURN_MS) {
      await removeTrackFromPlaylist(playlistId, currentUri, headers);
      burnedUris.add(currentUri);
      statusElement.textContent = '20s played — track removed from playlist.';
      await maybeUnfollowIfEmpty();
    }

    lastProgress = progress;
  };

  tick();
  return setInterval(tick, POLL_MS);
}

async function runAfterAuth(accessToken) {
  clearOAuthQuery();

  const statusElement = document.getElementById('status');
  const burnPanel = document.getElementById('burn-panel');
  const openLink = document.getElementById('open-playlist-link');

  statusElement.textContent = '🎧 Logged in! Scanning your likes…';

  const headers = { Authorization: 'Bearer ' + accessToken };
  const mood = localStorage.getItem('selectedMood') || 'chill';
  const targetCount = clampSongCount(localStorage.getItem('playlistSongCount'));
  const moodList = moodGenres[mood] || moodGenres.chill;

  const user = await fetch('https://api.spotify.com/v1/me', { headers }).then((r) => r.json());
  if (user.error) {
    statusElement.textContent = 'Could not load your profile.';
    return;
  }
  const userId = user.id;

  const selectedUris = [];
  let offset = 0;

  try {
    while (selectedUris.length < targetCount) {
      const res = await fetch(
        `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`,
        { headers }
      );
      if (!res.ok) {
        statusElement.textContent = `Could not load liked songs (${res.status}). Try again.`;
        return;
      }
      const data = await res.json();
      if (!data.items?.length) break;

      const tracks = data.items.map((item) => item.track).filter(Boolean);
      const artistIds = tracks.map((t) => t.artists[0]?.id).filter(Boolean);

      const artistMap = await fetchArtistMap(artistIds, headers);

      for (const track of tracks) {
        const artistId = track.artists[0]?.id;
        if (!artistId) continue;
        const artistData = artistMap.get(artistId);
        if (!artistData) continue;
        const artistGenres = artistData.genres || [];
        const match = artistGenres.some((g) =>
          moodList.some((mg) => g.toLowerCase().includes(mg.toLowerCase()))
        );
        if (match) {
          selectedUris.push(track.uri);
          if (selectedUris.length >= targetCount) break;
        }
      }

      statusElement.textContent = `Scanning your likes… (${selectedUris.length}/${targetCount} matches)`;

      offset += 50;
      if (tracks.length < 50) break;
    }
  } catch (e) {
    console.error(e);
    statusElement.textContent =
      'Something went wrong talking to Spotify. Wait a minute and try again, or check the browser console.';
    return;
  }

  if (!selectedUris.length) {
    statusElement.textContent = 'No liked songs matched this mood. Like more tracks or pick another mood.';
    return;
  }

  const countNote =
    selectedUris.length < targetCount
      ? ` (${selectedUris.length} matched; you asked for ${targetCount})`
      : ` (${selectedUris.length} songs)`;

  const playlist = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `Burnlist — ${mood.toUpperCase()} 🔥`,
      description: 'Tracks remove themselves after ~20s of play or when you skip.',
      public: true
    })
  }).then((r) => r.json());

  if (playlist.error) {
    statusElement.textContent = 'Could not create playlist.';
    return;
  }

  await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uris: selectedUris })
  });

  localStorage.setItem('burnlist_id', playlist.id);
  localStorage.setItem('burnlist_token', accessToken);

  const webUrl = playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;
  openLink.href = webUrl;
  openLink.hidden = false;
  burnPanel.hidden = false;

  statusElement.innerHTML = `Playlist ready${countNote}. <strong>Open Spotify</strong> and play it — each song leaves the list after 20 seconds or when you skip.`;

  startBurnMonitor(playlist.id, headers, statusElement, openLink);
}

window.onload = async () => {
  const hasCode = new URLSearchParams(window.location.search).has('code');

  if (!hasCode) {
    setupLogin();
    return;
  }

  const accessToken = await getAccessTokenFromCode();
  if (!accessToken) {
    document.getElementById('status').textContent = 'Login failed — try again.';
    setupLogin();
    return;
  }

  await runAfterAuth(accessToken);
};
