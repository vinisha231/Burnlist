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

function randomBelow(n) {
  if (n <= 0) return 0;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** All saved tracks (liked songs). */
async function fetchAllSavedTracks(headers) {
  const out = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}&market=from_token`,
      { headers }
    );
    if (!res.ok) return out;
    const data = await res.json();
    if (!data.items?.length) break;
    for (const item of data.items) {
      if (item.track) out.push(item.track);
    }
    offset += 50;
  }
  return out;
}

/** Playlists owned by the user (public or private). Order follows Spotify’s /me/playlists response. */
async function fetchOwnedPlaylistRecords(headers, userId) {
  const out = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) break;
    const data = await res.json();
    for (const p of data.items || []) {
      if (p?.owner?.id === userId && p.id) out.push(p);
    }
    url = data.next || null;
  }
  return out;
}

/**
 * If the user owns 3+ playlists, use the first 3 in API order (library order).
 * Otherwise use every playlist they own.
 */
function pickPlaylistIdsForTracks(ownedRecords) {
  if (ownedRecords.length === 0) return [];
  if (ownedRecords.length >= 3) return ownedRecords.slice(0, 3).map((p) => p.id);
  return ownedRecords.map((p) => p.id);
}

/** All tracks in a playlist (paginated). Skips episodes and local files. */
async function fetchAllTracksForPlaylist(playlistId, headers) {
  const out = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&market=from_token`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) break;
    const data = await res.json();
    for (const row of data.items || []) {
      const t = row.track;
      if (!t || t.type !== 'track' || t.is_local) continue;
      out.push(t);
    }
    url = data.next || null;
  }
  return out;
}

function dedupeTracksByUri(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks) {
    if (!t?.uri || t.type !== 'track') continue;
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    out.push(t);
  }
  return out;
}

/** Spotify does not expose “blocked artists” in the Web API; users can set IDs in localStorage (see README). */
function getBlockedArtistIdsFromStorage() {
  const raw = localStorage.getItem('burnlistBlockedArtistIds') || '';
  return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

function trackTouchesBlockedArtist(track, blockedIds) {
  if (!blockedIds.length) return false;
  return (track.artists || []).some((a) => a?.id && blockedIds.includes(a.id));
}

/** Fresh `GET /tracks` often has more accurate `is_playable` / restrictions than saved-tracks alone. */
async function filterUrisToFreshPlayable(trackUris, headers) {
  if (!trackUris.length) return [];
  const ids = trackUris
    .map((uri) => {
      const parts = uri.split(':');
      return parts.length >= 3 && parts[1] === 'track' ? parts[2] : null;
    })
    .filter(Boolean);

  const playableIds = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(
      `https://api.spotify.com/v1/tracks?ids=${encodeURIComponent(batch.join(','))}&market=from_token`,
      { headers }
    );
    if (!res.ok) {
      batch.forEach((id) => playableIds.add(id));
      continue;
    }
    const data = await res.json();
    const arr = data.tracks || [];
    for (let j = 0; j < arr.length; j++) {
      const t = arr[j];
      const id = batch[j];
      if (!t || !id) continue;
      if (isLikelyPlayableTrack(t)) playableIds.add(id);
    }
  }

  return trackUris.filter((uri) => {
    const parts = uri.split(':');
    const id = parts.length >= 3 ? parts[2] : null;
    return id && playableIds.has(id);
  });
}

const moodGenres = {
  happy: ['pop', 'dance', 'funk', 'party'],
  sad: ['piano', 'acoustic', 'sad'],
  angry: ['metal', 'rock', 'punk', 'phonk'],
  chill: ['lofi', 'ambient', 'chill'],
  love: ['rnb', 'romantic', 'soul', 'soft'],
  hype: ['rap', 'hip hop', 'edm'],
  /** Emotional / introspective — genres + optional vibe artists below */
  feelings: [
    'indie',
    'soul',
    'bedroom pop',
    'alternative r&b',
    'alt r&b',
    'emo rap',
    'singer-songwriter',
    'heartbreak',
    'melancholia'
  ],
  hiphop: [
    'hip hop',
    'rap',
    'trap',
    'drill',
    'cloud rap',
    'southern hip hop',
    'west coast hip hop',
    'east coast hip hop',
    'gangster rap'
  ],
  rnb: [
    'r&b',
    'rnb',
    'neo soul',
    'contemporary r&b',
    'contemporary rnb',
    'alternative r&b',
    'alt r&b',
    'urban contemporary'
  ],
  jpop: ['j-pop', 'jpop', 'japanese', 'anime', 'city pop', 'j-rock', 'japanese pop', 'kawaii']
};

