import { redirectToSpotifyAuth } from './auth.js';

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
  console.log('[DEBUG] Mood selected:', selectedMood);

  redirectToSpotifyAuth(); // Only calling this from auth.js
});
