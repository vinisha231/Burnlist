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

  statusElement.textContent = '🎧 Logged in! Creating your mood-based playlist…';

  const headers = { Authorization: 'Bearer ' + accessToken };
  const mood = localStorage.getItem('selectedMood') || 'chill';
  const targetCount = clampSongCount(localStorage.getItem('playlistSongCount'));

  const user = await fetch('https://api.spotify.com/v1/me', { headers }).then((r) => r.json());
  if (user.error) {
    statusElement.textContent = 'Could not load your profile.';
    return;
  }
  const userId = user.id;

  let allTracks = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`,
      { headers }
    );
    const data = await res.json();
    if (!data.items?.length) break;
    allTracks.push(...data.items.map((item) => item.track));
    offset += 50;
  }

  const selectedUris = [];
  for (const track of allTracks) {
    const artistId = track.artists[0]?.id;
    if (!artistId) continue;

    const artistRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers });
    const artistData = await artistRes.json();
    const artistGenres = artistData.genres || [];
    const moodList = moodGenres[mood] || moodGenres.chill;
    const match = artistGenres.some((g) => moodList.some((mg) => g.includes(mg)));
    if (match) {
      selectedUris.push(track.uri);
    }
    if (selectedUris.length >= targetCount) break;
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