/**
 * Spotify artist IDs that always count as matching that vibe (on top of genre tags).
 * Genres from the API are often incomplete; this nudges R&B, hip hop, etc. toward known artists.
 */
const moodVibeArtists = {
  rnb: [
    '4Gso3d4CscCijv0lmajZWs', // Don Toliver
    '0EyhkwP3UnwGFBy6xwKjSy', // EsDeeKid
    '7tYKF4AwGiZ7pzMWlG6Uw5', // SZA
    '6XK9f2J6CVjnmJyC0hPkKm' // Brent Faiyaz
  ],
  hiphop: [
    '3TVXtAsR1InLMwjdDAPd1', // Drake
    '0Y5tJV1FHgvjRnXSFUy8X7', // Travis Scott
    '1RyvY7e3zZ3B9bxN6cJe9u' // Future
  ],
  feelings: [
    '1Xyo4u2uQC4oBc3zbzVmLJ', // The Weeknd
    '66CXWjxzNUsdJxJ2JdwvnR', // Ariana Grande
    '06HL4z0CvFAxyc27GXpf02' // Taylor Swift
  ],
  jpop: [
    '7lbSsjNp0GjN4Xn3lbHNUe', // Yoasobi (example; genre still primary for J-Pop)
    '1snhtMLeb2AZrIEWtTV1gp' // ONE OK ROCK
  ],
  happy: [],
  sad: [],
  angry: [],
  chill: [],
  love: [],
  hype: []
};

const moodDisplayNames = {
  happy: 'Happy',
  sad: 'Sad',
  angry: 'Angry',
  chill: 'Chill',
  love: 'Love',
  hype: 'Hype',
  feelings: 'Feelings',
  hiphop: 'Hip Hop',
  rnb: 'R&B',
  jpop: 'J-Pop'
};

function moodLabel(mood) {
  return moodDisplayNames[mood] || mood.charAt(0).toUpperCase() + mood.slice(1);
}

function initBlockedArtistsField() {
  const ta = document.getElementById('blocked-artists');
  if (ta) ta.value = localStorage.getItem('burnlistBlockedArtistIds') || '';
}

function setupLogin() {
  const form = document.getElementById('burn-form');
  if (!form || form.dataset.bound === '1') return;
  form.dataset.bound = '1';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const mood = document.getElementById('mood').value;
    const songCount = clampSongCount(document.getElementById('song-count').value);
    document.getElementById('song-count').value = String(songCount);
    const blocked = document.getElementById('blocked-artists')?.value?.trim() ?? '';
    localStorage.setItem('selectedMood', mood);
    localStorage.setItem('playlistSongCount', String(songCount));
    localStorage.setItem('burnlistBlockedArtistIds', blocked);
    redirectToSpotifyAuth();
  });
}

function clearOAuthQuery() {
  const path = window.location.pathname;
  window.history.replaceState({}, document.title, path);
}

/** Spotify may omit `is_playable`; treat missing as playable, explicit false as skip. */
function isLikelyPlayableTrack(track) {
  if (!track?.uri || track.type !== 'track') return false;
  if (track.is_playable === false) return false;
  if (track.restrictions?.reason) return false;
  return true;
}

