require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'data', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── DATABASE ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#2d5be3',
      position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS songs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      key_signature TEXT,
      genre TEXT,
      reference_link TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS song_categories (
      song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      PRIMARY KEY (song_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS lyrics_blocks (
      id SERIAL PRIMARY KEY,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      num INTEGER DEFAULT 1,
      content TEXT DEFAULT '',
      position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audio_files (
      id SERIAL PRIMARY KEY,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stem_type TEXT NOT NULL,
      stem_category TEXT NOT NULL,
      stem_label TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO settings (key, value) VALUES
      ('group_name', 'Répertoire Musical'),
      ('group_subtitle', 'Groupe de Musique'),
      ('pin_contributor', '1234'),
      ('pin_admin', '0000')
    ON CONFLICT (key) DO NOTHING;
  `);
  console.log('✅ Base de données initialisée');
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
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
app.post('/api/verify-pin', async (req, res) => {
  const { pin, level } = req.body;
  const key = level === 'admin' ? 'pin_admin' : 'pin_contributor';
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  rows[0]?.value === String(pin) ? res.json({ ok: true }) : res.status(401).json({ ok: false });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('group_name','group_subtitle')");
  const result = {}; rows.forEach(r => result[r.key] = r.value); res.json(result);
});

app.put('/api/settings', async (req, res) => {
  const { pin_admin, group_name, group_subtitle, new_pin_contributor, new_pin_admin } = req.body;
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', ['pin_admin']);
  if (rows[0]?.value !== String(pin_admin)) return res.status(401).json({ error: 'PIN admin incorrect' });
  if (group_name !== undefined) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['group_name', group_name]);
  if (group_subtitle !== undefined) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['group_subtitle', group_subtitle]);
  if (new_pin_contributor) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['pin_contributor', String(new_pin_contributor)]);
  if (new_pin_admin) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['pin_admin', String(new_pin_admin)]);
  res.json({ ok: true });
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────
app.get('/api/categories', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY position, id');
  res.json(rows);
});

app.post('/api/categories', async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const { rows } = await pool.query('INSERT INTO categories(name,color) VALUES($1,$2) RETURNING *', [name.toUpperCase(), color||'#2d5be3']);
  res.json(rows[0]);
});

app.delete('/api/categories/:id', async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── SONGS ─────────────────────────────────────────────────────────────────────
async function getSongFull(id) {
  const { rows: songs } = await pool.query('SELECT * FROM songs WHERE id=$1', [id]);
  if (!songs[0]) return null;
  const song = songs[0];
  const { rows: cats } = await pool.query('SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1', [id]);
  const { rows: lyrics } = await pool.query('SELECT * FROM lyrics_blocks WHERE song_id=$1 ORDER BY position,id', [id]);
  const { rows: audio } = await pool.query('SELECT * FROM audio_files WHERE song_id=$1 ORDER BY stem_type,stem_category,uploaded_at', [id]);
  return { ...song, categories: cats, lyrics, audio_files: audio };
}

app.get('/api/songs', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM songs ORDER BY title');
  const songs = await Promise.all(rows.map(async s => {
    const { rows: cats } = await pool.query('SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1', [s.id]);
    const { rows: cnt } = await pool.query('SELECT COUNT(*) as n FROM audio_files WHERE song_id=$1', [s.id]);
    return { ...s, categories: cats, audio_count: parseInt(cnt[0].n) };
  }));
  res.json(songs);
});

app.get('/api/songs/:id', async (req, res) => {
  const song = await getSongFull(req.params.id);
  song ? res.json(song) : res.status(404).json({ error: 'Introuvable' });
});

app.post('/api/songs', async (req, res) => {
  const { title, author, key_signature, genre, reference_link, notes, category_ids, lyrics } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const { rows } = await pool.query(
    'INSERT INTO songs(title,author,key_signature,genre,reference_link,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [title, author||null, key_signature||null, genre||null, reference_link||null, notes||null]
  );
  const songId = rows[0].id;
  if (category_ids?.length) {
    for (const cid of category_ids) await pool.query('INSERT INTO song_categories(song_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [songId, cid]);
  }
  if (lyrics?.length) {
    for (const [i, b] of lyrics.entries()) await pool.query('INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)', [songId, b.type, b.num||1, b.content||'', i]);
  }
  res.json(await getSongFull(songId));
});

app.put('/api/songs/:id', async (req, res) => {
  const id = req.params.id;
  const { title, author, key_signature, genre, reference_link, notes, category_ids, lyrics } = req.body;
  await pool.query('UPDATE songs SET title=$1,author=$2,key_signature=$3,genre=$4,reference_link=$5,notes=$6,updated_at=NOW() WHERE id=$7',
    [title, author||null, key_signature||null, genre||null, reference_link||null, notes||null, id]);
  await pool.query('DELETE FROM song_categories WHERE song_id=$1', [id]);
  if (category_ids?.length) {
    for (const cid of category_ids) await pool.query('INSERT INTO song_categories(song_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, cid]);
  }
  await pool.query('DELETE FROM lyrics_blocks WHERE song_id=$1', [id]);
  if (lyrics?.length) {
    for (const [i, b] of lyrics.entries()) await pool.query('INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)', [id, b.type, b.num||1, b.content||'', i]);
  }
  res.json(await getSongFull(id));
});

app.delete('/api/songs/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT filename FROM audio_files WHERE song_id=$1', [req.params.id]);
  rows.forEach(f => { const fp = path.join(UPLOADS_DIR, f.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
  await pool.query('DELETE FROM songs WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── AUDIO ─────────────────────────────────────────────────────────────────────
app.post('/api/songs/:id/audio', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  const { stem_type, stem_category, stem_label } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO audio_files(song_id,filename,original_name,stem_type,stem_category,stem_label,file_size) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.params.id, req.file.filename, req.file.originalname, stem_type, stem_category, stem_label, req.file.size]
  );
  res.json(rows[0]);
});

app.delete('/api/audio/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM audio_files WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Introuvable' });
  const fp = path.join(UPLOADS_DIR, rows[0].filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  await pool.query('DELETE FROM audio_files WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));
}).catch(err => {
  console.error('❌ Erreur de connexion à la base de données:', err.message);
  process.exit(1);
});
