import express from 'express';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const CF_TOKEN   = process.env.CF_TOKEN;
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const PORT       = process.env.PORT || 3000;
const CNAME_TARGET = 'de.web.serververs.com';

// ── Allowed domains ───────────────────────────────────────────────────────────
// Add more entries here to support new domains in the future
const ALLOWED_DOMAINS = {
  'srvx.dev':        process.env.CF_ZONE_ID,
  'serververs.com':  process.env.CF_ZONE_SERVERVERS || process.env.CF_ZONE_ID,
  'srv.cx':          process.env.CF_ZONE_SRVCX      || process.env.CF_ZONE_ID,
};

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('subdomains.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS subdomains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'srvx.dev',
    full_domain TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'web',
    cloudflare_record_id TEXT,
    owner_ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, domain)
  );
`);

// ── Rate limiting ─────────────────────────────────────────────────────────────
const checkLimiter = rateLimit({ windowMs: 60_000, max: 60 });
const claimLimiter = rateLimit({ windowMs: 60 * 60_000, max: 3 });

// ── Validation ────────────────────────────────────────────────────────────────
const RESERVED  = new Set(['admin','api','mail','ftp','root','server','www','ns','cdn','dev','app','docs','status','billing','login','logout','signup','register','account','support','home']);
const PROFANITY = new Set(['fuck','shit','ass','dick','cock','cunt','bitch','bastard','porn','sex']);

function validate(name) {
  if (!name || typeof name !== 'string') return 'Name is required';
  if (name.length < 3)  return 'Too short (min 3 characters)';
  if (name.length > 30) return 'Too long (max 30 characters)';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && name.length > 1)
    return 'Only lowercase letters, numbers, and hyphens. Must start/end with alphanumeric.';
  if (!/^[a-z0-9-]+$/.test(name)) return 'Invalid characters';
  if (name.includes('--')) return 'No consecutive hyphens';
  if (RESERVED.has(name)) return `"${name}" is a reserved name`;
  for (const w of PROFANITY) if (name.includes(w)) return 'Name not allowed';
  return null;
}

// ── Cloudflare helpers ────────────────────────────────────────────────────────
const dnsCache = {};

async function fetchCloudflareDNS(zoneId) {
  const cache = dnsCache[zoneId] || { records: new Set(), ts: 0 };
  if (Date.now() - cache.ts < 30_000) return cache.records;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?per_page=1000`,
    { headers: { Authorization: `Bearer ${CF_TOKEN}` } }
  );
  const data = await res.json();
  if (!data.success) throw new Error('Cloudflare fetch failed: ' + JSON.stringify(data.errors));

  const records = new Set(
    data.result.map(r => r.name.split('.')[0])
  );
  dnsCache[zoneId] = { records, ts: Date.now() };
  return records;
}

async function createCNAME(name, zoneId) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'CNAME', name, content: CNAME_TARGET, ttl: 1, proxied: true }),
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'DNS creation failed');
  return data.result.id;
}

async function createSRV(name, zoneId, { mcHost, mcPort, mcPriority, mcWeight }) {
  // SRV record: _minecraft._tcp.name.domain
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'SRV',
        name: `_minecraft._tcp.${name}`,
        data: {
          service:  '_minecraft',
          proto:    '_tcp',
          name:     name,
          priority: mcPriority || 0,
          weight:   mcWeight   || 5,
          port:     mcPort     || 25565,
          target:   mcHost,
        },
        ttl: 1,
      }),
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.errors?.[0]?.message || 'SRV creation failed');
  return data.result.id;
}

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── GET /api/check?name=project&type=web&domain=srvx.dev ─────────────────────
app.get('/api/check', checkLimiter, async (req, res) => {
  const name   = req.query.name?.toLowerCase().trim();
  const domain = req.query.domain || 'srvx.dev';
  const type   = req.query.type  || 'web';

  const error = validate(name);
  if (error) return res.json({ available: false, reason: error });

  if (!ALLOWED_DOMAINS[domain])
    return res.json({ available: false, reason: 'Domain not supported' });

  try {
    const existing = db.prepare('SELECT id FROM subdomains WHERE name = ? AND domain = ?').get(name, domain);
    if (existing) return res.json({ available: false, reason: 'Already taken' });

    const zoneId  = ALLOWED_DOMAINS[domain];
    const records = await fetchCloudflareDNS(zoneId);
    if (records.has(name)) return res.json({ available: false, reason: 'Already taken' });

    res.json({ available: true, reason: null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ available: false, reason: 'Check failed, try again' });
  }
});

// ── POST /api/claim ───────────────────────────────────────────────────────────
app.post('/api/claim', claimLimiter, async (req, res) => {
  const { name: rawName, type = 'web', domain = 'srvx.dev', mcHost, mcPort, mcPriority, mcWeight } = req.body;
  const name = rawName?.toLowerCase().trim();
  const ip   = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

  const error = validate(name);
  if (error) return res.status(400).json({ success: false, error });

  if (!ALLOWED_DOMAINS[domain])
    return res.status(400).json({ success: false, error: 'Domain not supported' });

  if (type === 'mc' && !mcHost)
    return res.status(400).json({ success: false, error: 'Target host is required for Minecraft SRV' });

  const existingIp = db.prepare('SELECT name, domain FROM subdomains WHERE owner_ip = ?').get(ip);
  if (existingIp)
    return res.status(429).json({ success: false, error: `This IP already claimed ${existingIp.name}.${existingIp.domain}` });

  try {
    const existing = db.prepare('SELECT id FROM subdomains WHERE name = ? AND domain = ?').get(name, domain);
    if (existing) return res.status(409).json({ success: false, error: 'Already taken' });

    const zoneId  = ALLOWED_DOMAINS[domain];
    const records = await fetchCloudflareDNS(zoneId);
    if (records.has(name)) return res.status(409).json({ success: false, error: 'Already taken' });

    let cfId;
    if (type === 'mc') {
      cfId = await createSRV(name, zoneId, { mcHost, mcPort, mcPriority, mcWeight });
    } else {
      cfId = await createCNAME(name, zoneId);
    }

    db.prepare('INSERT INTO subdomains (name, domain, full_domain, type, cloudflare_record_id, owner_ip) VALUES (?,?,?,?,?,?)')
      .run(name, domain, `${name}.${domain}`, type, cfId, ip);

    // Bust cache
    if (dnsCache[zoneId]) dnsCache[zoneId].ts = 0;

    const fullDomain = type === 'mc' ? `_minecraft._tcp.${name}.${domain}` : `${name}.${domain}`;
    res.json({
      success: true,
      domain:  fullDomain,
      url:     type === 'mc' ? fullDomain : `https://${name}.${domain}`,
      type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Claim failed: ' + err.message });
  }
});

// ── GET /api/recent ───────────────────────────────────────────────────────────
app.get('/api/recent', (req, res) => {
  const rows = db.prepare('SELECT name, domain, type, created_at FROM subdomains ORDER BY id DESC LIMIT 10').all();
  res.json(rows);
});

app.listen(PORT, () => console.log(`srvx server running on :${PORT}`));