/** Remove tracks Spotify marks unplayable/restricted after the playlist is built (catalog changes, region, etc.). */
async function removeUnplayableTracksFromPlaylist(playlistId, headers) {
  const snapRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=snapshot_id`,
    { headers }
  );
  const snapshotId = snapRes.ok ? (await snapRes.json()).snapshot_id : undefined;

  const seen = new Set();
  const toDelete = [];
  let offset = 0;

  while (true) {
    const res = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=${offset}&market=from_token&fields=items(track(uri,is_playable,restrictions,type))`,
      { headers }
    );
    if (!res.ok) break;
    const data = await res.json();
    if (!data.items?.length) break;

    for (const row of data.items) {
      const t = row.track;
      if (!t?.uri || t.type !== 'track') continue;
      const unplayable = t.is_playable === false || Boolean(t.restrictions?.reason);
      if (!unplayable) continue;
      if (seen.has(t.uri)) continue;
      seen.add(t.uri);
      toDelete.push({ uri: t.uri });
    }

    offset += 100;
    if (!data.next) break;
  }

  if (!toDelete.length) return;

  const delRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      snapshotId ? { tracks: toDelete, snapshot_id: snapshotId } : { tracks: toDelete }
    )
  });
  if (!delRes.ok) {
    console.warn('[Burnlist] Unplayable cleanup failed:', delRes.status, await delRes.text());
  }
}

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
    return false;
  }
  return true;
}

