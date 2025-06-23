import { redirectToSpotifyAuth, getAccessTokenFromCode } from './auth.js';

const SCOPES = 'playlist-modify-public playlist-read-private user-library-read';

const moodGenres = {
  happy: ['pop', 'dance', 'funk', 'party'],
  sad: ['piano', 'acoustic', 'sad'],
  angry: ['metal', 'rock', 'punk', 'phonk'],
  chill: ['lofi', 'ambient', 'chill'],
  love: ['rnb', 'romantic', 'soul', 'soft'],
  hype: ['rap', 'hip hop', 'edm']
};

document.getElementById('login-btn').addEventListener('click', () => {
  const selectedMood = document.getElementById('mood').value;
  localStorage.setItem('selectedMood', selectedMood);
  redirectToSpotifyAuth();
});

window.onload = async () => {
  const accessToken = await getAccessTokenFromCode();
  if (!accessToken) return;

  const status = document.getElementById('status');
  status.innerText = '🎧 Logged in! Creating your mood-based playlist...';

  const headers = { Authorization: 'Bearer ' + accessToken };
  const mood = localStorage.getItem('selectedMood') || 'chill';

  const user = await fetch('https://api.spotify.com/v1/me', { headers }).then(res => res.json());
  const userId = user.id;

  let allTracks = [];
  let offset = 0;
  while (true) {
    const tracksRes = await fetch(`https://api.spotify.com/v1/me/tracks?limit=50&offset=${offset}`, { headers });
    const trackData = await tracksRes.json();
    if (!trackData.items.length) break;
    allTracks.push(...trackData.items.map(item => item.track));
    offset += 50;
  }

  if (!allTracks.length) {
    status.innerText = 'No liked songs found!';
    return;
  }

  const selectedTracks = [];
  for (const track of allTracks) {
    const artistId = track.artists[0]?.id;
    if (!artistId) continue;

    const artistRes = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers });
    const artistData = await artistRes.json();
    const artistGenres = artistData.genres || [];

    if (artistGenres.some(g => moodGenres[mood].some(mg => g.includes(mg)))) {
      selectedTracks.push(track.uri);
    }

    if (selectedTracks.length >= 30) break;
  }

  if (selectedTracks.length === 0) {
    status.innerText = 'No tracks matched your mood.';
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

  await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ uris: selectedTracks })
  });

  status.innerText = `Your "${playlist.name}" playlist has been added to your Spotify!`;

  localStorage.setItem('burnlist_id', playlist.id);
  localStorage.setItem('burnlist_token', accessToken);
};
