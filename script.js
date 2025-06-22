window.addEventListener('DOMContentLoaded', () => {
  const CLIENT_ID = '1b922a6cb85549db80f560b7254c1116';
  const REDIRECT_URI = 'https://vinisha231.github.io/Burnlist/';
  const SCOPES = 'playlist-modify-public playlist-read-private user-library-read';

  const loginBtn = document.getElementById('login-btn');
  const status = document.getElementById('status');

  loginBtn.addEventListener('click', () => {
    const selectedMood = document.getElementById('mood').value;
    localStorage.setItem('selectedMood', selectedMood);

    const authUrl = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=token&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&show_dialog=true`;
    window.location.href = authUrl;
  });

  async function generatePlaylist(accessToken) {
    const mood = localStorage.getItem('selectedMood') || 'chill';
    const headers = { Authorization: 'Bearer ' + accessToken };

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

    if (!allTracks.length) {
      status.innerText = 'No liked songs found!';
      return;
    }

    const moodGenres = {
      happy: ['pop', 'dance', 'funk', 'party'],
      sad: ['piano', 'acoustic', 'sad'],
      angry: ['metal', 'rock', 'punk', 'phonk'],
      chill: ['lofi', 'ambient', 'chill'],
      love: ['rnb', 'romantic', 'soul', 'soft'],
      hype: ['rap', 'hip hop', 'edm']
    };

    const selectedTracks = [];

    for (const track of allTracks) {
      const artistId = track.artists[0]?.id;
      if (!artistId) continue;

      const artist = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers }).then(res => res.json());
      const genres = artist.genres || [];

      if (genres.some(g => moodGenres[mood].some(mg => g.includes(mg)))) {
        selectedTracks.push(track.uri);
      }

      if (selectedTracks.length >= 30) break;
    }

    if (!selectedTracks.length) {
      status.innerText = '😬 No tracks matched your mood.';
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
        description: `Mood-based playlist that will self-destruct after one play.`,
        public: true
      })
    }).then(res => res.json());

    await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ uris: selectedTracks })
    });

    status.innerText = `Your "${playlist.name}" is ready! Go burn it 🔥`;

    localStorage.setItem('burnlist_id', playlist.id);
    localStorage.setItem('burnlist_token', accessToken);
  }

  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');

  if (accessToken) {
    status.innerText = '🎧 Logged in! Generating your playlist...';
    generatePlaylist(accessToken);
  }
});
