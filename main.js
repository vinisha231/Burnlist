import { getAccessTokenFromCode, redirectToSpotifyAuth } from './auth.js';

const moodGenres = {
  happy: ['pop', 'dance', 'funk', 'party'],
  sad: ['piano', 'acoustic', 'sad'],
  angry: ['metal', 'rock', 'punk', 'phonk'],
  chill: ['lofi', 'ambient', 'chill'],
  love: ['rnb', 'romantic', 'soul', 'soft'],
  hype: ['rap', 'hip hop', 'edm']
};

document.getElementById('login-btn').addEventListener('click', () => {
  const mood = document.getElementById('mood').value;
  localStorage.setItem('selectedMood', mood);
  redirectToSpotifyAuth();
});

window.onload = async () => {
  const accessToken = await getAccessTokenFromCode();
  if (!accessToken) return;

  document.getElementById('status').innerText = '🎧 Logged in! Creating your Burnlist...';

  const headers = { Authorization: `Bearer ${accessToken}` };
  const mood = localStorage.getItem('selectedMood') || 'chill';

  const user = await fetch('https://api.spotify.com/v1/me', { headers }).then(res => res.json());
  const userId = user.id;

  let allTracks = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`, { headers });
    const data = await res.json();
    if (!data.items.length) break;
    allTracks.push(...data.items.map(item => item.track));
    offset += 50;
  }

  const selectedTracks = [];

  for (const track of allTracks) {
    const artistId = track.artists[0]?.id;
    if (!artistId) continue;

    const artistRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers });
    const artist = await artistRes.json();

    const genres = artist.genres || [];
    const match = genres.some(g => moodGenres[mood].some(mg => g.includes(mg)));

    if (match) selectedTracks.push(track.uri);
    if (selectedTracks.length >= 30) break;
  }

  if (!selectedTracks.length) {
    document.getElementById('status').innerText = '😬 No songs match your vibe.';
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
      description: 'This playlist will self-destruct after one play.',
      public: true
    })
  }).then(res => res.json());

  await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uris: selectedTracks })
  });

  document.getElementById('status').innerText = `🔥 Your "${playlist.name}" is ready! Go burn it.`;
};