/** Spotify has no “delete playlist” in the Web API; unfollowing removes it from your library (same as deleting for the owner). */
async function unfollowBurnlistPlaylist(playlistId, headers) {
  const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/followers`, {
    method: 'DELETE',
    headers
  });
  if (!res.ok) {
    console.warn('[Burnlist] Unfollow playlist failed:', res.status, await res.text());
  }
  return res.ok;
}

function startBurnMonitor(playlistId, headers, statusElement, openLinkEl, initialTrackCount) {
  const playlistUri = `spotify:playlist:${playlistId}`;
  let lastTrackUri = null;
  let lastProgress = 0;
  const burnedUris = new Set();
  let emptyNotified = false;
  let remaining = Math.max(0, Number(initialTrackCount) || 0);
  let timerId = null;
  /** True while the last poll saw this Burnlist as the playback context (needed for last-track / idle handling). */
  let lastContextWasOurs = false;
  /** Consecutive polls with no active player — avoids removing the last track on a flaky 204. */
  let idlePolls = 0;

  async function finishBurnlistPlaylist() {
    if (emptyNotified) return;
    emptyNotified = true;
    if (timerId != null) {
      clearInterval(timerId);
      timerId = null;
    }
    statusElement.textContent =
      'Burnlist finished — playlist removed from your library. You can make a new Burnlist anytime.';
    openLinkEl.hidden = true;
    await unfollowBurnlistPlaylist(playlistId, headers);
  }

  async function afterSuccessfulTrackRemoval() {
    if (emptyNotified) return;
    if (remaining > 0) remaining -= 1;
    const countRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=total`,
      { headers }
    );
    if (!countRes.ok) {
      if (remaining <= 0) await finishBurnlistPlaylist();
      return;
    }
    const { total } = await countRes.json();
    if (total === 0) {
      remaining = 0;
      await finishBurnlistPlaylist();
    }
  }

  async function maybeUnfollowIfEmptyFallback() {
    if (emptyNotified) return;
    const countRes = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=total`,
      { headers }
    );
    if (!countRes.ok) return;
    const { total } = await countRes.json();
    if (total !== 0) return;
    remaining = 0;
    await finishBurnlistPlaylist();
  }

  const tick = async () => {
    if (emptyNotified) return;
    const res = await fetch('https://api.spotify.com/v1/me/player', { headers });
    if (res.status === 401) {
      statusElement.textContent = 'Session expired — log in again.';
      return;
    }

    if (res.status === 204) {
      idlePolls += 1;
      openLinkEl.hidden = false;
      if (
        idlePolls >= 2 &&
        lastTrackUri &&
        !burnedUris.has(lastTrackUri) &&
        lastContextWasOurs
      ) {
        const ok = await removeTrackFromPlaylist(playlistId, lastTrackUri, headers);
        if (ok) {
          burnedUris.add(lastTrackUri);
          lastTrackUri = null;
          lastContextWasOurs = false;
          idlePolls = 0;
          statusElement.textContent =
            'Playback stopped — last track removed. Deleting playlist if empty…';
          await afterSuccessfulTrackRemoval();
        } else {
          await maybeUnfollowIfEmptyFallback();
        }
      } else {
        statusElement.textContent =
          'Open Spotify, start playing your Burnlist playlist on any device — we will remove each track after 20s or when you skip.';
      }
      return;
    }

    if (!res.ok) {
      openLinkEl.hidden = false;
      statusElement.textContent =
        'Open Spotify, start playing your Burnlist playlist on any device — we will remove each track after 20s or when you skip.';
      return;
    }

    const player = await res.json();
    const ctx = player.context;
    const item = player.item;
    const stillOurPlaylist =
      ctx && ctx.type === 'playlist' && ctx.uri === playlistUri;

    if (
      lastTrackUri &&
      !burnedUris.has(lastTrackUri) &&
      lastContextWasOurs &&
      !stillOurPlaylist
    ) {
      const ok = await removeTrackFromPlaylist(playlistId, lastTrackUri, headers);
      if (ok) {
        burnedUris.add(lastTrackUri);
        lastTrackUri = null;
        idlePolls = 0;
        statusElement.textContent =
          'Playback left Burnlist — last track removed from the playlist.';
        await afterSuccessfulTrackRemoval();
      } else {
        await maybeUnfollowIfEmptyFallback();
      }
      lastContextWasOurs = false;
      openLinkEl.hidden = false;
      return;
    }

    if (!stillOurPlaylist) {
      lastContextWasOurs = false;
      idlePolls = 0;
      openLinkEl.hidden = false;
      statusElement.textContent =
        'Play this playlist in Spotify (any device). Tracks disappear after 20 seconds or when you skip.';
      return;
    }

    lastContextWasOurs = true;

    if (!item) {
      idlePolls += 1;
      openLinkEl.hidden = false;
      if (
        idlePolls >= 2 &&
        lastTrackUri &&
        !burnedUris.has(lastTrackUri) &&
        lastContextWasOurs
      ) {
        const ok = await removeTrackFromPlaylist(playlistId, lastTrackUri, headers);
        if (ok) {
          burnedUris.add(lastTrackUri);
          lastTrackUri = null;
          lastContextWasOurs = false;
          idlePolls = 0;
          statusElement.textContent =
            'Playback stopped — last track removed. Deleting playlist if empty…';
          await afterSuccessfulTrackRemoval();
        } else {
          await maybeUnfollowIfEmptyFallback();
        }
      } else {
        statusElement.textContent =
          'Open Spotify, start playing your Burnlist playlist on any device — we will remove each track after 20s or when you skip.';
      }
      return;
    }

    idlePolls = 0;
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
        const ok = await removeTrackFromPlaylist(playlistId, lastTrackUri, headers);
        if (ok) {
          burnedUris.add(lastTrackUri);
          statusElement.textContent = 'Skipped — track removed from playlist.';
          await afterSuccessfulTrackRemoval();
        }
      }
      lastTrackUri = currentUri;
      lastProgress = progress;
      return;
    }

    if (!burnedUris.has(currentUri) && progress >= BURN_MS) {
      const ok = await removeTrackFromPlaylist(playlistId, currentUri, headers);
      if (ok) {
        burnedUris.add(currentUri);
        statusElement.textContent = '20s played — track removed from playlist.';
        await afterSuccessfulTrackRemoval();
      }
    }

    lastProgress = progress;
  };

  tick();
  timerId = setInterval(tick, POLL_MS);
}

async function runAfterAuth(accessToken) {
  clearOAuthQuery();

  const statusElement = document.getElementById('status');
  const burnPanel = document.getElementById('burn-panel');
  const openLink = document.getElementById('open-playlist-link');

  statusElement.textContent = '🎧 Logged in! Loading your library…';

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
  const pickedUris = new Set();

  try {
    statusElement.textContent = 'Loading liked songs…';
    const likedTracks = await fetchAllSavedTracks(headers);

    statusElement.textContent = 'Loading playlists you own…';
    const ownedPlaylistRecords = await fetchOwnedPlaylistRecords(headers, userId);
    const playlistIds = pickPlaylistIdsForTracks(ownedPlaylistRecords);

    const playlistTracks = [];
    for (let p = 0; p < playlistIds.length; p++) {
      statusElement.textContent = `Loading tracks from your playlists (${p + 1}/${playlistIds.length})…`;
      playlistTracks.push(...(await fetchAllTracksForPlaylist(playlistIds[p], headers)));
    }

    const pool = dedupeTracksByUri([...likedTracks, ...playlistTracks]);
    shuffleInPlace(pool);

    if (!pool.length) {
      statusElement.textContent =
        'No tracks found. Like some songs or add music to playlists you own, then try again.';
      return;
    }

    const blockedArtistIds = getBlockedArtistIdsFromStorage();
    const vibeIds = moodVibeArtists[mood] || [];

    for (let i = 0; i < pool.length && selectedUris.length < targetCount; i += 50) {
      const chunk = pool.slice(i, i + 50);
      const artistIds = chunk.map((t) => t.artists[0]?.id).filter(Boolean);
      const artistMap = await fetchArtistMap(artistIds, headers);

      for (const track of chunk) {
        if (!isLikelyPlayableTrack(track)) continue;
        if (trackTouchesBlockedArtist(track, blockedArtistIds)) continue;
        if (pickedUris.has(track.uri)) continue;

        const vibeMatch =
          vibeIds.length > 0 &&
          (track.artists || []).some((a) => a?.id && vibeIds.includes(a.id));

        let genreMatch = false;
        if (!vibeMatch) {
          const artistId = track.artists[0]?.id;
          if (!artistId) continue;
          const artistData = artistMap.get(artistId);
          if (!artistData) continue;
          const artistGenres = artistData.genres || [];
          genreMatch = artistGenres.some((g) =>
            moodList.some((mg) => g.toLowerCase().includes(mg.toLowerCase()))
          );
        }

        if (vibeMatch || genreMatch) {
          pickedUris.add(track.uri);
          selectedUris.push(track.uri);
          if (selectedUris.length >= targetCount) break;
        }
      }

      statusElement.textContent = `Matching mood… (${selectedUris.length}/${targetCount})`;
    }
  } catch (e) {
    console.error(e);
    statusElement.textContent =
      'Something went wrong talking to Spotify. Wait a minute and try again, or check the browser console.';
    return;
  }

  if (!selectedUris.length) {
    statusElement.textContent =
      'Nothing in your likes or playlists matched this mood. Try another mood or add more variety to your library.';
    return;
  }

  statusElement.textContent = 'Double-checking tracks are playable for your account…';
  const playableUris = await filterUrisToFreshPlayable(selectedUris, headers);
  selectedUris.length = 0;
  selectedUris.push(...playableUris);

  if (!selectedUris.length) {
    statusElement.textContent =
      'No tracks passed playback checks (removed, blocked, or unavailable). Try another mood, remove likes you cannot play, or set burnlistBlockedArtistIds (see README).';
    return;
  }

  const countNote =
    selectedUris.length < targetCount
      ? ` (${selectedUris.length} matched; you asked for ${targetCount})`
      : ` (${selectedUris.length} songs)`;

  shuffleInPlace(selectedUris);

  const playlist = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `Burnlist — ${moodLabel(mood)} 🔥`,
      description: 'Public Burnlist: tracks remove after ~20s or skip; when the last track is gone the playlist is removed from your library.',
      public: true,
      collaborative: false
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

  await removeUnplayableTracksFromPlaylist(playlist.id, headers);

  const totalRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlist.id}/tracks?fields=total`,
    { headers }
  );
  let playlistTrackCount = selectedUris.length;
  if (totalRes.ok) {
    const { total } = await totalRes.json();
    playlistTrackCount = total;
    if (total === 0) {
      statusElement.textContent =
        'No playable tracks ended up in the playlist (blocked, removed, or unavailable in your region). Try another mood or different likes.';
      await unfollowBurnlistPlaylist(playlist.id, headers);
      return;
    }
  }

  await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}`, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      public: true,
      collaborative: false
    })
  }).catch(() => {});

  localStorage.setItem('burnlist_id', playlist.id);
  localStorage.setItem('burnlist_token', accessToken);

  const webUrl = playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;
  openLink.href = webUrl;
  openLink.hidden = false;
  burnPanel.hidden = false;

  statusElement.innerHTML = `Playlist ready${countNote}. <strong>Open Spotify</strong> and play it — each song leaves the list after 20 seconds or when you skip.`;

  startBurnMonitor(playlist.id, headers, statusElement, openLink, playlistTrackCount);
}

window.onload = async () => {
  initBlockedArtistsField();
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
