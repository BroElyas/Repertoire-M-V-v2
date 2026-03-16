require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// -- SUPABASE STORAGE ---------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET_MV   = 'mv-audio';
const BUCKET_MIVE = 'mive-audio';

async function initBuckets() {
  for (const bucket of [BUCKET_MV, BUCKET_MIVE]) {
    const { data, error } = await supabase.storage.getBucket(bucket);
    if (!data) {
      await supabase.storage.createBucket(bucket, { public: true });
      console.log(` Bucket cree: ${bucket}`);
    }
  }
}

async function uploadToSupabase(bucket, filename, buffer, mimetype) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filename, buffer, { contentType: mimetype, upsert: true });
  if (error) throw new Error(`Supabase upload error: ${error.message}`);
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);
  return urlData.publicUrl;
}

async function deleteFromSupabase(bucket, filename) {
  await supabase.storage.from(bucket).remove([filename]);
}

// -- DATABASE ------------------------------------------------------------------
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
      bpm INTEGER,
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
      file_url TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE songs ADD COLUMN IF NOT EXISTS bpm INTEGER;
    ALTER TABLE songs ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
    ALTER TABLE audio_files ADD COLUMN IF NOT EXISTS file_url TEXT;
    ALTER TABLE songs ADD COLUMN IF NOT EXISTS stem_category TEXT;
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      song_title TEXT,
      contributor_name TEXT,
      browser TEXT,
      os TEXT,
      language TEXT,
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS contributor_name TEXT;
    CREATE TABLE IF NOT EXISTS contributors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#8b1a2e',
      can_edit_lyrics BOOLEAN DEFAULT TRUE,
      can_edit_bpm BOOLEAN DEFAULT FALSE,
      can_edit_key BOOLEAN DEFAULT FALSE,
      can_create_song BOOLEAN DEFAULT FALSE,
      can_edit_author BOOLEAN DEFAULT FALSE,
      can_edit_genre BOOLEAN DEFAULT FALSE,
      can_edit_categories BOOLEAN DEFAULT FALSE,
      can_edit_link BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_lyrics BOOLEAN DEFAULT TRUE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_bpm BOOLEAN DEFAULT FALSE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_key BOOLEAN DEFAULT FALSE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_create_song BOOLEAN DEFAULT FALSE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_author BOOLEAN DEFAULT FALSE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_genre BOOLEAN DEFAULT FALSE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_categories BOOLEAN DEFAULT FALSE;
    ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_link BOOLEAN DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS ignored_duplicates (
      id SERIAL PRIMARY KEY,
      song_id1 INTEGER NOT NULL,
      song_id2 INTEGER NOT NULL,
      ignored_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(song_id1, song_id2)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE,
      song_title TEXT,
      message TEXT NOT NULL,
      browser TEXT,
      os TEXT,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pending_changes (
      id SERIAL PRIMARY KEY,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      song_title TEXT,
      contributor_id INTEGER REFERENCES contributors(id) ON DELETE SET NULL,
      contributor_name TEXT,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      affected_fields TEXT[],
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT
    );
    ALTER TABLE pending_changes ADD COLUMN IF NOT EXISTS affected_fields TEXT[];
    CREATE TABLE IF NOT EXISTS setlist (
      id SERIAL PRIMARY KEY,
      section TEXT NOT NULL,
      song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
      song_title TEXT,
      position INTEGER DEFAULT 0,
      special_label TEXT,
      special_after TEXT DEFAULT 'principale',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- MIVE TABLES --------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS mive_loops (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      bpm INTEGER,
      genre TEXT,
      time_signature TEXT,
      key_signature TEXT,
      filename TEXT NOT NULL,
      file_url TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'mive',
      song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE mive_loops ADD COLUMN IF NOT EXISTS time_signature TEXT;
    ALTER TABLE mive_loops ADD COLUMN IF NOT EXISTS key_signature TEXT;
    ALTER TABLE mive_loops ADD COLUMN IF NOT EXISTS trim_start FLOAT DEFAULT 0;
    ALTER TABLE mive_loops ADD COLUMN IF NOT EXISTS trim_end FLOAT DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS mive_setlists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'mive',
      mv_setlist_id INTEGER DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mive_setlist_items (
      id SERIAL PRIMARY KEY,
      setlist_id INTEGER NOT NULL REFERENCES mive_setlists(id) ON DELETE CASCADE,
      song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL,
      song_title TEXT,
      bpm INTEGER,
      key_signature TEXT,
      position INTEGER DEFAULT 0,
      loop_rythmique_id INTEGER REFERENCES mive_loops(id) ON DELETE SET NULL,
      loop_harmonique_id INTEGER REFERENCES mive_loops(id) ON DELETE SET NULL
    );

    INSERT INTO settings (key, value) VALUES
      ('group_name', 'Repertoire Musical'),
      ('group_subtitle', 'Groupe de Musique'),
      ('pin_admin', '0000')
    ON CONFLICT (key) DO NOTHING;
  `);
  console.log(' Base de donnees initialisee');
}

// -- MIDDLEWARE ----------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

// Multer - stockage en memoire (on envoie vers Supabase ensuite)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// -- PIN -----------------------------------------------------------------------
app.post('/api/verify-pin', async (req, res) => {
  const { pin, level } = req.body;
  if (level === 'admin') {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', ['pin_admin']);
    return rows[0]?.value === String(pin) ? res.json({ ok: true, level: 'admin' }) : res.status(401).json({ ok: false });
  }
  const { rows: contribs } = await pool.query('SELECT * FROM contributors WHERE pin = $1', [String(pin)]);
  if (contribs[0]) {
    const c = contribs[0];
    return res.json({ ok: true, level: 'contributor', contributor_id: c.id, contributor_name: c.name,
      permissions: { can_edit_lyrics: c.can_edit_lyrics, can_edit_bpm: c.can_edit_bpm, can_edit_key: c.can_edit_key, can_create_song: c.can_create_song, can_edit_author: c.can_edit_author, can_edit_genre: c.can_edit_genre, can_edit_categories: c.can_edit_categories, can_edit_link: c.can_edit_link }
    });
  }
  return res.status(401).json({ ok: false });
});

// -- CONTRIBUTORS --------------------------------------------------------------
app.get('/api/contributors', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, can_edit_author, can_edit_genre, can_edit_categories, can_edit_link, created_at FROM contributors ORDER BY name');
  res.json(rows);
});

app.post('/api/contributors', async (req, res) => {
  const { name, pin, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, can_edit_author, can_edit_genre, can_edit_categories, can_edit_link } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'Nom et PIN requis' });
  if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN doit etre 4 chiffres' });
  const { rows: existing } = await pool.query('SELECT id FROM contributors WHERE pin = $1', [String(pin)]);
  if (existing.length) return res.status(400).json({ error: 'Ce PIN est deja utilise' });
  const { rows } = await pool.query(
    'INSERT INTO contributors(name, pin, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, can_edit_author, can_edit_genre, can_edit_categories, can_edit_link) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, can_edit_author, can_edit_genre, can_edit_categories, can_edit_link, created_at',
    [name.trim(), String(pin), color||'#8b1a2e', can_edit_lyrics!==false, can_edit_bpm===true, can_edit_key===true, can_create_song===true, can_edit_author===true, can_edit_genre===true, can_edit_categories===true, can_edit_link===true]
  );
  res.json(rows[0]);
});

app.delete('/api/contributors/:id', async (req, res) => {
  await pool.query('DELETE FROM contributors WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.patch('/api/contributors/:id', async (req, res) => {
  const { name, pin, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, can_edit_author, can_edit_genre, can_edit_categories, can_edit_link } = req.body;
  if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN doit etre 4 chiffres' });
  if (pin) {
    const { rows: existing } = await pool.query('SELECT id FROM contributors WHERE pin = $1 AND id != $2', [String(pin), req.params.id]);
    if (existing.length) return res.status(400).json({ error: 'Ce PIN est deja utilise' });
  }
  const fields = [], vals = [];
  if (name !== undefined)  { fields.push(`name=$${fields.length+1}`);  vals.push(name.trim()); }
  if (pin !== undefined)   { fields.push(`pin=$${fields.length+1}`);   vals.push(String(pin)); }
  if (color !== undefined) { fields.push(`color=$${fields.length+1}`); vals.push(color); }
  if (can_edit_lyrics !== undefined)     { fields.push(`can_edit_lyrics=$${fields.length+1}`);     vals.push(can_edit_lyrics); }
  if (can_edit_author !== undefined)     { fields.push(`can_edit_author=$${fields.length+1}`);     vals.push(can_edit_author); }
  if (can_edit_genre !== undefined)      { fields.push(`can_edit_genre=$${fields.length+1}`);      vals.push(can_edit_genre); }
  if (can_edit_categories !== undefined) { fields.push(`can_edit_categories=$${fields.length+1}`); vals.push(can_edit_categories); }
  if (can_edit_link !== undefined)       { fields.push(`can_edit_link=$${fields.length+1}`);       vals.push(can_edit_link); }
  if (can_edit_bpm !== undefined)        { fields.push(`can_edit_bpm=$${fields.length+1}`);        vals.push(can_edit_bpm); }
  if (can_edit_key !== undefined)        { fields.push(`can_edit_key=$${fields.length+1}`);        vals.push(can_edit_key); }
  if (can_create_song !== undefined)     { fields.push(`can_create_song=$${fields.length+1}`);     vals.push(can_create_song); }
  if (!fields.length) return res.status(400).json({ error: 'Rien a modifier' });
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE contributors SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING id,name,color,can_edit_lyrics,can_edit_bpm,can_edit_key,can_create_song,can_edit_author,can_edit_genre,can_edit_categories,can_edit_link,created_at`, vals);
  res.json(rows[0]);
});

