require(‘dotenv’).config();
const express = require(‘express’);
const multer = require(‘multer’);
const cors = require(‘cors’);
const path = require(‘path’);
const fs = require(‘fs’);
const { Pool } = require(‘pg’);

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, ‘..’, ‘data’, ‘uploads’);

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// – DATABASE ——————————————————————
const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

async function initDB() {
await pool.query(`CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL ); CREATE TABLE IF NOT EXISTS categories ( id SERIAL PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#2d5be3', position INTEGER DEFAULT 0 ); CREATE TABLE IF NOT EXISTS songs ( id SERIAL PRIMARY KEY, title TEXT NOT NULL, author TEXT, key_signature TEXT, genre TEXT, reference_link TEXT, notes TEXT, bpm INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS song_categories ( song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE, category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY (song_id, category_id) ); CREATE TABLE IF NOT EXISTS lyrics_blocks ( id SERIAL PRIMARY KEY, song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE, type TEXT NOT NULL, num INTEGER DEFAULT 1, content TEXT DEFAULT '', position INTEGER DEFAULT 0 ); CREATE TABLE IF NOT EXISTS audio_files ( id SERIAL PRIMARY KEY, song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE, filename TEXT NOT NULL, original_name TEXT NOT NULL, stem_type TEXT NOT NULL, stem_category TEXT NOT NULL, stem_label TEXT NOT NULL, file_size INTEGER DEFAULT 0, uploaded_at TIMESTAMPTZ DEFAULT NOW() ); ALTER TABLE songs ADD COLUMN IF NOT EXISTS bpm INTEGER; ALTER TABLE songs ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE; CREATE TABLE IF NOT EXISTS activity_logs ( id SERIAL PRIMARY KEY, action TEXT NOT NULL, song_title TEXT, contributor_name TEXT, browser TEXT, os TEXT, language TEXT, occurred_at TIMESTAMPTZ DEFAULT NOW() ); ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS contributor_name TEXT; CREATE TABLE IF NOT EXISTS contributors ( id SERIAL PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#8b1a2e', can_edit_lyrics BOOLEAN DEFAULT TRUE, can_edit_bpm BOOLEAN DEFAULT FALSE, can_edit_key BOOLEAN DEFAULT FALSE, can_create_song BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW() ); ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_lyrics BOOLEAN DEFAULT TRUE; ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_bpm BOOLEAN DEFAULT FALSE; ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_edit_key BOOLEAN DEFAULT FALSE; ALTER TABLE contributors ADD COLUMN IF NOT EXISTS can_create_song BOOLEAN DEFAULT FALSE; CREATE TABLE IF NOT EXISTS ignored_duplicates ( id SERIAL PRIMARY KEY, song_id1 INTEGER NOT NULL, song_id2 INTEGER NOT NULL, ignored_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(song_id1, song_id2) ); CREATE TABLE IF NOT EXISTS feedback ( id SERIAL PRIMARY KEY, song_id INTEGER REFERENCES songs(id) ON DELETE CASCADE, song_title TEXT, message TEXT NOT NULL, browser TEXT, os TEXT, read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW() ); CREATE TABLE IF NOT EXISTS pending_changes ( id SERIAL PRIMARY KEY, song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE, song_title TEXT, contributor_id INTEGER REFERENCES contributors(id) ON DELETE SET NULL, contributor_name TEXT, field_name TEXT NOT NULL, old_value TEXT, new_value TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(), reviewed_at TIMESTAMPTZ, reviewed_by TEXT ); CREATE TABLE IF NOT EXISTS setlist ( id SERIAL PRIMARY KEY, section TEXT NOT NULL, song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL, song_title TEXT, position INTEGER DEFAULT 0, special_label TEXT, special_after TEXT DEFAULT 'principale', updated_at TIMESTAMPTZ DEFAULT NOW() ); INSERT INTO settings (key, value) VALUES ('group_name', 'Repertoire Musical'), ('group_subtitle', 'Groupe de Musique'), ('pin_contributor', '1234'), ('pin_admin', '0000') ON CONFLICT (key) DO NOTHING;`);
console.log(’ Base de donnees initialisee’);
}

