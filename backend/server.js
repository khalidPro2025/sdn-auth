const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

const PORT = process.env.PORT || 4000;
const ODL_BASE = process.env.ODL_BASE || 'http://sdn.ktech.sn:8181';
const OPA_URL = process.env.OPA_URL || 'http://policy-service:8181/v1/data/sdn/authz';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const ODL_BASIC_USER = process.env.ODL_BASIC_USER || 'khalid';
const ODL_BASIC_PASS = process.env.ODL_BASIC_PASS || 'Ka123456';
const OF_NODE_IDS = (process.env.OF_NODE_IDS || 'openflow:1,openflow:2')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.set('trust proxy', true);

/* ================= Middlewares généraux ================ */
app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://micro-services.ktech.sn',
    'https://micro-services.ktech.sn'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'X-User', 'X-Email', 'X-Groups']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Contexte de requête
app.use((req, _res, next) => {
  req.reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.reqStart = Date.now();
  next();
});

/* ==================== Helpers ==================== */
function groupsFromHeaders(req) {
  return String(req.headers['x-groups'] || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .map(s => s.replace(/^\/+/, ''))
    .filter(Boolean);
}
function buildPolicyInput(req) {
  return {
    method: req.method,
    path: req.originalUrl || req.path,
    user: req.headers['x-user'] || '',
    email: req.headers['x-email'] || '',
    groups: groupsFromHeaders(req),
    authenticated: Boolean(req.headers.authorization),
    secure: req.secure === true
  };
}
async function checkPolicy(input) {
  try {
    const r = await fetch(OPA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 3000,
      body: JSON.stringify({ input })
    });
    if (!r.ok) return false;
    const data = await r.json();
    return Boolean(data && data.result && data.result.allow === true);
  } catch {
    return false;
  }
}

/* ========== Auth obligatoire + OPA avant API/Proxy ========== */
function requireBearer(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Authentication required (Bearer token)', ts: new Date().toISOString(), reqId: req.reqId });
  }
  next();
}
function guardAnyGroup(...wanted) {
  const wantedLC = wanted.map(s => s.toLowerCase());
  return (req, res, next) => {
    const have = groupsFromHeaders(req);
    const ok = wantedLC.some(g => have.includes(g));
    if (!ok) {
      return res.status(403).json({ error: 'forbidden', need_any_of: wanted, have, ts: new Date().toISOString(), reqId: req.reqId });
    }
    next();
  };
}
async function enforcePolicy(req, res, next) {
  const allowed = await checkPolicy(buildPolicyInput(req));
  if (!allowed) return res.status(403).json({ error: 'forbidden_by_policy', by: 'opa', ts: new Date().toISOString(), reqId: req.reqId });
  next();
}

/* ==================== Health ==================== */
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    authenticated: (req.headers.authorization || '').startsWith('Bearer '),
    secure: req.secure === true,
    protocol: req.protocol,
    user: req.headers['x-user'] || 'Anonymous',
    email: req.headers['x-email'] || 'unknown@example.com',
    groups: groupsFromHeaders(req),
    timestamp: new Date().toISOString(),
    service: 'sdn-backend'
  });
});
app.get('/ready', (_req, res) => res.type('text/plain').send('ready'));
app.get('/api/health', (req, res) => res.redirect(307, '/health'));

/* ============ Proxy vers ODL (RESTCONF) ============ */
function shouldPreferYangJson(pathname) {
  return /\/restconf\//i.test(pathname);
}

app.use(['/proxy', '/api/proxy'], requireBearer, enforcePolicy, async (req, res) => {
  const t0 = Date.now();
  try {
    const withoutApi = req.originalUrl.replace(/^\/api\/proxy/, '/proxy');
    const restPath   = withoutApi.replace(/^\/proxy/, '');
    let targetUrl    = ODL_BASE + restPath;

    try {
      const u = new URL(targetUrl, 'http://dummy');
      if (shouldPreferYangJson(u.pathname) && !u.search && !u.pathname.endsWith('/')) {
        targetUrl += '/';
      }
    } catch {}

    const headers = {
      'Accept': shouldPreferYangJson(targetUrl)
        ? 'application/yang-data+json, application/json;q=0.9, */*;q=0.1'
        : (req.headers['accept'] || 'application/json'),
      'Content-Type': req.headers['content-type'] || 'application/json',
      // passthrough Bearer pour lecture RESTCONF si ODL l’accepte
      'Authorization': req.headers.authorization
    };

    const options = { method: req.method, headers, timeout: REQUEST_TIMEOUT_MS };
    if (!['GET', 'HEAD'].includes(req.method)) {
      options.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, options);
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json') || contentType.includes('yang-data+json');

    if (!response.ok) {
      const errBody = isJson ? await response.json().catch(() => ({})) : await response.text();
      res.status(response.status).json({ error: 'upstream_error', upstream: 'opendaylight', status: response.status, statusText: response.statusText, contentType, url: targetUrl, body: errBody });
      console.warn(`[PROXY ${req.reqId}] ${req.method} ${targetUrl} -> ${response.status} in ${Date.now() - t0}ms`);
      return;
    }

    res.status(response.status);
    if (contentType) res.set('Content-Type', contentType);
    const data = isJson ? await response.json() : await response.text();
    res.send(data);
  } catch (error) {
    res.status(502).json({ error: 'bad_gateway', message: error.message, ts: new Date().toISOString(), reqId: req.reqId });
  }
});