// -- SETTINGS ------------------------------------------------------------------
app.get('/api/settings', async (req, res) => {
  const { rows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('group_name','group_subtitle')");
  const result = {}; rows.forEach(r => result[r.key] = r.value); res.json(result);
});

app.put('/api/settings', async (req, res) => {
  const { pin_admin, group_name, group_subtitle, new_pin_admin } = req.body;
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', ['pin_admin']);
  if (rows[0]?.value !== String(pin_admin)) return res.status(401).json({ error: 'PIN admin incorrect' });
  if (group_name !== undefined) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['group_name', group_name]);
  if (group_subtitle !== undefined) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['group_subtitle', group_subtitle]);
  if (new_pin_admin) await pool.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2', ['pin_admin', String(new_pin_admin)]);
  res.json({ ok: true });
});

// -- CATEGORIES ----------------------------------------------------------------
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

app.patch('/api/categories/:id', async (req, res) => {
  const { color } = req.body;
  const { rows } = await pool.query('UPDATE categories SET color=$1 WHERE id=$2 RETURNING *', [color, req.params.id]);
  res.json(rows[0]);
});

// -- SEARCH --------------------------------------------------------------------
app.get('/api/search', async (req, res) => {
  const q = (req.query.q||'').trim();
  if(!q) return res.json([]);
  const pattern = `%${q}%`;
  const { rows } = await pool.query(`
    SELECT DISTINCT s.*,
      (SELECT string_agg(lb.content, ' ') FROM lyrics_blocks lb WHERE lb.song_id = s.id) as lyrics_preview
    FROM songs s
    LEFT JOIN lyrics_blocks lb ON lb.song_id = s.id
    WHERE s.title ILIKE $1 OR s.author ILIKE $1 OR lb.content ILIKE $1
    ORDER BY s.title LIMIT 50
  `, [pattern]);
  const songs = await Promise.all(rows.map(async s => {
    const { rows: cats } = await pool.query('SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1', [s.id]);
    const { rows: cnt } = await pool.query('SELECT COUNT(*) as n FROM audio_files WHERE song_id=$1', [s.id]);
    const matchInLyrics = s.lyrics_preview && s.lyrics_preview.toLowerCase().includes(q.toLowerCase());
    return { ...s, categories: cats, audio_count: parseInt(cnt[0].n), match_in_lyrics: matchInLyrics };
  }));
  res.json(songs);
});

