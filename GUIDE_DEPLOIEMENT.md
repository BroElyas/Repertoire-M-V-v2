require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'repertoire.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── JSON FILE DATABASE (zero dependencies) ───────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_PATH)) return getDefaultDB();
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch(e) { return getDefaultDB(); }
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function getDefaultDB() {
  return {
    settings: {
      group_name: 'Répertoire Musical',
      group_subtitle: 'Groupe de Musique',
      pin_contributor: '1234',
      pin_admin: '0000'
    },
    categories: [],
    songs: [],
    audio_files: [],
    _nextId: { category: 1, song: 1, audio: 1 }
  };
}

function nextId(db, type) {
  if (!db._nextId) db._nextId = { category: 1, song: 1, audio: 1 };
  return db._nextId[type]++;
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100*1024*1024 } });

// ── PIN ───────────────────────────────────────────────────────────────────────
app.post('/api/verify-pin', (req, res) => {
  const db = loadDB();
  const { pin, level } = req.body;
  const key = level === 'admin' ? 'pin_admin' : 'pin_contributor';
  db.settings[key] === String(pin) ? res.json({ ok: true }) : res.status(401).json({ ok: false });
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const db = loadDB();
  res.json({ group_name: db.settings.group_name, group_subtitle: db.settings.group_subtitle });
});

app.put('/api/settings', (req, res) => {
  const db = loadDB();
  const { pin_admin, group_name, group_subtitle, new_pin_contributor, new_pin_admin } = req.body;
  if (db.settings.pin_admin !== String(pin_admin)) return res.status(401).json({ error: 'PIN admin incorrect' });
  if (group_name !== undefined) db.settings.group_name = group_name;
  if (group_subtitle !== undefined) db.settings.group_subtitle = group_subtitle;
  if (new_pin_contributor) db.settings.pin_contributor = String(new_pin_contributor);
  if (new_pin_admin) db.settings.pin_admin = String(new_pin_admin);
  saveDB(db); res.json({ ok: true });
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────
app.get('/api/categories', (req, res) => res.json(loadDB().categories));

app.post('/api/categories', (req, res) => {
  const db = loadDB();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const cat = { id: nextId(db, 'category'), name: name.toUpperCase(), color: color || '#2d5be3' };
  db.categories.push(cat); saveDB(db); res.json(cat);
});

app.delete('/api/categories/:id', (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.categories = db.categories.filter(c => c.id !== id);
  db.songs.forEach(s => { s.category_ids = (s.category_ids || []).filter(cid => cid !== id); });
  saveDB(db); res.json({ ok: true });
});

// ── SONGS ─────────────────────────────────────────────────────────────────────
function enrichSong(song, db) {
  return {
    ...song,
    categories: (song.category_ids || []).map(cid => db.categories.find(c => c.id === cid)).filter(Boolean),
    audio_files: db.audio_files.filter(a => a.song_id === song.id),
    audio_count: db.audio_files.filter(a => a.song_id === song.id).length
  };
}

app.get('/api/songs', (req, res) => {
  const db = loadDB();
  const songs = [...db.songs].sort((a,b) => a.title.localeCompare(b.title));
  res.json(songs.map(s => enrichSong(s, db)));
});

app.get('/api/songs/:id', (req, res) => {
  const db = loadDB();
  const song = db.songs.find(s => s.id === parseInt(req.params.id));
  if (!song) return res.status(404).json({ error: 'Introuvable' });
  res.json(enrichSong(song, db));
});

app.post('/api/songs', (req, res) => {
  const db = loadDB();
  const { title, author, key_signature, genre, reference_link, notes, category_ids, lyrics } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const song = {
    id: nextId(db, 'song'), title, author: author||null,
    key_signature: key_signature||null, genre: genre||null,
    reference_link: reference_link||null, notes: notes||null,
    category_ids: category_ids || [],
    lyrics: (lyrics || []).map((b,i) => ({...b, position: i})),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  db.songs.push(song); saveDB(db); res.json(enrichSong(song, db));
});

app.put('/api/songs/:id', (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const idx = db.songs.findIndex(s => s.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Introuvable' });
  const { title, author, key_signature, genre, reference_link, notes, category_ids, lyrics } = req.body;
  db.songs[idx] = {
    ...db.songs[idx], title, author: author||null,
    key_signature: key_signature||null, genre: genre||null,
    reference_link: reference_link||null, notes: notes||null,
    category_ids: category_ids || [],
    lyrics: (lyrics || []).map((b,i) => ({...b, position: i})),
    updated_at: new Date().toISOString()
  };
  saveDB(db); res.json(enrichSong(db.songs[idx], db));
});

app.delete('/api/songs/:id', (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const audioFiles = db.audio_files.filter(a => a.song_id === id);
  audioFiles.forEach(a => {
    const fp = path.join(UPLOADS_DIR, a.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  db.songs = db.songs.filter(s => s.id !== id);
  db.audio_files = db.audio_files.filter(a => a.song_id !== id);
  saveDB(db); res.json({ ok: true });
});

// ── AUDIO ─────────────────────────────────────────────────────────────────────
app.post('/api/songs/:id/audio', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  const db = loadDB();
  const { stem_type, stem_category, stem_label } = req.body;
  const audio = {
    id: nextId(db, 'audio'),
    song_id: parseInt(req.params.id),
    filename: req.file.filename,
    original_name: req.file.originalname,
    stem_type, stem_category, stem_label,
    file_size: req.file.size,
    uploaded_at: new Date().toISOString()
  };
  db.audio_files.push(audio); saveDB(db); res.json(audio);
});

app.delete('/api/audio/:id', (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const audio = db.audio_files.find(a => a.id === id);
  if (!audio) return res.status(404).json({ error: 'Introuvable' });
  const fp = path.join(UPLOADS_DIR, audio.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.audio_files = db.audio_files.filter(a => a.id !== id);
  saveDB(db); res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));