// – MIDDLEWARE ––––––––––––––––––––––––––––––––
app.use(cors());
app.use(express.json());
app.use(’/uploads’, express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, ‘..’, ‘frontend’, ‘public’)));

const storage = multer.diskStorage({
destination: (req, file, cb) => cb(null, UPLOADS_DIR),
filename: (req, file, cb) => cb(null, Date.now() + ‘-’ + Math.round(Math.random()*1e6) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 100*1024*1024 } });

// – PIN ———————————————————————–
app.post(’/api/verify-pin’, async (req, res) => {
const { pin, level } = req.body;
if (level === ‘admin’) {
const { rows } = await pool.query(‘SELECT value FROM settings WHERE key = $1’, [‘pin_admin’]);
return rows[0]?.value === String(pin) ? res.json({ ok: true, level: ‘admin’ }) : res.status(401).json({ ok: false });
}
// Check individual contributor PINs first
const { rows: contribs } = await pool.query(‘SELECT * FROM contributors WHERE pin = $1’, [String(pin)]);
if (contribs[0]) {
const c = contribs[0];
return res.json({ ok: true, level: ‘contributor’, contributor_id: c.id, contributor_name: c.name,
permissions: { can_edit_lyrics: c.can_edit_lyrics, can_edit_bpm: c.can_edit_bpm, can_edit_key: c.can_edit_key, can_create_song: c.can_create_song }
});
}
// Fallback: check legacy shared contributor PIN
const { rows } = await pool.query(‘SELECT value FROM settings WHERE key = $1’, [‘pin_contributor’]);
rows[0]?.value === String(pin)
? res.json({ ok: true, level: ‘contributor’, contributor_name: ‘Contributeur’ })
: res.status(401).json({ ok: false });
});

// – CONTRIBUTORS –––––––––––––––––––––––––––––––
app.get(’/api/contributors’, async (req, res) => {
const { rows } = await pool.query(‘SELECT id, name, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, created_at FROM contributors ORDER BY name’);
res.json(rows);
});

app.post(’/api/contributors’, async (req, res) => {
const { name, pin, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song } = req.body;
if (!name || !pin) return res.status(400).json({ error: ‘Nom et PIN requis’ });
if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: ‘PIN doit etre 4 chiffres’ });
const { rows: existing } = await pool.query(‘SELECT id FROM contributors WHERE pin = $1’, [String(pin)]);
if (existing.length) return res.status(400).json({ error: ‘Ce PIN est deja utilise’ });
const { rows } = await pool.query(
‘INSERT INTO contributors(name, pin, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song, created_at’,
[name.trim(), String(pin), color||’#8b1a2e’, can_edit_lyrics!==false, can_edit_bpm===true, can_edit_key===true, can_create_song===true]
);
res.json(rows[0]);
});