// -- PIN SONG ------------------------------------------------------------------
app.patch('/api/songs/:id/pin', async (req, res) => {
  const { pinned } = req.body;
  await pool.query('UPDATE songs SET pinned=$1 WHERE id=$2', [pinned, req.params.id]);
  res.json({ ok: true });
});

// -- INCOMPLETE SONGS ----------------------------------------------------------
app.get('/api/songs/incomplete', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*,
      (s.bpm IS NULL) as missing_bpm,
      (s.key_signature IS NULL OR s.key_signature = '') as missing_key,
      (s.author IS NULL OR s.author = '') as missing_author,
      (s.genre IS NULL OR s.genre = '') as missing_genre,
      (NOT EXISTS (SELECT 1 FROM lyrics_blocks lb WHERE lb.song_id = s.id)) as missing_lyrics,
      (s.pinned = true) as is_pinned
    FROM songs s
    WHERE s.bpm IS NULL OR s.key_signature IS NULL OR s.key_signature = ''
       OR s.author IS NULL OR s.author = ''
       OR NOT EXISTS (SELECT 1 FROM lyrics_blocks lb WHERE lb.song_id = s.id)
       OR s.pinned = true
    ORDER BY s.pinned DESC, s.title
  `);
  res.json(rows);
});

// -- FEEDBACK ------------------------------------------------------------------
app.post('/api/feedback', async (req, res) => {
  const { song_id, song_title, message, browser, os } = req.body;
  if(!message) return res.status(400).json({ error: 'Message requis' });
  await pool.query('INSERT INTO feedback(song_id,song_title,message,browser,os) VALUES($1,$2,$3,$4,$5)',
    [song_id||null, song_title||null, message, browser||null, os||null]);
  res.json({ ok: true });
});

app.get('/api/feedback', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC');
  res.json(rows);
});

app.patch('/api/feedback/:id/read', async (req, res) => {
  await pool.query('UPDATE feedback SET read=true WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/feedback/:id', async (req, res) => {
  await pool.query('DELETE FROM feedback WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// -- STATS ---------------------------------------------------------------------
app.get('/api/stats', async (req, res) => {
  const { rows: catStats } = await pool.query(`
    SELECT c.name, c.color, COUNT(sc.song_id) as count
    FROM categories c LEFT JOIN song_categories sc ON sc.category_id = c.id
    GROUP BY c.id, c.name, c.color ORDER BY count DESC
  `);
  const { rows: total }  = await pool.query('SELECT COUNT(*) as n FROM songs');
  const { rows: nocat }  = await pool.query('SELECT COUNT(*) as n FROM songs s WHERE NOT EXISTS (SELECT 1 FROM song_categories sc WHERE sc.song_id = s.id)');
  const { rows: pinned } = await pool.query('SELECT COUNT(*) as n FROM songs WHERE pinned = true');
  const { rows: unread } = await pool.query('SELECT COUNT(*) as n FROM feedback WHERE read = false');
  res.json({ categories: catStats, total_songs: parseInt(total[0].n), no_category: parseInt(nocat[0].n), pinned: parseInt(pinned[0].n), unread_feedback: parseInt(unread[0].n) });
});

// -- DUPLICATE DETECTION -------------------------------------------------------
function normalize(str){
  return (str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
}

app.get('/api/songs/check-duplicate', async (req, res) => {
  const title = (req.query.title||'').trim();
  if(!title) return res.json([]);
  const normInput = normalize(title);
  const { rows } = await pool.query('SELECT id, title FROM songs ORDER BY title');
  const matches = rows.filter(s => {
    const normTitle = normalize(s.title);
    if(normTitle === normInput) return true;
    if(normInput.length >= 4 && normTitle.includes(normInput)) return true;
    if(normTitle.length >= 4 && normInput.includes(normTitle)) return true;
    const wordsA = normInput.split(' ').filter(w=>w.length>2);
    const wordsB = normTitle.split(' ').filter(w=>w.length>2);
    if(!wordsA.length || !wordsB.length) return false;
    const m = wordsA.filter(w=>wordsB.includes(w)).length;
    return m / Math.max(wordsA.length, wordsB.length) >= 0.6;
  });
  res.json(matches.slice(0, 5));
});

app.get('/api/songs/duplicates', async (req, res) => {
  const { rows } = await pool.query('SELECT id, title FROM songs ORDER BY title');
  const { rows: ignored } = await pool.query('SELECT song_id1, song_id2 FROM ignored_duplicates');
  const ignoredSet = new Set(ignored.map(r => `${Math.min(r.song_id1,r.song_id2)}_${Math.max(r.song_id1,r.song_id2)}`));
  const pairs = [];
  for(let i=0; i<rows.length; i++){
    for(let j=i+1; j<rows.length; j++){
      const key = `${Math.min(rows[i].id,rows[j].id)}_${Math.max(rows[i].id,rows[j].id)}`;
      if(ignoredSet.has(key)) continue;
      const a = normalize(rows[i].title), b = normalize(rows[j].title);
      const wordsA = a.split(' ').filter(w=>w.length>2);
      const wordsB = b.split(' ').filter(w=>w.length>2);
      if(!wordsA.length || !wordsB.length) continue;
      const shared = wordsA.filter(w=>wordsB.includes(w)).length;
      const similarity = Math.round(shared / Math.max(wordsA.length, wordsB.length) * 100);
      if(similarity >= 60) pairs.push({ id1:rows[i].id, title1:rows[i].title, id2:rows[j].id, title2:rows[j].title, similarity });
    }
  }
  pairs.sort((a,b)=>b.similarity-a.similarity);
  res.json(pairs.slice(0, 20));
});

app.post('/api/songs/ignore-duplicate', async (req, res) => {
  const { id1, id2 } = req.body;
  const a = Math.min(id1, id2), b = Math.max(id1, id2);
  await pool.query('INSERT INTO ignored_duplicates(song_id1, song_id2) VALUES($1,$2) ON CONFLICT DO NOTHING', [a, b]);
  res.json({ ok: true });
});

// -- PENDING CHANGES -----------------------------------------------------------
app.get('/api/pending-changes', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pending_changes ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/pending-changes', async (req, res) => {
  const { song_id, song_title, contributor_id, contributor_name, field_name, old_value, new_value, affected_fields } = req.body;
  if (!song_id || !field_name) return res.status(400).json({ error: 'Donnees manquantes' });
  if (affected_fields && affected_fields.length) {
    const { rows: conflicts } = await pool.query(
      `SELECT field_name FROM pending_changes WHERE song_id=$1 AND status='pending' AND affected_fields && $2::text[]`,
      [song_id, affected_fields]
    );
    if (conflicts.length) {
      const conflicting = conflicts.map(r=>r.field_name).join(', ');
      return res.status(409).json({ error: `Modification en attente sur: ${conflicting}. Attendre la validation admin.`, conflicts: conflicts.map(r=>r.field_name) });
    }
  }
  const { rows } = await pool.query(
    'INSERT INTO pending_changes(song_id, song_title, contributor_id, contributor_name, field_name, old_value, new_value, affected_fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [song_id, song_title||null, contributor_id||null, contributor_name||null, field_name, old_value||null, new_value||null, affected_fields||null]
  );
  res.json(rows[0]);
});

app.patch('/api/pending-changes/:id/review', async (req, res) => {
  const { action, pin_admin } = req.body;
  const { rows: adminRow } = await pool.query('SELECT value FROM settings WHERE key = $1', ['pin_admin']);
  if (adminRow[0]?.value !== String(pin_admin)) return res.status(401).json({ error: 'PIN admin incorrect' });
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Action invalide' });
  const { rows: change } = await pool.query('SELECT * FROM pending_changes WHERE id=$1', [req.params.id]);
  if (!change[0]) return res.status(404).json({ error: 'Modification introuvable' });
  const c = change[0];
  async function applySnapshot(songId, snapshotStr) {
    const s = JSON.parse(snapshotStr || '{}');
    await pool.query('UPDATE songs SET title=$1, author=$2, genre=$3, bpm=$4, key_signature=$5, reference_link=$6, updated_at=NOW() WHERE id=$7',
      [s.title||null, s.author||null, s.genre||null, s.bpm||null, s.key_signature||null, s.reference_link||null, songId]);
    if (Array.isArray(s.lyrics)) {
      await pool.query('DELETE FROM lyrics_blocks WHERE song_id=$1', [songId]);
      for (const [i, b] of s.lyrics.entries()) {
        await pool.query('INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)',
          [songId, b.type, b.num||1, b.content||'', i]);
      }
    }
  }
  if (action === 'reject') await applySnapshot(c.song_id, c.old_value);
  await pool.query('UPDATE pending_changes SET status=$1, reviewed_at=NOW() WHERE id=$2', [action === 'approve' ? 'approved' : 'rejected', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/pending-changes/:id', async (req, res) => {
  await pool.query('DELETE FROM pending_changes WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// -- SETLIST -------------------------------------------------------------------
app.get('/api/setlist', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM setlist ORDER BY position');
  res.json(rows);
});

app.put('/api/setlist', async (req, res) => {
  const { pin_admin, items } = req.body;
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', ['pin_admin']);
  if (rows[0]?.value !== String(pin_admin)) return res.status(401).json({ error: 'PIN admin incorrect' });
  await pool.query('DELETE FROM setlist');
  if (items && items.length) {
    for (const [i, item] of items.entries()) {
      await pool.query('INSERT INTO setlist(section, song_id, song_title, position, special_label, special_after) VALUES($1,$2,$3,$4,$5,$6)',
        [item.section, item.song_id||null, item.song_title||null, i, item.special_label||null, item.special_after||'principale']);
    }
  }
  res.json({ ok: true });
});

// -- SONGS ---------------------------------------------------------------------
async function getSongFull(id) {
  const { rows: songs } = await pool.query('SELECT * FROM songs WHERE id=$1', [id]);
  if (!songs[0]) return null;
  const song = songs[0];
  const { rows: cats }   = await pool.query('SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1', [id]);
  const { rows: lyrics } = await pool.query('SELECT * FROM lyrics_blocks WHERE song_id=$1 ORDER BY position,id', [id]);
  const { rows: audio }  = await pool.query('SELECT * FROM audio_files WHERE song_id=$1 ORDER BY stem_type,stem_category,uploaded_at', [id]);
  return { ...song, categories: cats, lyrics, audio_files: audio };
}

app.get('/api/songs', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM songs ORDER BY title');
  const songs = await Promise.all(rows.map(async s => {
    const { rows: cats } = await pool.query('SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1', [s.id]);
    const { rows: cnt }  = await pool.query('SELECT COUNT(*) as n FROM audio_files WHERE song_id=$1', [s.id]);
    return { ...s, categories: cats, audio_count: parseInt(cnt[0].n) };
  }));
  res.json(songs);
});

app.get('/api/songs/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT s.id, s.title, s.author, s.bpm, s.key_signature, s.pinned, s.created_at, s.updated_at
       FROM songs s LEFT JOIN lyrics_blocks lb ON lb.song_id = s.id
       WHERE s.title ILIKE $1 OR s.author ILIKE $1 OR lb.content ILIKE $1
       ORDER BY s.title LIMIT 30`,
      [`%${q}%`]
    );
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const { rows: cats } = await pool.query(
        `SELECT sc.song_id, c.id, c.name, c.color FROM song_categories sc JOIN categories c ON c.id=sc.category_id WHERE sc.song_id = ANY($1)`,
        [ids]
      );
      rows.forEach(s => { s.categories = cats.filter(c => c.song_id === s.id); s.match_in_lyrics = true; });
    }
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/songs/:id', async (req, res) => {
  const song = await getSongFull(req.params.id);
  song ? res.json(song) : res.status(404).json({ error: 'Introuvable' });
});