/* ============== Endpoints admin: (dé)verrouiller l’overlay ============== */
// Appel RESTCONF admin (toujours en BASIC technique)
function odlFetchAdmin(path, method, bodyObj) {
  const url = `${ODL_BASE}${path}`;
  const auth = 'Basic ' + Buffer.from(`${ODL_BASIC_USER}:${ODL_BASIC_PASS}`).toString('base64');
  const headers = { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const opts = { method, headers, timeout: REQUEST_TIMEOUT_MS };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  return fetch(url, opts);
}

// payloads flows
const flowDropIPv4 = (id=10) => ({
  flow: [{
    id: String(id), table_id: 0, priority: 10,
    match: { "ethernet-match": { "ethernet-type": { "type": 2048 } } },
    instructions: { instruction: [] } // no actions = DROP
  }]
});
const flowAllowARP = (id=50) => ({
  flow: [{
    id: String(id), table_id: 0, priority: 300,
    match: { "ethernet-match": { "ethernet-type": { "type": 2054 } } },
    instructions: { instruction: [{ order:0, "apply-actions":{ action:[{ order:0, "output-action":{ "output-node-connector":"NORMAL" } }]}}]}
  }]
});
const flowAllowICMP = (id=60) => ({
  flow: [{
    id: String(id), table_id: 0, priority: 250,
    match: { "ethernet-match": { "ethernet-type": { "type": 2048 } }, "ip-match": { "ip-protocol": 1 } },
    instructions: { instruction: [{ order:0, "apply-actions":{ action:[{ order:0, "output-action":{ "output-node-connector":"NORMAL" } }]}}]}
  }]
});
const flowAllowTCP = (dport, id) => ({
  flow: [{
    id: String(id), table_id: 0, priority: 200,
    match: { "ethernet-match": { "ethernet-type": { "type": 2048 } }, "ip-match": { "ip-protocol": 6 }, "tcp-destination-port": dport },
    instructions: { instruction: [{ order:0, "apply-actions":{ action:[{ order:0, "output-action":{ "output-node-connector":"NORMAL" } }]}}]}
  }]
});

// push/uninstall flows on one node
async function installAllowSet(nodeId) {
  // allow ARP + ICMP + TCP/22 + TCP/443, and drop default IPv4
  const calls = [
    ['PUT', `/restconf/config/opendaylight-inventory:nodes/node/${encodeURIComponent(nodeId)}/table/0/flow/50`, flowAllowARP(50)],
    ['PUT', `/restconf/config/opendaylight-inventory:nodes/node/${encodeURIComponent(nodeId)}/table/0/flow/60`, flowAllowICMP(60)],
    ['PUT', `/restconf/config/opendaylight-inventory:nodes/node/${encodeURIComponent(nodeId)}/table/0/flow/110`, flowAllowTCP(22, 110)],
    ['PUT', `/restconf/config/opendaylight-inventory:nodes/node/${encodeURIComponent(nodeId)}/table/0/flow/120`, flowAllowTCP(443, 120)],
    ['PUT', `/restconf/config/opendaylight-inventory:nodes/node/${encodeURIComponent(nodeId)}/table/0/flow/10`, flowDropIPv4(10)],
  ];
  for (const [m, p, b] of calls) {
    const r = await odlFetchAdmin(p, m, b);
    if (!r.ok) throw new Error(`ODL ${nodeId} ${p} -> ${r.status}`);
  }
}
async function clearAllFlows(nodeId) {
  // supprime la table 0 (simple et propre)
  const r = await odlFetchAdmin(`/restconf/config/opendaylight-inventory:nodes/node/${encodeURIComponent(nodeId)}/table/0/`, 'DELETE');
  if (!r.ok && r.status !== 404) throw new Error(`ODL clear table0 ${nodeId} -> ${r.status}`);
}

// admin endpoints (protégé Bearer + groupe admins)
app.post('/api/admin/overlay/allow', requireBearer, guardAnyGroup('admins'), async (req, res) => {
  try {
    for (const n of OF_NODE_IDS) await installAllowSet(n);
    res.json({ ok: true, nodes: OF_NODEIDS, applied: ['ARP','ICMP','TCP/22','TCP/443','drop-default'] });
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e) });
  }
});
app.post('/api/admin/overlay/lock', requireBearer, guardAnyGroup('admins'), async (req, res) => {
  try {
    for (const n of OF_NODE_IDS) await clearAllFlows(n);
    res.json({ ok: true, nodes: OF_NODE_IDS, cleared: true });
  } catch (e) {
    res.status(502).json({ ok:false, error: String(e) });
  }
});

/* ================= Handlers d’erreurs & boot ================= */
app.use((error, req, res, _next) => {
  res.status(500).json({ error: 'internal_error', message: 'Internal server error', timestamp: new Date().toISOString(), reqId: req.reqId });
});
app.use('*', (req, res) => {
  res.status(404).json({ error: 'not_found', message: `Route ${req.originalUrl} not found`, timestamp: new Date().toISOString(), reqId: req.reqId });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(` Backend http://0.0.0.0:${PORT}`);
  console.log(` ODL: ${ODL_BASE} | admin BASIC user=${ODL_BASIC_USER}`);
  console.log(` OPA endpoint: ${OPA_URL}`);
});
