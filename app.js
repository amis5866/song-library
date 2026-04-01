// ═══════════════════════════════════════════════════════════════════════════
// SPOTIFY AUTH  (PKCE, no backend)
// ═══════════════════════════════════════════════════════════════════════════

const spotifyAuth = (() => {
  const SCOPES = 'playlist-read-private playlist-read-collaborative';

  function base64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function generateCodeVerifier() {
    const arr = new Uint8Array(72);
    crypto.getRandomValues(arr);
    return base64url(arr);
  }

  async function generateCodeChallenge(verifier) {
    const enc  = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return base64url(hash);
  }

  async function initiateLogin(clientId, redirectUri) {
    const verifier   = generateCodeVerifier();
    const challenge  = await generateCodeChallenge(verifier);
    const state      = generateCodeVerifier().slice(0, 16);

    sessionStorage.setItem('sp_verifier', verifier);
    sessionStorage.setItem('sp_state',    state);
    localStorage.setItem('sp_client_id',    clientId);
    localStorage.setItem('sp_redirect_uri', redirectUri);

    const params = new URLSearchParams({
      response_type:         'code',
      client_id:             clientId,
      scope:                 SCOPES,
      redirect_uri:          redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge:        challenge,
    });

    window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
  }

  async function exchangeCodeForToken(code, clientId, redirectUri) {
    const verifier = sessionStorage.getItem('sp_verifier');
    sessionStorage.removeItem('sp_verifier');
    sessionStorage.removeItem('sp_state');

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new Error('Token exchange failed');
    return res.json();
  }

  async function refreshAccessToken(clientId, refreshToken) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
      }),
    });
    if (!res.ok) throw new Error('Refresh failed');
    return res.json();
  }

  function saveTokens(obj) {
    localStorage.setItem('sp_access_token',  obj.access_token);
    localStorage.setItem('sp_token_expiry',  Date.now() + obj.expires_in * 1000);
    if (obj.refresh_token) {
      localStorage.setItem('sp_refresh_token', obj.refresh_token);
    }
  }

  function loadTokens() {
    const token = localStorage.getItem('sp_access_token');
    if (!token) return null;
    return {
      accessToken:  token,
      refreshToken: localStorage.getItem('sp_refresh_token'),
      expiry:       Number(localStorage.getItem('sp_token_expiry')),
      clientId:     localStorage.getItem('sp_client_id'),
      redirectUri:  localStorage.getItem('sp_redirect_uri'),
    };
  }

  function clearTokens() {
    ['sp_access_token','sp_refresh_token','sp_token_expiry'].forEach(k => localStorage.removeItem(k));
  }

  async function getValidToken() {
    const t = loadTokens();
    if (!t) return null;

    // Refresh if expiring within 60 s
    if (Date.now() > t.expiry - 60_000) {
      try {
        const fresh = await refreshAccessToken(t.clientId, t.refreshToken);
        saveTokens(fresh);
        return fresh.access_token;
      } catch {
        clearTokens();
        updateHeaderButtons();
        settingsModal.updateStatus();
        showToast('Spotify session expired — reconnect in Settings');
        return null;
      }
    }
    return t.accessToken;
  }

  async function handleOAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    if (!code) return false;

    const savedState = sessionStorage.getItem('sp_state');
    history.replaceState({}, '', window.location.pathname);

    if (state !== savedState) {
      showToast('Spotify auth error — state mismatch. Try again.');
      return false;
    }

    try {
      const clientId    = localStorage.getItem('sp_client_id');
      const redirectUri = localStorage.getItem('sp_redirect_uri');
      const tokens      = await exchangeCodeForToken(code, clientId, redirectUri);
      saveTokens(tokens);
      showToast('Spotify connected!');
      return true;
    } catch (e) {
      showToast('Spotify token exchange failed. Try reconnecting.');
      return false;
    }
  }

  return {
    initiateLogin, handleOAuthCallback,
    loadTokens, saveTokens, clearTokens, getValidToken,
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
// SPOTIFY API
// ═══════════════════════════════════════════════════════════════════════════

const spotifyApi = (() => {
  async function apiFetch(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return null; // caller handles token refresh
    if (!res.ok) throw new Error(`Spotify API ${res.status}`);
    return res.json();
  }

  async function searchTrack(query, token) {
    const url  = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`;
    const data = await apiFetch(url, token);
    if (!data) return [];
    return (data.tracks?.items || []).map(t => ({
      id:         t.id,
      name:       t.name,
      artist:     t.artists[0]?.name || '',
      artworkUrl: t.album.images[1]?.url || t.album.images[0]?.url || '',
    }));
  }

  function extractPlaylistId(input) {
    if (!input) return null;
    const match = input.match(/playlist\/([A-Za-z0-9]+)/);
    if (match) return match[1];
    if (/^[A-Za-z0-9]+$/.test(input.trim())) return input.trim();
    return null;
  }

  async function getPlaylistTracks(playlistId, token) {
    const fields = 'next,items(track(id,name,artists,album(name,images)))';
    let   url    = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=${encodeURIComponent(fields)}`;
    const tracks = [];

    while (url) {
      const data = await apiFetch(url, token);
      if (!data) throw new Error('Unauthorized — reconnect Spotify');
      for (const item of (data.items || [])) {
        if (!item.track || !item.track.id) continue; // skip podcasts / nulls
        const t = item.track;
        tracks.push({
          id:         t.id,
          name:       t.name,
          artist:     t.artists[0]?.name || '',
          artworkUrl: t.album.images[1]?.url || t.album.images[0]?.url || '',
        });
      }
      url = data.next || null;
    }
    return tracks;
  }

  return { searchTrack, extractPlaylistId, getPlaylistTracks };
})();

// ═══════════════════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════════════════

let library      = [];
let activeTag    = null;
let filterQuery  = '';
let searchTimer  = null;
let pendingResult = null;
let editingSongId = null;
let viewingSongId = null;

const STORAGE_KEY = 'songLibrary';

// Player state
const audio       = new Audio();
let currentSongId = null;
let playerMode    = 'itunes'; // 'itunes' | 'spotify' | 'none'

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════════════════════════════════════

function loadLibrary() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { localStorage.removeItem(STORAGE_KEY); return []; }
}