app.delete(’/api/contributors/:id’, async (req, res) => {
await pool.query(‘DELETE FROM contributors WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

app.patch(’/api/contributors/:id’, async (req, res) => {
const { name, pin, color, can_edit_lyrics, can_edit_bpm, can_edit_key, can_create_song } = req.body;
if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: ‘PIN doit etre 4 chiffres’ });
if (pin) {
const { rows: existing } = await pool.query(‘SELECT id FROM contributors WHERE pin = $1 AND id != $2’, [String(pin), req.params.id]);
if (existing.length) return res.status(400).json({ error: ‘Ce PIN est deja utilise’ });
}
const fields = [], vals = [];
if (name !== undefined)  { fields.push(`name=$${fields.length+1}`);  vals.push(name.trim()); }
if (pin !== undefined)   { fields.push(`pin=$${fields.length+1}`);   vals.push(String(pin)); }
if (color !== undefined) { fields.push(`color=$${fields.length+1}`); vals.push(color); }
if (can_edit_lyrics !== undefined) { fields.push(`can_edit_lyrics=$${fields.length+1}`); vals.push(can_edit_lyrics); }
if (can_edit_bpm !== undefined)    { fields.push(`can_edit_bpm=$${fields.length+1}`);    vals.push(can_edit_bpm); }
if (can_edit_key !== undefined)    { fields.push(`can_edit_key=$${fields.length+1}`);    vals.push(can_edit_key); }
if (can_create_song !== undefined) { fields.push(`can_create_song=$${fields.length+1}`); vals.push(can_create_song); }
if (!fields.length) return res.status(400).json({ error: ‘Rien a modifier’ });
vals.push(req.params.id);
const { rows } = await pool.query(`UPDATE contributors SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING id,name,color,can_edit_lyrics,can_edit_bpm,can_edit_key,can_create_song,created_at`, vals);
res.json(rows[0]);
});

// – SETTINGS ——————————————————————
app.get(’/api/settings’, async (req, res) => {
const { rows } = await pool.query(“SELECT key, value FROM settings WHERE key IN (‘group_name’,‘group_subtitle’)”);
const result = {}; rows.forEach(r => result[r.key] = r.value); res.json(result);
});

app.put(’/api/settings’, async (req, res) => {
const { pin_admin, group_name, group_subtitle, new_pin_contributor, new_pin_admin } = req.body;
const { rows } = await pool.query(‘SELECT value FROM settings WHERE key = $1’, [‘pin_admin’]);
if (rows[0]?.value !== String(pin_admin)) return res.status(401).json({ error: ‘PIN admin incorrect’ });
if (group_name !== undefined) await pool.query(‘INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2’, [‘group_name’, group_name]);
if (group_subtitle !== undefined) await pool.query(‘INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2’, [‘group_subtitle’, group_subtitle]);
if (new_pin_contributor) await pool.query(‘INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2’, [‘pin_contributor’, String(new_pin_contributor)]);
if (new_pin_admin) await pool.query(‘INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2’, [‘pin_admin’, String(new_pin_admin)]);
res.json({ ok: true });
});

// – CATEGORIES ––––––––––––––––––––––––––––––––
app.get(’/api/categories’, async (req, res) => {
const { rows } = await pool.query(‘SELECT * FROM categories ORDER BY position, id’);
res.json(rows);
});

app.post(’/api/categories’, async (req, res) => {
const { name, color } = req.body;
if (!name) return res.status(400).json({ error: ‘Nom requis’ });
const { rows } = await pool.query(‘INSERT INTO categories(name,color) VALUES($1,$2) RETURNING *’, [name.toUpperCase(), color||’#2d5be3’]);
res.json(rows[0]);
});

app.delete(’/api/categories/:id’, async (req, res) => {
await pool.query(‘DELETE FROM categories WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

app.patch(’/api/categories/:id’, async (req, res) => {
const { color } = req.body;
const { rows } = await pool.query(‘UPDATE categories SET color=$1 WHERE id=$2 RETURNING *’, [color, req.params.id]);
res.json(rows[0]);
});

// – SEARCH (full-text in lyrics) ———————————————
app.get(’/api/search’, async (req, res) => {
const q = (req.query.q||’’).trim();
if(!q) return res.json([]);
const pattern = `%${q}%`;
// Search in title, author, AND lyrics content
const { rows } = await pool.query(`SELECT DISTINCT s.*,  (SELECT string_agg(lb.content, ' ') FROM lyrics_blocks lb WHERE lb.song_id = s.id) as lyrics_preview FROM songs s LEFT JOIN lyrics_blocks lb ON lb.song_id = s.id WHERE  s.title ILIKE $1 OR  s.author ILIKE $1 OR  lb.content ILIKE $1 ORDER BY s.title LIMIT 50`, [pattern]);
const songs = await Promise.all(rows.map(async s => {
const { rows: cats } = await pool.query(‘SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1’, [s.id]);
const { rows: cnt } = await pool.query(‘SELECT COUNT(*) as n FROM audio_files WHERE song_id=$1’, [s.id]);
// Find matching lyric excerpt
const matchInLyrics = s.lyrics_preview && s.lyrics_preview.toLowerCase().includes(q.toLowerCase());
return { …s, categories: cats, audio_count: parseInt(cnt[0].n), match_in_lyrics: matchInLyrics };
}));
res.json(songs);
});

// – PIN SONG ——————————————————————
app.patch(’/api/songs/:id/pin’, async (req, res) => {
const { pinned } = req.body;
await pool.query(‘UPDATE songs SET pinned=$1 WHERE id=$2’, [pinned, req.params.id]);
res.json({ ok: true });
});

// – INCOMPLETE SONGS –––––––––––––––––––––––––––––
app.get(’/api/songs/incomplete’, async (req, res) => {
const { rows } = await pool.query(`SELECT s.*,  (s.bpm IS NULL) as missing_bpm, (s.key_signature IS NULL OR s.key_signature = '') as missing_key, (s.author IS NULL OR s.author = '') as missing_author, (s.genre IS NULL OR s.genre = '') as missing_genre, (NOT EXISTS (SELECT 1 FROM lyrics_blocks lb WHERE lb.song_id = s.id)) as missing_lyrics, (s.pinned = true) as is_pinned FROM songs s WHERE s.bpm IS NULL OR s.key_signature IS NULL OR s.key_signature = '' OR s.author IS NULL OR s.author = '' OR NOT EXISTS (SELECT 1 FROM lyrics_blocks lb WHERE lb.song_id = s.id) OR s.pinned = true ORDER BY s.pinned DESC, s.title`);
res.json(rows);
});

// – FEEDBACK ——————————————————————
app.post(’/api/feedback’, async (req, res) => {
const { song_id, song_title, message, browser, os } = req.body;
if(!message) return res.status(400).json({ error: ‘Message requis’ });
await pool.query(
‘INSERT INTO feedback(song_id,song_title,message,browser,os) VALUES($1,$2,$3,$4,$5)’,
[song_id||null, song_title||null, message, browser||null, os||null]
);
res.json({ ok: true });
});

app.get(’/api/feedback’, async (req, res) => {
const { rows } = await pool.query(‘SELECT * FROM feedback ORDER BY created_at DESC’);
res.json(rows);
});

app.patch(’/api/feedback/:id/read’, async (req, res) => {
await pool.query(‘UPDATE feedback SET read=true WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

app.delete(’/api/feedback/:id’, async (req, res) => {
await pool.query(‘DELETE FROM feedback WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

// – STATS (for pie chart) —————————————————–
app.get(’/api/stats’, async (req, res) => {
const { rows: catStats } = await pool.query(`SELECT c.name, c.color, COUNT(sc.song_id) as count FROM categories c LEFT JOIN song_categories sc ON sc.category_id = c.id GROUP BY c.id, c.name, c.color ORDER BY count DESC`);
const { rows: total } = await pool.query(‘SELECT COUNT(*) as n FROM songs’);
const { rows: nocat } = await pool.query(`SELECT COUNT(*) as n FROM songs s  WHERE NOT EXISTS (SELECT 1 FROM song_categories sc WHERE sc.song_id = s.id)`);
const { rows: pinned } = await pool.query(’SELECT COUNT(*) as n FROM songs WHERE pinned = true’);
const { rows: unread } = await pool.query(‘SELECT COUNT(*) as n FROM feedback WHERE read = false’);
res.json({
categories: catStats,
total_songs: parseInt(total[0].n),
no_category: parseInt(nocat[0].n),
pinned: parseInt(pinned[0].n),
unread_feedback: parseInt(unread[0].n)
});
});

// – DUPLICATE DETECTION —————————————————––
// Normalize: remove accents, punctuation, lowercase
function normalize(str){
return (str||’’).toLowerCase()
.normalize(‘NFD’).replace(/[\u0300-\u036f]/g,’’)
.replace(/[^a-z0-9\s]/g,’’).replace(/\s+/g,’ ’).trim();
}

app.get(’/api/songs/check-duplicate’, async (req, res) => {
const title = (req.query.title||’’).trim();
if(!title) return res.json([]);
const normInput = normalize(title);
const { rows } = await pool.query(‘SELECT id, title FROM songs ORDER BY title’);
// Find songs whose normalized title shares significant overlap
const matches = rows.filter(s => {
const normTitle = normalize(s.title);
if(normTitle === normInput) return true;
// Check if one contains the other (min 4 chars)
if(normInput.length >= 4 && normTitle.includes(normInput)) return true;
if(normTitle.length >= 4 && normInput.includes(normTitle)) return true;
// Word overlap: if 60%+ of words match
const wordsA = normInput.split(’ ‘).filter(w=>w.length>2);
const wordsB = normTitle.split(’ ’).filter(w=>w.length>2);
if(!wordsA.length || !wordsB.length) return false;
const matches = wordsA.filter(w=>wordsB.includes(w)).length;
return matches / Math.max(wordsA.length, wordsB.length) >= 0.6;
});
res.json(matches.slice(0, 5));
});

app.get(’/api/songs/duplicates’, async (req, res) => {
const { rows } = await pool.query(‘SELECT id, title FROM songs ORDER BY title’);
const { rows: ignored } = await pool.query(‘SELECT song_id1, song_id2 FROM ignored_duplicates’);
const ignoredSet = new Set(ignored.map(r => `${Math.min(r.song_id1,r.song_id2)}_${Math.max(r.song_id1,r.song_id2)}`));

const pairs = [];
for(let i=0; i<rows.length; i++){
for(let j=i+1; j<rows.length; j++){
const key = `${Math.min(rows[i].id,rows[j].id)}_${Math.max(rows[i].id,rows[j].id)}`;
if(ignoredSet.has(key)) continue;
const a = normalize(rows[i].title);
const b = normalize(rows[j].title);
const wordsA = a.split(’ ‘).filter(w=>w.length>2);
const wordsB = b.split(’ ’).filter(w=>w.length>2);
if(!wordsA.length || !wordsB.length) continue;
const shared = wordsA.filter(w=>wordsB.includes(w)).length;
const similarity = Math.round(shared / Math.max(wordsA.length, wordsB.length) * 100);
if(similarity >= 60){
pairs.push({ id1:rows[i].id, title1:rows[i].title, id2:rows[j].id, title2:rows[j].title, similarity });
}
}
}
pairs.sort((a,b)=>b.similarity-a.similarity);
res.json(pairs.slice(0, 20));
});

app.post(’/api/songs/ignore-duplicate’, async (req, res) => {
const { id1, id2 } = req.body;
const a = Math.min(id1, id2), b = Math.max(id1, id2);
await pool.query(
‘INSERT INTO ignored_duplicates(song_id1, song_id2) VALUES($1,$2) ON CONFLICT DO NOTHING’,
[a, b]
);
res.json({ ok: true });
});

// – SONGS ———————————————————————
// – PENDING CHANGES –
app.get(’/api/pending-changes’, async (req, res) => {
const { rows } = await pool.query(‘SELECT * FROM pending_changes ORDER BY created_at DESC’);
res.json(rows);
});

app.post(’/api/pending-changes’, async (req, res) => {
const { song_id, song_title, contributor_id, contributor_name, field_name, old_value, new_value } = req.body;
if (!song_id || !field_name) return res.status(400).json({ error: ‘Donnees manquantes’ });
const { rows } = await pool.query(
‘INSERT INTO pending_changes(song_id, song_title, contributor_id, contributor_name, field_name, old_value, new_value) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *’,
[song_id, song_title||null, contributor_id||null, contributor_name||null, field_name, old_value||null, new_value||null]
);
res.json(rows[0]);
});

app.patch(’/api/pending-changes/:id/review’, async (req, res) => {
const { action, pin_admin } = req.body;
const { rows: adminRow } = await pool.query(‘SELECT value FROM settings WHERE key = $1’, [‘pin_admin’]);
if (adminRow[0]?.value !== String(pin_admin)) return res.status(401).json({ error: ‘PIN admin incorrect’ });
if (![‘approve’, ‘reject’].includes(action)) return res.status(400).json({ error: ‘Action invalide’ });
const { rows: change } = await pool.query(‘SELECT * FROM pending_changes WHERE id=$1’, [req.params.id]);
if (!change[0]) return res.status(404).json({ error: ‘Modification introuvable’ });
const c = change[0];
if (action === ‘approve’) {
const fieldMap = { bpm: ‘bpm’, key_signature: ‘key_signature’, lyrics: null };
if (c.field_name === ‘lyrics’) {
const blocks = JSON.parse(c.new_value || ‘[]’);
await pool.query(‘DELETE FROM lyrics_blocks WHERE song_id=$1’, [c.song_id]);
for (const [i, b] of blocks.entries()) {
await pool.query(‘INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)’, [c.song_id, b.type, b.num||1, b.content||’’, i]);
}
} else if ([‘bpm’,‘key_signature’].includes(c.field_name)) {
await pool.query(`UPDATE songs SET ${c.field_name}=$1, updated_at=NOW() WHERE id=$2`, [c.new_value||null, c.song_id]);
}
} else {
if (c.field_name === ‘lyrics’) {
const blocks = JSON.parse(c.old_value || ‘[]’);
await pool.query(‘DELETE FROM lyrics_blocks WHERE song_id=$1’, [c.song_id]);
for (const [i, b] of blocks.entries()) {
await pool.query(‘INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)’, [c.song_id, b.type, b.num||1, b.content||’’, i]);
}
} else if ([‘bpm’,‘key_signature’].includes(c.field_name)) {
await pool.query(`UPDATE songs SET ${c.field_name}=$1, updated_at=NOW() WHERE id=$2`, [c.old_value||null, c.song_id]);
}
}
await pool.query(‘UPDATE pending_changes SET status=$1, reviewed_at=NOW() WHERE id=$2’, [action === ‘approve’ ? ‘approved’ : ‘rejected’, req.params.id]);
res.json({ ok: true });
});

app.delete(’/api/pending-changes/:id’, async (req, res) => {
await pool.query(‘DELETE FROM pending_changes WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

// – SETLIST –
app.get(’/api/setlist’, async (req, res) => {
const { rows } = await pool.query(‘SELECT * FROM setlist ORDER BY position’);
res.json(rows);
});

app.put(’/api/setlist’, async (req, res) => {
const { pin_admin, items } = req.body;
const { rows } = await pool.query(‘SELECT value FROM settings WHERE key = $1’, [‘pin_admin’]);
if (rows[0]?.value !== String(pin_admin)) return res.status(401).json({ error: ‘PIN admin incorrect’ });
await pool.query(‘DELETE FROM setlist’);
if (items && items.length) {
for (const [i, item] of items.entries()) {
await pool.query(
‘INSERT INTO setlist(section, song_id, song_title, position, special_label, special_after) VALUES($1,$2,$3,$4,$5,$6)’,
[item.section, item.song_id||null, item.song_title||null, i, item.special_label||null, item.special_after||‘principale’]
);
}
}
res.json({ ok: true });
});

async function getSongFull(id) {
const { rows: songs } = await pool.query(‘SELECT * FROM songs WHERE id=$1’, [id]);
if (!songs[0]) return null;
const song = songs[0];
const { rows: cats } = await pool.query(‘SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1’, [id]);
const { rows: lyrics } = await pool.query(‘SELECT * FROM lyrics_blocks WHERE song_id=$1 ORDER BY position,id’, [id]);
const { rows: audio } = await pool.query(‘SELECT * FROM audio_files WHERE song_id=$1 ORDER BY stem_type,stem_category,uploaded_at’, [id]);
return { …song, categories: cats, lyrics, audio_files: audio };
}

app.get(’/api/songs’, async (req, res) => {
const { rows } = await pool.query(‘SELECT * FROM songs ORDER BY title’);
const songs = await Promise.all(rows.map(async s => {
const { rows: cats } = await pool.query(‘SELECT c.* FROM categories c JOIN song_categories sc ON sc.category_id=c.id WHERE sc.song_id=$1’, [s.id]);
const { rows: cnt } = await pool.query(‘SELECT COUNT(*) as n FROM audio_files WHERE song_id=$1’, [s.id]);
return { …s, categories: cats, audio_count: parseInt(cnt[0].n) };
}));
res.json(songs);
});

app.get(’/api/songs/:id’, async (req, res) => {
const song = await getSongFull(req.params.id);
song ? res.json(song) : res.status(404).json({ error: ‘Introuvable’ });
});

app.post(’/api/songs’, async (req, res) => {
const { title, author, key_signature, genre, reference_link, notes, bpm, category_ids, lyrics } = req.body;
if (!title) return res.status(400).json({ error: ‘Titre requis’ });
const { rows } = await pool.query(
‘INSERT INTO songs(title,author,key_signature,genre,reference_link,notes,bpm) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *’,
[title, author||null, key_signature||null, genre||null, reference_link||null, notes||null, bpm||null]
);
const songId = rows[0].id;
if (category_ids?.length) {
for (const cid of category_ids) await pool.query(‘INSERT INTO song_categories(song_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING’, [songId, cid]);
}
if (lyrics?.length) {
for (const [i, b] of lyrics.entries()) await pool.query(‘INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)’, [songId, b.type, b.num||1, b.content||’’, i]);
}
res.json(await getSongFull(songId));
});

app.put(’/api/songs/:id’, async (req, res) => {
const id = req.params.id;
const { title, author, key_signature, genre, reference_link, notes, bpm, category_ids, lyrics } = req.body;
await pool.query(‘UPDATE songs SET title=$1,author=$2,key_signature=$3,genre=$4,reference_link=$5,notes=$6,bpm=$7,updated_at=NOW() WHERE id=$8’,
[title, author||null, key_signature||null, genre||null, reference_link||null, notes||null, bpm||null, id]);
await pool.query(‘DELETE FROM song_categories WHERE song_id=$1’, [id]);
if (category_ids?.length) {
for (const cid of category_ids) await pool.query(‘INSERT INTO song_categories(song_id,category_id) VALUES($1,$2) ON CONFLICT DO NOTHING’, [id, cid]);
}
await pool.query(‘DELETE FROM lyrics_blocks WHERE song_id=$1’, [id]);
if (lyrics?.length) {
for (const [i, b] of lyrics.entries()) await pool.query(‘INSERT INTO lyrics_blocks(song_id,type,num,content,position) VALUES($1,$2,$3,$4,$5)’, [id, b.type, b.num||1, b.content||’’, i]);
}
res.json(await getSongFull(id));
});

app.delete(’/api/songs/:id’, async (req, res) => {
const { rows } = await pool.query(‘SELECT filename FROM audio_files WHERE song_id=$1’, [req.params.id]);
rows.forEach(f => { const fp = path.join(UPLOADS_DIR, f.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
await pool.query(‘DELETE FROM songs WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

// – AUDIO ———————————————————————
app.post(’/api/songs/:id/audio’, upload.single(‘file’), async (req, res) => {
if (!req.file) return res.status(400).json({ error: ‘Fichier manquant’ });
const { stem_type, stem_category, stem_label } = req.body;
const { rows } = await pool.query(
‘INSERT INTO audio_files(song_id,filename,original_name,stem_type,stem_category,stem_label,file_size) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *’,
[req.params.id, req.file.filename, req.file.originalname, stem_type, stem_category, stem_label, req.file.size]
);
res.json(rows[0]);
});

app.delete(’/api/audio/:id’, async (req, res) => {
const { rows } = await pool.query(‘SELECT * FROM audio_files WHERE id=$1’, [req.params.id]);
if (!rows[0]) return res.status(404).json({ error: ‘Introuvable’ });
const fp = path.join(UPLOADS_DIR, rows[0].filename);
if (fs.existsSync(fp)) fs.unlinkSync(fp);
await pool.query(‘DELETE FROM audio_files WHERE id=$1’, [req.params.id]);
res.json({ ok: true });
});

// – ACTIVITY LOGS ———————————————————––
app.post(’/api/logs’, async (req, res) => {
const { action, song_title, contributor_name, browser, os, language } = req.body;
await pool.query(
‘INSERT INTO activity_logs(action, song_title, contributor_name, browser, os, language) VALUES($1,$2,$3,$4,$5,$6)’,
[action, song_title||null, contributor_name||null, browser||null, os||null, language||null]
);
res.json({ ok: true });
});

app.get(’/api/logs’, async (req, res) => {
const { rows } = await pool.query(
‘SELECT * FROM activity_logs ORDER BY occurred_at DESC LIMIT 100’
);
res.json(rows);
});

app.delete(’/api/logs’, async (req, res) => {
await pool.query(‘DELETE FROM activity_logs’);
res.json({ ok: true });
});

app.get(’*’, (req, res) => res.sendFile(path.join(__dirname, ‘..’, ‘frontend’, ‘public’, ‘index.html’)));

// – START ———————————————————————
async function startServer(retries = 5) {
for (let i = 0; i < retries; i++) {
try {
await initDB();
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
// Start anyway without DB (will fail on API calls but won’t crash the process)
console.error(’ Demarrage sans base de donnees - verifiez DATABASE_URL’);
app.listen(PORT, () => console.log(` Serveur demarre SANS DB sur le port ${PORT}`));
}

startServer();