app.post('/api/songs', async (req, res) => {
  const { title, author, key_signature, genre, reference_link, notes, bpm, category_ids, lyrics } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  const { rows } = await pool.query(
    'INSERT INTO songs(title,author,key_signature,genre,reference_link,notes,bpm) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [title, author||null, key_signature||null, genre||null, reference_link||null, notes||null, bpm||null]
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
  const { title, author, key_signature, genre, reference_link, notes, bpm, category_ids, lyrics } = req.body;
  await pool.query('UPDATE songs SET title=$1,author=$2,key_signature=$3,genre=$4,reference_link=$5,notes=$6,bpm=$7,updated_at=NOW() WHERE id=$8',
    [title, author||null, key_signature||null, genre||null, reference_link||null, notes||null, bpm||null, id]);
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
  // Supprimer fichiers audio de Supabase Storage
  const { rows } = await pool.query('SELECT filename FROM audio_files WHERE song_id=$1', [req.params.id]);
  for (const f of rows) {
    await deleteFromSupabase(BUCKET_MV, f.filename).catch(() => {});
  }
  await pool.query('DELETE FROM songs WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// -- AUDIO (Supabase Storage) --------------------------------------------------
app.post('/api/songs/:id/audio', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  const { stem_type, stem_category, stem_label } = req.body;
  try {
    const filename = `${Date.now()}-${Math.round(Math.random()*1e6)}${path.extname(req.file.originalname)}`;
    const fileUrl = await uploadToSupabase(BUCKET_MV, filename, req.file.buffer, req.file.mimetype);
    const { rows } = await pool.query(
      'INSERT INTO audio_files(song_id,filename,original_name,stem_type,stem_category,stem_label,file_size,file_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.params.id, filename, req.file.originalname, stem_type, stem_category, stem_label, req.file.size, fileUrl]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/audio/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM audio_files WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Introuvable' });
  await deleteFromSupabase(BUCKET_MV, rows[0].filename).catch(() => {});
  await pool.query('DELETE FROM audio_files WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// -- ACTIVITY LOGS -------------------------------------------------------------
app.post('/api/logs', async (req, res) => {
  const { action, song_title, contributor_name, browser, os, language } = req.body;
  await pool.query('INSERT INTO activity_logs(action, song_title, contributor_name, browser, os, language) VALUES($1,$2,$3,$4,$5,$6)',
    [action, song_title||null, contributor_name||null, browser||null, os||null, language||null]);
  res.json({ ok: true });
});

app.get('/api/logs', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM activity_logs ORDER BY occurred_at DESC LIMIT 100');
  res.json(rows);
});

app.delete('/api/logs', async (req, res) => {
  await pool.query('DELETE FROM activity_logs');
  res.json({ ok: true });
});

// == MIVE API ==================================================================

// -- Loops Mive (bibliotheque independante) ------------------------------------
app.get('/api/mive/loops', async (req, res) => {
  try {
    // Loops Mive natives
    const { rows: miveLoops } = await pool.query(
      "SELECT *, 'mive' as _src FROM mive_loops ORDER BY uploaded_at DESC"
    );

    // Loops issues de M&V (audio_files avec stem_type = 'loop')
    const { rows: mvLoops } = await pool.query(`
      SELECT
        af.id,
        af.song_id,
        s.title            AS title,
        s.bpm              AS bpm,
        s.key_signature    AS key_signature,
        af.stem_label      AS time_signature,
        s.categories_json  AS genre,
        af.file_url,
        af.filename,
        af.file_size,
        af.uploaded_at,
        s.title            AS song_title,
        s.bpm              AS song_bpm,
        'mv'::text         AS _src,
        'mv'::text         AS source
      FROM audio_files af
      JOIN songs s ON s.id = af.song_id
      WHERE af.stem_type = 'loop'
      ORDER BY s.title, af.uploaded_at
    `);

    // Fusionner : Mive d'abord, M&V ensuite
    res.json([...miveLoops, ...mvLoops]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mive/loops', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });
  const { title, bpm, genre, time_signature, key_signature } = req.body;
  if (!title) return res.status(400).json({ error: 'Titre requis' });
  try {
    const filename = `mive-${Date.now()}-${Math.round(Math.random()*1e6)}${path.extname(req.file.originalname)}`;
    const fileUrl = await uploadToSupabase(BUCKET_MIVE, filename, req.file.buffer, req.file.mimetype);
    const { rows } = await pool.query(
      'INSERT INTO mive_loops(title, bpm, genre, time_signature, key_signature, filename, file_url, file_size, source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [title.trim(), bpm||null, genre||null, time_signature||null, key_signature||null, filename, fileUrl, req.file.size, 'mive']
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mive/loops/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM mive_loops WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Introuvable' });
  if (rows[0].source === 'mive') {
    await deleteFromSupabase(BUCKET_MIVE, rows[0].filename).catch(() => {});
  }
  await pool.query('DELETE FROM mive_loops WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// -- Setlists Mive -------------------------------------------------------------
app.get('/api/mive/setlists', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM mive_setlists ORDER BY updated_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mive/setlists', async (req, res) => {
  const { name, source, mv_setlist_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO mive_setlists(name, source, mv_setlist_id) VALUES($1,$2,$3) RETURNING *',
      [name.trim(), source||'mive', mv_setlist_id||null]
    );
    // Si import depuis M&V, copier les items de la setlist M&V
    if (source === 'mv') {
      const { rows: mvItems } = await pool.query(`
        SELECT sl.*, s.bpm, s.key_signature
        FROM setlist sl
        LEFT JOIN songs s ON s.id = sl.song_id
        ORDER BY sl.position
      `);
      for (const [i, item] of mvItems.entries()) {
        await pool.query(
          'INSERT INTO mive_setlist_items(setlist_id, song_id, song_title, bpm, key_signature, position) VALUES($1,$2,$3,$4,$5,$6)',
          [rows[0].id, item.song_id||null, item.song_title||null, item.bpm||null, item.key_signature||null, i]
        );
      }
    }
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mive/setlists/:id', async (req, res) => {
  await pool.query('DELETE FROM mive_setlists WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// -- Items d'une setlist Mive --------------------------------------------------
app.get('/api/mive/setlists/:id/items', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        msi.*,
        lr.title as loop_rythmique_title, lr.bpm as loop_rythmique_bpm,
        lr.file_url as loop_rythmique_url, lr.genre as loop_rythmique_genre,
        lh.title as loop_harmonique_title, lh.file_url as loop_harmonique_url,
        lh.genre as loop_harmonique_genre
      FROM mive_setlist_items msi
      LEFT JOIN mive_loops lr ON lr.id = msi.loop_rythmique_id
      LEFT JOIN mive_loops lh ON lh.id = msi.loop_harmonique_id
      WHERE msi.setlist_id = $1
      ORDER BY msi.position
    `, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/mive/setlists/:id/items', async (req, res) => {
  const { items } = req.body;
  try {
    await pool.query('DELETE FROM mive_setlist_items WHERE setlist_id=$1', [req.params.id]);
    if (items && items.length) {
      for (const [i, item] of items.entries()) {
        await pool.query(
          'INSERT INTO mive_setlist_items(setlist_id, song_id, song_title, bpm, key_signature, position, loop_rythmique_id, loop_harmonique_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [req.params.id, item.song_id||null, item.song_title||null, item.bpm||null, item.key_signature||null, i, item.loop_rythmique_id||null, item.loop_harmonique_id||null]
        );
      }
    }
    await pool.query('UPDATE mive_setlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Trim points pour une loop Mive
app.patch('/api/mive/loops/:id/trim', async (req, res) => {
  try {
    const { trim_start, trim_end } = req.body;
    await pool.query(
      'UPDATE mive_loops SET trim_start=$1, trim_end=$2 WHERE id=$3',
      [trim_start||0, trim_end||null, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ajouter un item à une setlist existante
app.post('/api/mive/setlists/:id/items', async (req, res) => {
  try {
    const { song_title, bpm, key_signature, loop_rythmique_id, loop_harmonique_id, loop_rythmique_url, loop_rythmique_title, loop_rythmique_bpm } = req.body;
    // Position = dernier + 1
    const { rows: posRows } = await pool.query(
      'SELECT COALESCE(MAX(position),0)+1 AS next_pos FROM mive_setlist_items WHERE setlist_id=$1',
      [req.params.id]
    );
    const position = posRows[0].next_pos;
    const { rows } = await pool.query(
      `INSERT INTO mive_setlist_items
        (setlist_id, song_title, bpm, key_signature, position, loop_rythmique_id, loop_harmonique_id)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, song_title||null, bpm||null, key_signature||null, position, loop_rythmique_id||null, loop_harmonique_id||null]
    );
    await pool.query('UPDATE mive_setlists SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/mive/setlists/:setlistId/items/:itemId', async (req, res) => {
  const { song_id, song_title, bpm, key_signature, loop_rythmique_id, loop_harmonique_id } = req.body;
  const fields = [], vals = [];
  if (song_id !== undefined)           { fields.push(`song_id=$${fields.length+1}`);           vals.push(song_id); }
  if (song_title !== undefined)        { fields.push(`song_title=$${fields.length+1}`);        vals.push(song_title); }
  if (bpm !== undefined)               { fields.push(`bpm=$${fields.length+1}`);               vals.push(bpm); }
  if (key_signature !== undefined)     { fields.push(`key_signature=$${fields.length+1}`);     vals.push(key_signature); }
  if (loop_rythmique_id !== undefined) { fields.push(`loop_rythmique_id=$${fields.length+1}`); vals.push(loop_rythmique_id); }
  if (loop_harmonique_id !== undefined){ fields.push(`loop_harmonique_id=$${fields.length+1}`);vals.push(loop_harmonique_id); }
  if (!fields.length) return res.status(400).json({ error: 'Rien a modifier' });
  vals.push(req.params.itemId);
  await pool.query(`UPDATE mive_setlist_items SET ${fields.join(',')} WHERE id=$${vals.length}`, vals);
  await pool.query('UPDATE mive_setlists SET updated_at=NOW() WHERE id=$1', [req.params.setlistId]);
  res.json({ ok: true });
});

// -- Route principale Mive -----------------------------------------------------
app.get('/mive', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'mive.html'));
});

// -- Catch-all M&V (apres /mive pour ne pas l'intercepter) --------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'public', 'index.html'));
});

// -- START ---------------------------------------------------------------------
async function startServer(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await initDB();
      await initBuckets();
      app.listen(PORT, () => console.log(` Serveur demarre sur le port ${PORT}`));
      return;
    } catch(err) {
      console.error(` Tentative ${i+1}/${retries} - Erreur DB: ${err.message}`);
      if (i < retries - 1) {
        const wait = (i + 1) * 3000;
        console.log(` Nouvelle tentative dans ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  console.error(' Demarrage sans base de donnees - verifiez DATABASE_URL');
  app.listen(PORT, () => console.log(` Serveur demarre SANS DB sur le port ${PORT}`));
}

startServer();