function saveLibrary(songs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(songs));
}

// ═══════════════════════════════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════════════════════════════

function getAllTags(songs) {
  const counts = {};
  for (const s of songs) for (const t of (s.tags || [])) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort(([a],[b]) => a.localeCompare(b)).map(([tag,count]) => ({tag,count}));
}

// ═══════════════════════════════════════════════════════════════════════════
// URL BUILDER
// ═══════════════════════════════════════════════════════════════════════════

function buildServiceLinks(artist, title) {
  const q  = encodeURIComponent(`${artist} ${title}`).replace(/%20/g, '+');
  const qs = encodeURIComponent(`${artist} ${title}`);
  return [
    { name: 'YouTube',       url: `https://www.youtube.com/results?search_query=${q}`,                                          favicon: 'https://www.youtube.com/favicon.ico' },
    { name: 'Spotify',       url: `https://open.spotify.com/search/${qs}`,                                                      favicon: 'https://open.spotify.com/favicon.ico' },
    { name: 'Ultimate Guitar',url: `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`,                   favicon: 'https://www.ultimate-guitar.com/favicon.ico' },
    { name: 'Songsterr',     url: `https://www.songsterr.com/?pattern=${q}`,                                                    favicon: 'https://www.songsterr.com/favicon.ico' },
    { name: 'tab4u',         url: `https://en.tab4u.com/resultsSimple?tab=songs&q=${q}`,                                        favicon: 'https://en.tab4u.com/favicon.ico' },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTER & SORT
// ═══════════════════════════════════════════════════════════════════════════

function getSortedAndFiltered(songs, tag, query) {
  let result = songs;
  if (tag) result = result.filter(s => (s.tags || []).includes(tag));
  if (query) {
    const q = query.toLowerCase();
    result = result.filter(s =>
      s.artist.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q)  ||
      (s.tags || []).some(t => t.includes(q))
    );
  }
  return result.slice().sort((a,b) => {
    const c = a.artist.localeCompare(b.artist);
    return c !== 0 ? c : a.title.localeCompare(b.title);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ROW ELEMENT
// ═══════════════════════════════════════════════════════════════════════════

function createRowElement(song) {
  const links  = buildServiceLinks(song.artist, song.title);
  const row    = document.createElement('div');
  row.className  = 'song-row';
  row.dataset.id = song.id;
  if (song.id === currentSongId) row.classList.add('is-playing');

  const artwork = document.createElement('img');
  artwork.className = 'row-artwork';
  artwork.src     = song.artwork || '';
  artwork.alt     = '';
  artwork.onerror = () => { artwork.style.display = 'none'; };

  const titleEl = document.createElement('span');
  titleEl.className   = 'row-title';
  titleEl.textContent = song.title;
  titleEl.title       = song.title;

  const sep = document.createElement('span');
  sep.className = 'row-sep';
  sep.textContent = '·';

  const artistEl = document.createElement('span');
  artistEl.className   = 'row-artist';
  artistEl.textContent = song.artist;
  artistEl.title       = song.artist;

  const tagsDiv = document.createElement('div');
  tagsDiv.className = 'row-tags';
  for (const tag of (song.tags || [])) {
    const chip = document.createElement('span');
    chip.className      = 'tag-chip';
    chip.textContent    = tag;
    chip.dataset.action = 'filter-tag';
    chip.dataset.tag    = tag;
    tagsDiv.appendChild(chip);
  }

  const spacer = document.createElement('div');
  spacer.className = 'row-spacer';

  const linksDiv = document.createElement('div');
  linksDiv.className = 'row-links';
  for (const { name, url, favicon } of links) {
    const a   = document.createElement('a');
    a.className = 'svc-icon';
    a.href      = url;
    a.target    = '_blank';
    a.rel       = 'noopener noreferrer';
    a.title     = name;
    const icon  = document.createElement('img');
    icon.src    = favicon;
    icon.alt    = name;
    icon.onerror = () => {
      icon.style.display = 'none';
      a.textContent      = name.slice(0, 2);
      a.style.fontSize   = '0.6rem';
      a.style.color      = 'var(--text-secondary)';
    };
    a.appendChild(icon);
    linksDiv.appendChild(a);
  }

  const hasSpotify  = !!song.spotifyTrackId;
  const hasPreview  = !!song.previewUrl;
  const playBtn     = document.createElement('button');
  playBtn.className    = 'row-play-btn';
  playBtn.dataset.action = 'play';

  if (!hasSpotify && !hasPreview) {
    playBtn.classList.add('no-preview');
    playBtn.title     = 'No preview available';
    playBtn.innerHTML = '&#9654;';
  } else {
    if (hasSpotify) playBtn.classList.add('spotify');
    if (song.id === currentSongId) {
      playBtn.classList.add('is-playing');
      playBtn.innerHTML = '&#9646;&#9646;';
      playBtn.title     = 'Now playing';
    } else {
      playBtn.innerHTML = '&#9654;';
      playBtn.title     = hasSpotify ? 'Play on Spotify embed' : 'Play 30s preview';
    }
  }

  const editBtn = document.createElement('button');
  editBtn.className      = 'row-edit-btn';
  editBtn.dataset.action = 'edit';
  editBtn.title          = 'Edit song';
  editBtn.innerHTML      = '&#9998;';

  const deleteBtn = document.createElement('button');
  deleteBtn.className      = 'row-delete-btn';
  deleteBtn.dataset.action = 'delete';
  deleteBtn.title          = 'Remove from library';
  deleteBtn.innerHTML      = '&times;';

  row.append(artwork, titleEl, sep, artistEl, tagsDiv, spacer, linksDiv, playBtn, editBtn, deleteBtn);
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════════

function renderGrid() {
  const grid       = document.getElementById('song-grid');
  const emptyState = document.getElementById('empty-state');
  const filtered   = getSortedAndFiltered(library, activeTag, filterQuery);
  grid.innerHTML   = '';
  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    emptyState.textContent = library.length === 0
      ? 'No songs yet. Search for a song above to add it to your library.'
      : 'No songs match your current filter.';
  } else {
    emptyState.classList.add('hidden');
    for (const song of filtered) grid.appendChild(createRowElement(song));
  }
}

function renderSidebar() {
  const tagList = document.getElementById('tag-list');
  tagList.innerHTML = '';
  const all = document.createElement('li');
  all.dataset.tag = '';
  all.className   = activeTag === null ? 'active' : '';
  all.innerHTML   = `<span>All</span><span class="tag-count">${library.length}</span>`;
  tagList.appendChild(all);
  for (const { tag, count } of getAllTags(library)) {
    const li = document.createElement('li');
    li.dataset.tag = tag;
    li.className   = activeTag === tag ? 'active' : '';
    li.innerHTML   = `<span>${tag}</span><span class="tag-count">${count}</span>`;
    tagList.appendChild(li);
  }
}

function render() { renderSidebar(); renderGrid(); }

// ═══════════════════════════════════════════════════════════════════════════
// LIBRARY OPS
// ═══════════════════════════════════════════════════════════════════════════

function addSong(itunesResult, tags, spotifyTrackId) {
  const isDuplicate = library.some(
    s => s.title === itunesResult.trackName && s.artist === itunesResult.artistName
  );
  if (isDuplicate) return false;

  const artwork = (itunesResult.artworkUrl100 || '').replace('100x100bb', '300x300bb');
  library.push({
    id:             crypto.randomUUID(),
    artist:         itunesResult.artistName      || '',
    title:          itunesResult.trackName       || '',
    album:          itunesResult.collectionName  || '',
    artwork,
    genre:          itunesResult.primaryGenreName || '',
    previewUrl:     itunesResult.previewUrl      || '',
    spotifyTrackId: spotifyTrackId               || null,
    tabUrls: {},
    tags,
    addedAt: Date.now(),
  });
  saveLibrary(library);
  render();
  return true;
}

function addSongFromSpotify(track, tags) {
  // Used by playlist import — no iTunes data available
  const norm = s => s.toLowerCase().replace(/\s+/g,' ').trim();
  const isDup = library.some(s =>
    (s.spotifyTrackId && s.spotifyTrackId === track.id) ||
    (norm(s.title) === norm(track.name) && norm(s.artist) === norm(track.artist))
  );
  if (isDup) return false;

  library.push({
    id:             crypto.randomUUID(),
    artist:         track.artist,
    title:          track.name,
    album:          '',
    artwork:        track.artworkUrl || '',
    genre:          '',
    previewUrl:     '',
    spotifyTrackId: track.id,
    tabUrls: {},
    tags,
    addedAt: Date.now(),
  });
  return true;
}

function deleteSong(id) {
  if (currentSongId === id) stopPlayer();
  library = library.filter(s => s.id !== id);
  saveLibrary(library);
  render();
}

// ═══════════════════════════════════════════════════════════════════════════
// ITUNES SEARCH
// ═══════════════════════════════════════════════════════════════════════════

async function searchItunes(query) {
  const panel = document.getElementById('search-results');
  if (!query || query.trim().length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="search-status">Searching...</div>';
  try {
    const res  = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query.trim())}&entity=song&limit=8&country=US`);
    const data = await res.json();
    panel.innerHTML = '';
    if (!data.results?.length) { panel.innerHTML = '<div class="search-status">No results found.</div>'; return; }
    for (const item of data.results) {
      const div = document.createElement('div');
      div.className = 'search-result-item';
      const img = document.createElement('img');
      img.className = 'result-artwork';
      img.src = item.artworkUrl100 || '';
      img.onerror = () => { img.style.display = 'none'; };
      const info = document.createElement('div');
      info.className = 'result-info';
      const t = document.createElement('div');
      t.className   = 'result-title';
      t.textContent = item.trackName || 'Unknown';
      const s = document.createElement('div');
      s.className   = 'result-sub';
      s.textContent = [item.artistName, item.collectionName].filter(Boolean).join('  ·  ');
      info.append(t, s);
      const btn = document.createElement('button');
      btn.className   = 'btn-add-result';
      btn.textContent = 'Add +';
      btn.addEventListener('click', () => openAddModal(item));
      div.append(img, info, btn);
      panel.appendChild(div);
    }
  } catch {
    panel.innerHTML = '<div class="search-status">Search failed. Check your connection.</div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SPOTIFY TRACK URL PARSER  (no auth needed)
// ═══════════════════════════════════════════════════════════════════════════

const spotifyLinkSection = (() => {
  let _autoSelectedId = null;

  function parseTrackId(input) {
    if (!input) return null;
    const urlMatch = input.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
    if (urlMatch) return urlMatch[1];
    const uriMatch = input.match(/spotify:track:([A-Za-z0-9]+)/);
    if (uriMatch) return uriMatch[1];
    return null;
  }

  function getSelectedId() {
    if (_autoSelectedId) return _autoSelectedId;
    const val = document.getElementById('spotify-url-input')?.value?.trim() || '';
    return parseTrackId(val);
  }

  function _getOrCreateResultsPanel() {
    let panel = document.getElementById('spotify-auto-results');
    if (!panel) {
      panel = document.createElement('div');
      panel.id        = 'spotify-auto-results';
      panel.className = 'spotify-auto-results';
      const urlRow = document.querySelector('#modal-overlay .spotify-url-row');
      if (urlRow) urlRow.parentElement.insertBefore(panel, urlRow);
    }
    return panel;
  }

  function _clearResultsPanel() {
    const panel = document.getElementById('spotify-auto-results');
    if (panel) panel.remove();
    _autoSelectedId = null;
  }

  async function autoSearch(artist, title) {
    _clearResultsPanel();
    const token = await spotifyAuth.getValidToken();
    if (!token) return;

    const panel = _getOrCreateResultsPanel();
    panel.innerHTML = '<p class="spotify-auto-empty">Searching Spotify…</p>';

    try {
      const results = await spotifyApi.searchTrack(`${artist} ${title}`, token);
      panel.innerHTML = '';

      if (!results.length) {
        panel.innerHTML = '<p class="spotify-auto-empty">No Spotify matches — paste URL manually below.</p>';
        return;
      }

      results.forEach((track, i) => {
        const item = document.createElement('div');
        item.className      = 'spotify-auto-item';
        item.dataset.trackId = track.id;
        if (i === 0) { item.classList.add('selected'); _autoSelectedId = track.id; }

        const img = document.createElement('img');
        img.className = 'spotify-auto-art';
        img.src = track.artworkUrl || '';
        img.alt = '';
        img.onerror = () => { img.style.display = 'none'; };

        const info = document.createElement('div');
        info.className = 'spotify-auto-info';
        const nm = document.createElement('span'); nm.className = 'spotify-auto-name';   nm.textContent = track.name;
        const ar = document.createElement('span'); ar.className = 'spotify-auto-artist'; ar.textContent = track.artist;
        info.append(nm, ar);

        const ck = document.createElement('span');
        ck.className   = 'spotify-auto-check';
        ck.textContent = '✓';

        item.append(img, info, ck);
        item.addEventListener('click', () => {
          panel.querySelectorAll('.spotify-auto-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          _autoSelectedId = track.id;
        });
        panel.appendChild(item);
      });
    } catch {
      _clearResultsPanel();
    }
  }

  function reset() {
    _clearResultsPanel();
    const input  = document.getElementById('spotify-url-input');
    const status = document.getElementById('spotify-url-status');
    if (input)  { input.value = ''; input.className = ''; }
    if (status) status.textContent = '';
  }

  function attachInputListener() {
    const input  = document.getElementById('spotify-url-input');
    const status = document.getElementById('spotify-url-status');
    if (!input) return;
    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (!val) {
        input.className = ''; status.textContent = '';
        // Re-activate auto-selected item if present
        const sel = document.querySelector('#spotify-auto-results .spotify-auto-item.selected');
        _autoSelectedId = sel?.dataset.trackId || null;
        return;
      }
      // Manual paste overrides auto-selection
      _autoSelectedId = null;
      if (parseTrackId(val)) {
        input.className    = 'valid';
        status.textContent = '✓';
        status.style.color = 'var(--spotify)';
      } else {
        input.className    = 'invalid';
        status.textContent = '✗';
        status.style.color = 'var(--danger)';
      }
    });
  }

  return { getSelectedId, reset, attachInputListener, autoSearch };
})();

// ═══════════════════════════════════════════════════════════════════════════
// ADD-SONG MODAL
// ═══════════════════════════════════════════════════════════════════════════

function openAddModal(itunesResult) {
  pendingResult = itunesResult;
  document.getElementById('modal-artwork').src              = (itunesResult.artworkUrl100 || '').replace('100x100bb','300x300bb');
  document.getElementById('modal-song-title').textContent   = itunesResult.trackName      || '';
  document.getElementById('modal-song-artist').textContent  = itunesResult.artistName     || '';
  document.getElementById('modal-song-album').textContent   = itunesResult.collectionName || '';
  document.getElementById('tags-input').value = '';
  spotifyLinkSection.reset();
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('tags-input').focus();
  renderTagPicker('tag-picker', 'tags-input');
  spotifyLinkSection.autoSearch(itunesResult.artistName || '', itunesResult.trackName || '');
}

function closeAddModal() {
  pendingResult = null;
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('tags-input').value = '';
  spotifyLinkSection.reset();
}

function parseTags(raw) {
  return [...new Set(raw.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0))];
}

function renderTagPicker(pickerId, inputId) {
  const picker  = document.getElementById(pickerId);
  const input   = document.getElementById(inputId);
  if (!picker || !input) return;
  const allTags    = getAllTags(library).map(t => t.tag);
  const activeTags = parseTags(input.value);
  picker.innerHTML = '';
  for (const tag of allTags) {
    const chip = document.createElement('span');
    chip.className   = 'tag-picker-chip' + (activeTags.includes(tag) ? ' used' : '');
    chip.textContent = tag;
    chip.addEventListener('click', () => {
      const current = parseTags(input.value);
      input.value = current.includes(tag)
        ? current.filter(t => t !== tag).join(', ')
        : [...current, tag].join(', ');
      renderTagPicker(pickerId, inputId);
    });
    picker.appendChild(chip);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EDIT SONG MODAL
// ═══════════════════════════════════════════════════════════════════════════

function parseSpotifyTrackId(input) {
  if (!input) return null;
  const urlMatch = input.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  const uriMatch = input.match(/spotify:track:([A-Za-z0-9]+)/);
  if (uriMatch) return uriMatch[1];
  return null;
}

function openEditModal(songId) {
  const song = library.find(s => s.id === songId);
  if (!song) return;
  editingSongId = songId;

  document.getElementById('edit-title-input').value  = song.title  || '';
  document.getElementById('edit-artist-input').value = song.artist || '';
  document.getElementById('edit-tags-input').value   = (song.tags || []).join(', ');

  const spInput  = document.getElementById('edit-spotify-url-input');
  const spStatus = document.getElementById('edit-spotify-url-status');
  if (song.spotifyTrackId) {
    spInput.value     = `https://open.spotify.com/track/${song.spotifyTrackId}`;
    spInput.className = 'valid';
    spStatus.textContent = '✓';
    spStatus.style.color = 'var(--spotify)';
  } else {
    spInput.value     = '';
    spInput.className = '';
    spStatus.textContent = '';
  }

  document.getElementById('modal-edit').classList.remove('hidden');
  document.getElementById('edit-title-input').focus();
  renderTagPicker('edit-tag-picker', 'edit-tags-input');
}

function closeEditModal() {
  editingSongId = null;
  document.getElementById('modal-edit').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS MODAL
// ═══════════════════════════════════════════════════════════════════════════

const settingsModal = (() => {
  function open() {
    const t = spotifyAuth.loadTokens();
    if (t) {
      document.getElementById('input-spotify-client-id').value    = t.clientId    || '';
      document.getElementById('input-spotify-redirect-uri').value = t.redirectUri || '';
    } else {
      // Leave redirect URI blank so user is prompted to enter their HTTPS URL
      document.getElementById('input-spotify-client-id').value    = '';
      document.getElementById('input-spotify-redirect-uri').value = '';
    }
    updateStatus();
    document.getElementById('modal-settings').classList.remove('hidden');
  }

  function close() {
    document.getElementById('modal-settings').classList.add('hidden');
  }

  function updateStatus() {
    const t      = spotifyAuth.loadTokens();
    const badge  = document.getElementById('spotify-status-badge');
    const form   = document.getElementById('settings-spotify-form');
    const btnCon = document.getElementById('btn-connect-spotify');
    const btnDis = document.getElementById('btn-disconnect-spotify');

    if (t?.accessToken) {
      badge.textContent = 'Connected';
      badge.className   = 'status-badge status-badge--connected';
      form.classList.add('hidden');
      btnCon.classList.add('hidden');
      btnDis.classList.remove('hidden');
    } else {
      badge.textContent = 'Not connected';
      badge.className   = 'status-badge status-badge--disconnected';
      form.classList.remove('hidden');
      btnCon.classList.remove('hidden');
      btnDis.classList.add('hidden');
    }

    updateHeaderButtons();
  }

  async function handleConnect() {
    const clientId    = document.getElementById('input-spotify-client-id').value.trim();
    let   redirectUri = document.getElementById('input-spotify-redirect-uri').value.trim();

    if (!clientId)    { showToast('Enter your Spotify Client ID first.'); return; }
    if (!redirectUri) { showToast('Enter the Redirect URI.'); return; }

    // Spotify now requires HTTPS for all redirect URIs
    if (!redirectUri.startsWith('https://')) {
      showToast('Spotify requires an https:// redirect URI. Use ngrok or GitHub Pages (see instructions above).', 5000);
      return;
    }

    await spotifyAuth.initiateLogin(clientId, redirectUri);
  }

  function handleDisconnect() {
    spotifyAuth.clearTokens();
    updateStatus();
    showToast('Spotify disconnected.');
  }

  return { open, close, updateStatus, handleConnect, handleDisconnect };
})();

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT PLAYLIST MODAL
// ═══════════════════════════════════════════════════════════════════════════

const importModal = (() => {
  let fetchedTracks = [];

  function open() {
    fetchedTracks = [];
    document.getElementById('input-playlist-url').value = '';
    document.getElementById('import-status').textContent = '';
    document.getElementById('import-status').className = 'import-status';
    document.getElementById('import-controls').classList.add('hidden');
    document.getElementById('import-track-list').classList.add('hidden');
    document.getElementById('import-track-list').innerHTML = '';
    document.getElementById('btn-import-confirm').disabled = true;
    document.getElementById('btn-import-confirm').textContent = 'Add Songs';
    document.getElementById('modal-import').classList.remove('hidden');
    document.getElementById('input-playlist-url').focus();
  }

  function close() {
    document.getElementById('modal-import').classList.add('hidden');
  }

  async function handleFetch() {
    const url        = document.getElementById('input-playlist-url').value.trim();
    const statusEl   = document.getElementById('import-status');
    const playlistId = spotifyApi.extractPlaylistId(url);

    if (!playlistId) {
      statusEl.className   = 'import-status error';
      statusEl.textContent = 'Invalid playlist URL. Paste the full Spotify playlist link.';
      return;
    }

    statusEl.className   = 'import-status';
    statusEl.textContent = 'Fetching playlist…';
    document.getElementById('import-controls').classList.add('hidden');
    document.getElementById('import-track-list').classList.add('hidden');
    document.getElementById('btn-import-confirm').disabled = true;

    const token = await spotifyAuth.getValidToken();
    if (!token) {
      statusEl.className   = 'import-status error';
      statusEl.textContent = 'Not connected to Spotify. Connect in Settings.';
      return;
    }

    try {
      fetchedTracks = await spotifyApi.getPlaylistTracks(playlistId, token);
      if (!fetchedTracks.length) {
        statusEl.textContent = 'This playlist has no tracks.';
        return;
      }
      statusEl.textContent = `Found ${fetchedTracks.length} track${fetchedTracks.length !== 1 ? 's' : ''}.`;
      renderTracks(fetchedTracks);
    } catch (e) {
      statusEl.className   = 'import-status error';
      statusEl.textContent = e.message || 'Failed to fetch playlist.';
    }
  }

  function normStr(s) { return s.toLowerCase().replace(/\s+/g,' ').trim(); }

  function isDuplicate(track) {
    return library.some(s =>
      (s.spotifyTrackId && s.spotifyTrackId === track.id) ||
      (normStr(s.title) === normStr(track.name) && normStr(s.artist) === normStr(track.artist))
    );
  }

  function renderTracks(tracks) {
    const list = document.getElementById('import-track-list');
    list.innerHTML = '';

    tracks.forEach(track => {
      const isDup = isDuplicate(track);
      const li    = document.createElement('li');
      li.className = 'import-track-item';
      li.dataset.trackId    = track.id;
      li.dataset.trackName  = track.name;
      li.dataset.trackArtist = track.artist;
      li.dataset.trackArt   = track.artworkUrl || '';

      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', updateConfirmButton);

      const img = document.createElement('img');
      img.className = 'import-track-art';
      img.src       = track.artworkUrl || '';
      img.onerror   = () => { img.style.display = 'none'; };

      const info = document.createElement('div');
      info.className = 'import-track-info';

      const tn = document.createElement('div');
      tn.className   = 'import-track-title';
      tn.textContent = track.name;

      const ta = document.createElement('div');
      ta.className   = 'import-track-artist';
      ta.textContent = track.artist;

      info.append(tn, ta);
      li.append(cb, img, info);

      if (isDup) {
        const badge = document.createElement('span');
        badge.className   = 'import-track-duplicate';
        badge.textContent = 'In library';
        li.appendChild(badge);
      }

      list.appendChild(li);
    });

    list.classList.remove('hidden');
    document.getElementById('import-controls').classList.remove('hidden');
    updateConfirmButton();
  }

  function updateConfirmButton() {
    const checked = document.querySelectorAll('#import-track-list input[type="checkbox"]:checked').length;
    const btn     = document.getElementById('btn-import-confirm');
    btn.disabled      = checked === 0;
    btn.textContent   = checked > 0 ? `Add ${checked} Song${checked !== 1 ? 's' : ''}` : 'Add Songs';
  }

  function handleSelectAll() {
    document.querySelectorAll('#import-track-list input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    updateConfirmButton();
  }

  function handleDeselectAll() {
    document.querySelectorAll('#import-track-list input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateConfirmButton();
  }

  function handleConfirm() {
    const items   = document.querySelectorAll('#import-track-list .import-track-item');
    let   added   = 0;
    let   skipped = 0;

    items.forEach(li => {
      const cb = li.querySelector('input[type="checkbox"]');
      if (!cb.checked) return;
      const track = {
        id:         li.dataset.trackId,
        name:       li.dataset.trackName,
        artist:     li.dataset.trackArtist,
        artworkUrl: li.dataset.trackArt,
      };
      if (addSongFromSpotify(track, [])) added++;
      else skipped++;
    });

    saveLibrary(library);
    render();
    close();
    showToast(`Added ${added} song${added !== 1 ? 's' : ''}${skipped > 0 ? `, ${skipped} skipped (already in library)` : ''}.`);
  }

  return { open, close, handleFetch, handleSelectAll, handleDeselectAll, handleConfirm };
})();

// ═══════════════════════════════════════════════════════════════════════════
// PLAYER
// ═══════════════════════════════════════════════════════════════════════════

function formatTime(s) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`;
}

function playSong(song) {
  currentSongId = song.id;

  const bar      = document.getElementById('player-bar');
  const badgeEl  = document.getElementById('player-mode-badge');

  document.getElementById('player-artwork').src          = song.artwork || '';
  document.getElementById('player-title').textContent    = song.title;
  document.getElementById('player-artist').textContent   = song.artist;
  bar.classList.remove('hidden');

  if (song.spotifyTrackId) {
    // — Spotify embed mode —
    audio.pause();
    audio.src = '';
    playerMode = 'spotify';

    bar.classList.add('player-bar--spotify');
    document.getElementById('player-custom').style.display  = 'none';
    document.getElementById('player-spotify').classList.remove('hidden');

    document.getElementById('spotify-embed-iframe').src =
      `https://open.spotify.com/embed/track/${song.spotifyTrackId}?utm_source=generator&theme=0`;

    badgeEl.textContent = 'Spotify';
    badgeEl.className   = 'player-preview-badge spotify';

  } else if (song.previewUrl) {
    // — iTunes preview mode —
    playerMode = 'itunes';

    bar.classList.remove('player-bar--spotify');
    document.getElementById('player-custom').style.display  = '';
    document.getElementById('player-spotify').classList.add('hidden');
    document.getElementById('spotify-embed-iframe').src     = '';

    audio.src = song.previewUrl;
    audio.currentTime = 0;
    audio.play();

    document.getElementById('player-time-current').textContent = '0:00';
    document.getElementById('player-time-total').textContent   = '0:30';
    document.getElementById('player-seek').value = 0;

    badgeEl.textContent = 'preview';
    badgeEl.className   = 'player-preview-badge';

  } else {
    // — No audio available —
    playerMode = 'none';
    bar.classList.remove('player-bar--spotify');
    document.getElementById('player-custom').style.display  = 'none';
    document.getElementById('player-spotify').classList.add('hidden');
    document.getElementById('spotify-embed-iframe').src     = '';
    badgeEl.textContent = 'no preview';
    badgeEl.className   = 'player-preview-badge';
  }

  renderGrid();
}

function stopPlayer() {
  audio.pause();
  audio.src = '';
  document.getElementById('spotify-embed-iframe').src = '';
  document.getElementById('player-bar').classList.add('hidden');
  document.getElementById('player-bar').classList.remove('player-bar--spotify');
  currentSongId = null;
  playerMode    = 'itunes';
  renderGrid();
}

function togglePlay() {
  if (playerMode === 'itunes') {
    if (audio.paused) audio.play(); else audio.pause();
  } else if (playerMode === 'spotify') {
    const iframe = document.getElementById('spotify-embed-iframe');
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ command: 'toggle' }, 'https://open.spotify.com');
    }
  }
}

function seekRelative(delta) {
  if (playerMode !== 'itunes') return;
  audio.currentTime = Math.max(0, Math.min(audio.duration || 30, audio.currentTime + delta));
}

function updatePlayPauseBtn() {
  const btn = document.getElementById('btn-playpause');
  if (audio.paused) { btn.innerHTML = '&#9654;'; btn.title = 'Play (Space)'; }
  else              { btn.innerHTML = '&#9646;&#9646;'; btn.title = 'Pause (Space)'; }
}

function syncRowPlayBtn() {
  document.querySelectorAll('.row-play-btn').forEach(btn => {
    const row = btn.closest('.song-row');
    if (!row) return;
    if (row.dataset.id === currentSongId) {
      row.classList.add('is-playing');
      if (playerMode === 'itunes' && !audio.paused) {
        btn.classList.add('is-playing'); btn.innerHTML = '&#9646;&#9646;';
      } else if (playerMode === 'spotify') {
        btn.classList.add('is-playing'); btn.innerHTML = '&#9646;&#9646;';
      } else {
        btn.classList.remove('is-playing'); btn.innerHTML = '&#9654;';
      }
    } else {
      row.classList.remove('is-playing');
      btn.classList.remove('is-playing');
      btn.innerHTML = '&#9654;';
    }
  });
}

audio.addEventListener('play',  () => { updatePlayPauseBtn(); syncRowPlayBtn(); });
audio.addEventListener('pause', () => { updatePlayPauseBtn(); syncRowPlayBtn(); });
audio.addEventListener('ended', () => { updatePlayPauseBtn(); syncRowPlayBtn(); });
audio.addEventListener('timeupdate', () => {
  const dur = audio.duration || 30;
  document.getElementById('player-seek').value = (audio.currentTime / dur) * 100;
  document.getElementById('player-time-current').textContent = formatTime(audio.currentTime);
});
audio.addEventListener('durationchange', () => {
  document.getElementById('player-time-total').textContent = formatTime(audio.duration);
});

// ═══════════════════════════════════════════════════════════════════════════
// HEADER BUTTONS
// ═══════════════════════════════════════════════════════════════════════════

function updateHeaderButtons() {
  const t   = spotifyAuth.loadTokens();
  const btn = document.getElementById('btn-import-playlist');
  if (t?.accessToken) btn.classList.remove('hidden');
  else                btn.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════

function showToast(msg, duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className   = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 400);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════
// SONG VIEW
// ═══════════════════════════════════════════════════════════════════════════

const TAB_SOURCES = {
  tab4u:     { searchUrl: (a, t) => `https://en.tab4u.com/resultsSimple?tab=songs&q=${encodeURIComponent(`${a} ${t}`).replace(/%20/g,'+')}` },
  songsterr: { searchUrl: (a, t) => `https://www.songsterr.com/?pattern=${encodeURIComponent(`${a} ${t}`).replace(/%20/g,'+')}` },
  ug:        { searchUrl: (a, t) => `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(`${a} ${t}`).replace(/%20/g,'+')}` },
};

function openSongView(songId) {
  const song = library.find(s => s.id === songId);
  if (!song) return;
  viewingSongId = songId;

  document.getElementById('sv-artwork').src       = song.artwork || '';
  document.getElementById('sv-title').textContent  = song.title;
  document.getElementById('sv-artist').textContent = song.artist;

  for (const key of Object.keys(TAB_SOURCES)) {
    document.getElementById(`sv-search-${key}`).href = TAB_SOURCES[key].searchUrl(song.artist, song.title);
    const savedUrl = song.tabUrls?.[key] || null;
    _svApplyUrl(key, savedUrl);
    document.getElementById(`sv-url-${key}`).value = '';
  }

  _svSwitchTab('tab4u');
  const view = document.getElementById('song-view');
  view.classList.remove('hidden');
  view.focus();

  if (song.id !== currentSongId && (song.spotifyTrackId || song.previewUrl)) {
    playSong(song);
  }
}

function _svApplyUrl(source, url) {
  const openLink  = document.getElementById(`sv-open-${source}`);
  const clearBtn  = document.getElementById(`sv-clear-${source}`);
  const iframe    = document.getElementById(`sv-iframe-${source}`);
  const notice    = document.getElementById(`sv-iframe-notice-${source}`);
  if (url) {
    openLink.href = url;
    openLink.classList.remove('hidden');
    clearBtn.classList.remove('hidden');
    iframe.src = url;
    iframe.classList.remove('hidden');
    notice.classList.remove('hidden');
  } else {
    openLink.classList.add('hidden');
    clearBtn.classList.add('hidden');
    iframe.src = '';
    iframe.classList.add('hidden');
    notice.classList.add('hidden');
  }
}

function closeSongView() {
  viewingSongId = null;
  document.getElementById('song-view').classList.add('hidden');
}

function _svSwitchTab(key) {
  document.querySelectorAll('.sv-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === key);
  });
  document.querySelectorAll('.sv-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.panel !== key);
  });
}

