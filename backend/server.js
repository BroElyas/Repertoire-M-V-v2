require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Database
const db = new Database(path.join(DATA_DIR, 'repertoire.db'));

// Init schema
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#2d5be3',
    position INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT,
    key_signature TEXT,
    genre TEXT,
    reference_link TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS song_categories (
    song_id INTEGER,
    category_id INTEGER,
    PRIMARY KEY (song_id, category_id),
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lyrics_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    num INTEGER DEFAULT 1,
    content TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stem_type TEXT NOT NULL,
    stem_category TEXT NOT NULL,
    stem_label TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    duration_seconds INTEGER,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
  );
`);

// Default settings
const defaultSettings = [
  ['group_name', 'Répertoire Musical'],
  ['group_subtitle', 'Groupe de Musique'],
  ['pin_contributor', '1234'],
  ['pin_admin', '0000'],
];
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
defaultSettings.forEach(([k, v]) => insertSetting.run(k, v));

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// Multer for audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Format audio non supporté'));
  }
});

// ─── PIN VERIFICATION ────────────────────────────────────────────────────────
app.post('/api/verify-pin', (req, res) => {
  const { pin, level } = req.body;
  const key = level === 'admin' ? 'pin_admin' : 'pin_contributor';
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (stored && stored.value === String(pin)) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'PIN incorrect' });
  }
});

// ─── SETTINGS ────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').all('group_name', 'group_subtitle');
  const result = {};
  rows.forEach(r => result[r.key] = r.value);
  res.json(result);
});

app.put('/api/settings', (req, res) => {
  const { pin_admin, group_name, group_subtitle, new_pin_contributor, new_pin_admin } = req.body;
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('pin_admin');
  if (!stored || stored.value !== String(pin_admin)) return res.status(401).json({ error: 'PIN admin incorrect' });

  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (group_name !== undefined) update.run('group_name', group_name);
  if (group_subtitle !== undefined) update.run('group_subtitle', group_subtitle);
  if (new_pin_contributor) update.run('pin_contributor', String(new_pin_contributor));
  if (new_pin_admin) update.run('pin_admin', String(new_pin_admin));
  res.json({ ok: true });
});

// ─── CATEGORIES ──────────────────────────────────────────────────────────────
app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY position, id').all());
});

app.post('/api/categories', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const result = db.prepare('INSERT INTO categories (name, color) VALUES (?, ?)').run(name.toUpperCase(), color || '#2d5be3');
  res.json({ id: result.lastInsertRowid, name: name.toUpperCase(), color: color || '#2d5be3' });
});

app.put('/api/categories/:id', (req, res) => {
  const { name, color } = req.body;
  db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(name, color, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── SONGS ───────────────────────────────────────────────────────────────────
function getSongFull(id) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return null;
  song.categories = db.prepare(`
    SELECT c.* FROM categories c
    JOIN song_categories sc ON sc.category_id = c.id
    WHERE sc.song_id = ?
  `).all(id);
  song.lyrics = db.prepare('SELECT * FROM lyrics_blocks WHERE song_id = ? ORDER BY position, id').all(id);
  song.audio_files = db.prepare('SELECT * FROM audio_files WHERE song_id = ? ORDER BY stem_type, stem_category, uploaded_at').all(id);
  return song;
}

app.get('/api/songs', (req, res) => {
  const songs = db.prepare('SELECT * FROM songs ORDER BY title COLLATE NOCASE').all();
  const result = songs.map(s => {
    s.categories = db.prepare(`
      SELECT c.* FROM categories c
      JOIN song_categories sc ON sc.category_id = c.id
      WHERE sc.song_id = ?
    `).all(s.id);
    s.audio_count = db.prepare('SELECT COUNT(*) as n FROM audio_files WHERE song_id = ?').get(s.id).n;
    return s;
  });
  res.json(result);
});

app.get('/api/songs/:id', (req, res) => {
  const song = getSongFull(req.params.id);
  if (!song) return res.status(404).json({ error: 'Chant introuvable' });
  res.json(song);
});

app.post('/api/songs', (req, res) => {
  const { title, author, key_signature, genre, reference_link, notes, category_ids, lyrics } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });

  const result = db.prepare(`
    INSERT INTO songs (title, author, key_signature, genre, reference_link, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, author || null, key_signature || null, genre || null, reference_link || null, notes || null);

  const songId = result.lastInsertRowid;

  if (category_ids?.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO song_categories (song_id, category_id) VALUES (?, ?)');
    category_ids.forEach(cid => ins.run(songId, cid));
  }

  if (lyrics?.length) {
    const ins = db.prepare('INSERT INTO lyrics_blocks (song_id, type, num, content, position) VALUES (?, ?, ?, ?, ?)');
    lyrics.forEach((b, i) => ins.run(songId, b.type, b.num || 1, b.content || '', i));
  }

  res.json(getSongFull(songId));
});

app.put('/api/songs/:id', (req, res) => {
  const { title, author, key_signature, genre, reference_link, notes, category_ids, lyrics } = req.body;
  const id = req.params.id;

  db.prepare(`
    UPDATE songs SET title=?, author=?, key_signature=?, genre=?, reference_link=?, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(title, author || null, key_signature || null, genre || null, reference_link || null, notes || null, id);

  db.prepare('DELETE FROM song_categories WHERE song_id = ?').run(id);
  if (category_ids?.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO song_categories (song_id, category_id) VALUES (?, ?)');
    category_ids.forEach(cid => ins.run(id, cid));
  }

  db.prepare('DELETE FROM lyrics_blocks WHERE song_id = ?').run(id);
  if (lyrics?.length) {
    const ins = db.prepare('INSERT INTO lyrics_blocks (song_id, type, num, content, position) VALUES (?, ?, ?, ?, ?)');
    lyrics.forEach((b, i) => ins.run(id, b.type, b.num || 1, b.content || '', i));
  }

  res.json(getSongFull(id));
});

app.delete('/api/songs/:id', (req, res) => {
  const files = db.prepare('SELECT filename FROM audio_files WHERE song_id = ?').all(req.params.id);
  files.forEach(f => {
    const fp = path.join(UPLOADS_DIR, f.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  db.prepare('DELETE FROM songs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── AUDIO FILES ─────────────────────────────────────────────────────────────
app.post('/api/songs/:id/audio', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  const { stem_type, stem_category, stem_label } = req.body;
  const result = db.prepare(`
    INSERT INTO audio_files (song_id, filename, original_name, stem_type, stem_category, stem_label, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, req.file.filename, req.file.originalname, stem_type, stem_category, stem_label, req.file.size);
  res.json({ id: result.lastInsertRowid, filename: req.file.filename, original_name: req.file.originalname, stem_type, stem_category, stem_label });
});

app.delete('/api/audio/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(req.params.id);
  if (!file) return res.status(404).json({ error: 'Fichier introuvable' });
  const fp = path.join(UPLOADS_DIR, file.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM audio_files WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── CATCH ALL ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Répertoire Musical démarré sur http://localhost:${PORT}`);
  console.log(`📁 Données : ${DATA_DIR}`);
});
