import express from 'express';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';

const app = express();
app.use(express.json());

const CF_TOKEN = process.env.CF_TOKEN;       // Cloudflare API token
const CF_ZONE_ID = process.env.CF_ZONE_ID;   // Zone ID for srvx.dev
const CNAME_TARGET = 'de.web.serververs.com';
const BASE_DOMAIN = 'srvx.dev';

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('subdomains.db');
db.exec(`CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  full_domain TEXT NOT NULL,
  cloudflare_record_id TEXT,
  owner_ip TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ── Rate limiting ─────────────────────────────────────────────────────────────
const checkLimiter = rateLimit({ windowMs: 60_000, max: 60 });
const claimLimiter = rateLimit({ windowMs: 60 * 60_000, max: 3 }); // 3 claims/IP/hr

// ── Validation ────────────────────────────────────────────────────────────────
const RESERVED = new Set(['admin','api','mail','ftp','root','server',
  'www','ns','cdn','dev','app','docs','status','billing','login']);
const PROFANITY = new Set(['fuck','shit','ass','dick','cock','cunt',
  'bitch','bastard','porn','sex']); // extend this list

function validate(name) {
  if (!name || typeof name !== 'string') return 'Name is required';
  if (name.length < 3) return 'Too short (min 3 characters)';
  if (name.length > 30) return 'Too long (max 30 characters)';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) return 'Only lowercase letters, numbers, and hyphens. Must start/end with alphanumeric.';
  if (name.includes('--')) return 'No consecutive hyphens';
  if (RESERVED.has(name)) return `"${name}" is a reserved name`;
  for (const w of PROFANITY) if (name.includes(w)) return 'Name not allowed';
  return null;
}

// ── Cloudflare helpers ────────────────────────────────────────────────────────
let dnsCache = { records: new Set(), ts: 0 };

async function fetchCloudflareDNS() {
  if (Date.now() - dnsCache.ts < 30_000) return dnsCache.records; // 30s cache

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=CNAME&per_page=1000`,
    { headers: { Authorization: `Bearer ${CF_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.success) throw new Error('Cloudflare fetch failed');

  const records = new Set(
    data.result
      .filter(r => r.name.endsWith(`.${BASE_DOMAIN}`))
      .map(r => r.name.replace(`.${BASE_DOMAIN}`, ''))
  );
  dnsCache = { records, ts: Date.now() };
  return records;
}

async function createCloudflareCNAME(name) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'CNAME',
        name: name,
        content: CNAME_TARGET,
        ttl: 1,        // Auto
        proxied: true, // Orange-cloud
      }),
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'DNS creation failed');
  return data.result.id;
}

// ── Routes ────────────────────────────────────────────────────────────────────
// GET /api/check?name=project
app.get('/api/check', checkLimiter, async (req, res) => {
  const name = req.query.name?.toLowerCase().trim();
  const error = validate(name);
  if (error) return res.json({ available: false, reason: error });

  try {
    // Check DB first
    const existing = db.prepare('SELECT id FROM subdomains WHERE name = ?').get(name);
    if (existing) return res.json({ available: false, reason: 'Already taken' });

    // Check live DNS
    const cfRecords = await fetchCloudflareDNS();
    if (cfRecords.has(name)) return res.json({ available: false, reason: 'Already taken' });

    res.json({ available: true, reason: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ available: false, reason: 'Check failed, try again' });
  }
});

// POST /api/claim  { "name": "project" }
app.post('/api/claim', claimLimiter, async (req, res) => {
  const name = req.body.name?.toLowerCase().trim();
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  const error = validate(name);
  if (error) return res.status(400).json({ success: false, error });

  // Check if this IP already has a record
  const existingIp = db.prepare('SELECT name FROM subdomains WHERE owner_ip = ?').get(ip);
  if (existingIp) {
    return res.status(429).json({
      success: false,
      error: `This IP already claimed ${existingIp.name}.${BASE_DOMAIN}`
    });
  }

  try {
    // Double-check availability
    const existing = db.prepare('SELECT id FROM subdomains WHERE name = ?').get(name);
    if (existing) return res.status(409).json({ success: false, error: 'Already taken' });

    const cfRecords = await fetchCloudflareDNS();
    if (cfRecords.has(name)) return res.status(409).json({ success: false, error: 'Already taken' });

    // Create DNS record
    const cfId = await createCloudflareCNAME(name);

    // Store in DB
    db.prepare(
      'INSERT INTO subdomains (name, full_domain, cloudflare_record_id, owner_ip) VALUES (?, ?, ?, ?)'
    ).run(name, `${name}.${BASE_DOMAIN}`, cfId, ip);

    // Bust DNS cache
    dnsCache.ts = 0;

    res.json({
      success: true,
      domain: `${name}.${BASE_DOMAIN}`,
      url: `https://${name}.${BASE_DOMAIN}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Claim failed, try again' });
  }
});

app.listen(3000, () => console.log('srvx.dev subdomain server on :3000'));