function _svSaveUrl(source) {
  const song = library.find(s => s.id === viewingSongId);
  if (!song) return;
  const url = document.getElementById(`sv-url-${source}`).value.trim();
  if (!url) { showToast('Paste a URL first.'); return; }
  if (!song.tabUrls) song.tabUrls = {};
  song.tabUrls[source] = url;
  saveLibrary(library);
  _svApplyUrl(source, url);
  document.getElementById(`sv-url-${source}`).value = '';
  showToast('Saved.');
}

function _svClearUrl(source) {
  const song = library.find(s => s.id === viewingSongId);
  if (!song) return;
  if (!song.tabUrls) song.tabUrls = {};
  delete song.tabUrls[source];
  saveLibrary(library);
  _svApplyUrl(source, null);
  showToast('URL removed.');
}

function attachSongViewListeners() {
  document.getElementById('sv-back').addEventListener('click', closeSongView);
  document.getElementById('sv-edit').addEventListener('click', () => {
    if (viewingSongId) openEditModal(viewingSongId);
  });
  document.querySelectorAll('.sv-tab').forEach(btn => {
    btn.addEventListener('click', () => _svSwitchTab(btn.dataset.tab));
  });
  document.querySelector('.sv-panels').addEventListener('click', e => {
    const saveBtn  = e.target.closest('.sv-save-btn');
    if (saveBtn)  { _svSaveUrl(saveBtn.dataset.source);   return; }
    const clearBtn = e.target.closest('.sv-clear-btn');
    if (clearBtn) { _svClearUrl(clearBtn.dataset.source); return; }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════

function attachListeners() {
  // Header filter
  document.getElementById('header-filter').addEventListener('input', e => {
    filterQuery = e.target.value;
    renderGrid();
  });

  // iTunes search (debounced)
  document.getElementById('song-search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchItunes(e.target.value), 300);
  });

  // Grid — delegated
  document.getElementById('song-grid').addEventListener('click', e => {
    const del = e.target.closest('[data-action="delete"]');
    if (del) { const row = del.closest('.song-row'); if (row) deleteSong(row.dataset.id); return; }

    const pb = e.target.closest('[data-action="play"]');
    if (pb) {
      const row  = pb.closest('.song-row');
      const song = library.find(s => s.id === row?.dataset.id);
      if (!song || (!song.spotifyTrackId && !song.previewUrl)) return;
      if (song.id === currentSongId && playerMode === 'itunes') { togglePlay(); }
      else playSong(song);
      return;
    }

    const eb = e.target.closest('[data-action="edit"]');
    if (eb) { const row = eb.closest('.song-row'); if (row) openEditModal(row.dataset.id); return; }

    const chip = e.target.closest('[data-action="filter-tag"]');
    if (chip) { activeTag = chip.dataset.tag; render(); return; }

    // Open song view — click anywhere on row not captured above
    const row = e.target.closest('.song-row');
    if (row && !e.target.closest('button, a, [data-action]')) {
      openSongView(row.dataset.id);
    }
  });

  // Sidebar
  document.getElementById('sidebar').addEventListener('click', e => {
    const li = e.target.closest('li[data-tag]');
    if (!li) return;
    activeTag = li.dataset.tag === '' ? null : li.dataset.tag;
    render();
  });

  // Add-song form
  document.getElementById('add-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!pendingResult) return;
    const tags          = parseTags(document.getElementById('tags-input').value);
    const spotifyId     = spotifyLinkSection.getSelectedId();
    addSong(pendingResult, tags, spotifyId);
    closeAddModal();
    document.getElementById('song-search-input').value = '';
    document.getElementById('search-results').classList.add('hidden');
  });

  document.getElementById('tags-input').addEventListener('input', () => renderTagPicker('tag-picker', 'tags-input'));
  document.getElementById('edit-tags-input').addEventListener('input', () => renderTagPicker('edit-tag-picker', 'edit-tags-input'));

  document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeAddModal(); });

  // Edit modal
  document.getElementById('edit-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!editingSongId) return;
    const song = library.find(s => s.id === editingSongId);
    if (!song) { closeEditModal(); return; }

    const title  = document.getElementById('edit-title-input').value.trim();
    const artist = document.getElementById('edit-artist-input').value.trim();
    const tags   = parseTags(document.getElementById('edit-tags-input').value);
    const spVal  = document.getElementById('edit-spotify-url-input').value.trim();
    const spId   = parseSpotifyTrackId(spVal);

    if (title)  song.title  = title;
    if (artist) song.artist = artist;
    song.tags           = tags;
    song.spotifyTrackId = spId;

    saveLibrary(library);
    if (currentSongId === song.id) playSong(song);
    closeEditModal();
    render();
    showToast('Song updated.');
    if (viewingSongId === song.id) openSongView(song.id);
  });

  document.getElementById('btn-edit-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-modal-cancel').addEventListener('click', closeEditModal);
  document.getElementById('modal-edit').addEventListener('click', e => { if (e.target === e.currentTarget) closeEditModal(); });

  // Live Spotify URL validation in edit modal
  document.getElementById('edit-spotify-url-input').addEventListener('input', () => {
    const input  = document.getElementById('edit-spotify-url-input');
    const status = document.getElementById('edit-spotify-url-status');
    const val    = input.value.trim();
    if (!val) { input.className = ''; status.textContent = ''; return; }
    if (parseSpotifyTrackId(val)) {
      input.className      = 'valid';
      status.textContent   = '✓';
      status.style.color   = 'var(--spotify)';
    } else {
      input.className      = 'invalid';
      status.textContent   = '✗';
      status.style.color   = 'var(--danger)';
    }
  });

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', settingsModal.open);
  document.getElementById('btn-settings-close').addEventListener('click', settingsModal.close);
  document.getElementById('modal-settings').addEventListener('click', e => { if (e.target === e.currentTarget) settingsModal.close(); });
  document.getElementById('btn-connect-spotify').addEventListener('click', settingsModal.handleConnect);
  document.getElementById('btn-disconnect-spotify').addEventListener('click', settingsModal.handleDisconnect);
  document.getElementById('btn-copy-redirect-uri').addEventListener('click', () => {
    const val = document.getElementById('input-spotify-redirect-uri').value.trim();
    if (!val) return;
    navigator.clipboard.writeText(val).then(() => showToast('Redirect URI copied!'));
  });

  // Import playlist modal
  document.getElementById('btn-import-playlist').addEventListener('click', importModal.open);
  document.getElementById('btn-import-close').addEventListener('click', importModal.close);
  document.getElementById('btn-import-cancel').addEventListener('click', importModal.close);
  document.getElementById('modal-import').addEventListener('click', e => { if (e.target === e.currentTarget) importModal.close(); });
  document.getElementById('btn-fetch-playlist').addEventListener('click', importModal.handleFetch);
  document.getElementById('input-playlist-url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); importModal.handleFetch(); } });
  document.getElementById('btn-select-all').addEventListener('click', importModal.handleSelectAll);
  document.getElementById('btn-deselect-all').addEventListener('click', importModal.handleDeselectAll);
  document.getElementById('btn-import-confirm').addEventListener('click', importModal.handleConfirm);

  // Player bar
  document.getElementById('btn-playpause').addEventListener('click', togglePlay);
  document.getElementById('btn-prev5').addEventListener('click', () => seekRelative(-5));
  document.getElementById('btn-next5').addEventListener('click', () => seekRelative(5));
  document.getElementById('player-close').addEventListener('click', stopPlayer);
  document.getElementById('player-seek').addEventListener('input', e => {
    const dur = audio.duration || 30;
    audio.currentTime = (e.target.value / 100) * dur;
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if (e.key === 'Escape') {
      if (!document.getElementById('modal-settings').classList.contains('hidden')) { settingsModal.close(); return; }
      if (!document.getElementById('modal-import').classList.contains('hidden'))   { importModal.close();   return; }
      if (!document.getElementById('modal-edit').classList.contains('hidden'))     { closeEditModal();      return; }
      if (!document.getElementById('modal-overlay').classList.contains('hidden'))  { closeAddModal();       return; }
      if (!document.getElementById('song-view').classList.contains('hidden'))      { closeSongView();       return; }
      const panel = document.getElementById('search-results');
      if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        document.getElementById('song-search-input').value = '';
      }
      return;
    }

    if (inInput) return;
    if (e.key === ' ')          { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); seekRelative(-5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekRelative(5); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  // Handle OAuth callback first (page may have ?code= in URL)
  const wasCallback = await spotifyAuth.handleOAuthCallback();

  library = loadLibrary();
  attachListeners();
  attachSongViewListeners();
  spotifyLinkSection.attachInputListener();
  updateHeaderButtons();
  settingsModal.updateStatus();
  render();

  if (wasCallback) settingsModal.updateStatus();
}

init();
