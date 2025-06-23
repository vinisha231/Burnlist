import { getAccessTokenFromCode } from './auth.js';

window.onload = async () => {
  const accessToken = await getAccessTokenFromCode();
  if (!accessToken) {
    console.log('[DEBUG] No access token retrieved.');
    return;
  }

  const statusElement = document.getElementById('status');
  statusElement.innerText = '🎧 Logged in! Creating your mood-based playlist...';

  console.log('[DEBUG] Access token:', accessToken);

  const headers = { Authorization: 'Bearer ' + accessToken };
  const mood = localStorage.getItem('selectedMood') || 'chill';
  console.log('[DEBUG] Retrieved mood from localStorage:', mood);

  const user = await fetch('https://api.spotify.com/v1/me', { headers }).then(res => res.json());
  console.log('[DEBUG] User info:', user);
  const userId = user.id;

  let allTracks = [];
  let offset = 0;

  while (true) {
    const res = await fetch(`https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`, { headers });
    const data = await res.json();
    console.log(`[DEBUG] Fetched ${data.items.length} tracks at offset ${offset}`);
    if (!data.items.length) break;
    allTracks.push(...data.items.map(item => item.track));
    offset += 50;
  }

  console.log('[DEBUG] Total liked tracks:', allTracks.length);

  const moodGenres = {
    happy: ['pop', 'dance', 'funk', 'party'],
    sad: ['piano', 'acoustic', 'sad'],
    angry: ['metal', 'rock', 'punk','phonk'],
    chill: ['lofi', 'ambient', 'chill'],
    love: ['rnb', 'romantic', 'soul','soft'],
    hype: ['rap', 'hip hop', 'edm']
  };

  const selectedTracks = [];

  for (const track of allTracks) {
    const artistId = track.artists[0]?.id;
    if (!artistId) continue;

    const artistRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers });
    const artistData = await artistRes.json();
    const artistGenres = artistData.genres || [];

    const match = artistGenres.some(g => moodGenres[mood].some(mg => g.includes(mg)));
    if (match) {
      selectedTracks.push(track.uri);
      console.log(`[DEBUG] Track matched for mood (${mood}):`, track.name);
    }

    if (selectedTracks.length >= 30) break;
  }

  console.log('[DEBUG] Total tracks selected for playlist:', selectedTracks.length);

  if (!selectedTracks.length) {
    statusElement.innerText = 'No tracks matched your mood.';
    return;
  }

  const playlist = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `Burnlist - ${mood.toUpperCase()} 🔥`,
      description: `Mood-based playlist that will self-destruct after 1 play.`,
      public: true
    })
  }).then(res => res.json());

  console.log('[DEBUG] Created playlist:', playlist.name);

  await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uris: selectedTracks })
  });

  statusElement.innerText = `Your "${playlist.name}" playlist has been added to your Spotify!`;

  localStorage.setItem('burnlist_id', playlist.id);
  localStorage.setItem('burnlist_token', accessToken);
};
