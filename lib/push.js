// ogma push — meet them where they live. The local markdown fleet under
// .ogma/out/ is ALWAYS canonical; push delivers a certified fleet to the
// destination the user chose, and records what it delivered in
// .ogma/push-state.json so every push is diffable and replayable.
//
// The rules that make this power safe to exist:
//   1. Consent is recorded by this tool, never adopted. `init` refuses a
//      repo-supplied destination; here, the ask-once flow runs exactly once —
//      no `--to` answer on record means push sniffs, asks, and delivers
//      NOTHING.
//   2. Only a certified fleet ships. No certificate, a failing certificate,
//      or a certificate at a different commit than HEAD each refuse with the
//      fix named. Nothing outward moves ahead of the gate.
//   3. An outward write is not done until it is read back. Page-backed
//      adapters verify every write by fetching it again (version advanced,
//      content present); push-state records only verified deliveries.
//   4. Secrets live in the environment, never in config, never in state,
//      never in output.
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./schema');
const { stripAnnotations } = require('./render');
const { readJson, nowIso, ogmaWrite, escapeXml, gitHead, sha256, trackedOgmaState, refuseTrackedOgma } = require('./util');

// Adapters that exist. notion/jira are allowlisted destination kinds in the
// config schema (the ask-once flow may not record what it cannot name), but
// their adapters are not built — choosing one refuses honestly.
const BUILT_ADAPTERS = ['markdown-only', 'confluence'];

const FETCH_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Markdown -> Confluence storage XHTML, for the CLOSED dialect our renderers
// emit: #/##/### headings, paragraphs, _italic_ whole-line asides, -/numbered
// lists (one nesting level), **bold** and `code` inline, blank-line
// separation. This is not a general markdown engine and refuses to be one:
// anything outside the dialect renders as an escaped paragraph, never as
// markup guessed at. Fact-ID annotations are stripped before conversion —
// they are traceability for the gate, not content for a page.
// ---------------------------------------------------------------------------

// Inline: **bold**, `code`, _italic_ when it wraps the whole remaining text.
// Escape FIRST, then substitute on the escaped text — the patterns contain no
// XML metacharacters, so order is safe and nothing user-authored reaches the
// page unescaped.
function inline(text) {
  let t = escapeXml(text);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

function mdToStorage(markdown) {
  const lines = stripAnnotations(markdown).split('\n');
  const out = [];
  let para = [];
  // list stack: entries are 'ul' | 'ol'; depth 0..2 (top + one nested level)
  const listStack = [];

  const closeLists = (toDepth) => {
    while (listStack.length > toDepth) {
      const kind = listStack.pop();
      // Append to the previous fragment: a close tag on its own joined line
      // would split <li> content from its closure across the '\n' join.
      const tag = kind === 'ul' ? '</li></ul>' : '</li></ol>';
      if (out.length > 0) out[out.length - 1] += tag; else out.push(tag);
    }
  };
  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para.join(' ');
    const m = /^_(.+)_$/.exec(joined);
    out.push(`<p>${m ? `<em>${inline(m[1])}</em>` : inline(joined)}</p>`);
    para = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    const bullet = /^( *)- (.+)$/.exec(line);
    const ordered = /^( *)\d+\. (.+)$/.exec(line);

    if (line === '') { flushPara(); closeLists(0); continue; }
    if (heading) {
      flushPara(); closeLists(0);
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (bullet || ordered) {
      flushPara();
      const m = bullet || ordered;
      const kind = bullet ? 'ul' : 'ol';
      const depth = m[1].length >= 2 ? 2 : 1; // two spaces = one nested level
      closeLists(depth);
      if (listStack.length === depth) {
        out.push(`</li><li>${inline(m[2])}`);
      } else {
        // Open lists until the stack reaches this depth; the innermost open
        // tag carries the item text in the same fragment. A nested item with
        // no open parent gets an (empty) parent item — valid XML, and honest
        // about input that sits outside the dialect.
        let opening = '';
        while (listStack.length < depth) {
          opening += kind === 'ul' ? '<ul><li>' : '<ol><li>';
          listStack.push(kind);
        }
        out.push(opening + inline(m[2]));
      }
      continue;
    }
    // continuation text inside an open list item, or plain paragraph text
    if (listStack.length > 0) { out.push(' ' + inline(line.trim())); continue; }
    para.push(line.trim());
  }
  flushPara(); closeLists(0);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The pre-flight every adapter shares: config valid, consent recorded,
// certificate present + passing + at HEAD, fleet complete.
// ---------------------------------------------------------------------------

function loadCertifiedFleet(cwd) {
  const configRead = readJson(path.join(cwd, '.ogma', 'config.json'));
  if (configRead.error) return { error: `config.json unreadable: ${S.safe(configRead.error, 200)} — run \`ogma init\` first` };
  const config = configRead.value;
  const cErrors = [];
  S.validateConfig(config, cErrors);
  if (cErrors.length) return { error: `config.json is not valid: ${cErrors.slice(0, 3).join('; ')}` };

  const head = gitHead(cwd);
  if (head.error) return { error: head.error };
  const headCommit = head.commit;

  const certRead = readJson(path.join(cwd, '.ogma', 'certificate.json'));
  if (certRead.error) return { error: 'no certificate — run `ogma gate` first; only a certified fleet ships' };
  const cert = certRead.value;
  const errors = [];
  S.validateCertificate(cert, errors);
  if (errors.length) return { error: `certificate.json is not a valid certificate: ${errors.slice(0, 3).join('; ')}` };
  if (cert.pass !== true) return { error: 'the certificate is FAILING — fix the findings and re-run `ogma gate`; a failing fleet does not ship' };
  if (!S.sameCommit(cert.commit, headCommit)) {
    return { error: `certificate is for ${String(cert.commit).slice(0, 12)} but HEAD is ${headCommit.slice(0, 12)} — run \`ogma watch\`, refresh, and re-run \`ogma gate\`` };
  }

  const terrainRead = readJson(path.join(cwd, '.ogma', 'ogham', 'terrain.json'));
  if (terrainRead.error) return { error: 'terrain.json unreadable — the Ogham is incomplete' };
  const expected = S.outDocuments(config, terrainRead.value);
  const outDir = path.join(cwd, '.ogma', 'out');
  const certifiedSha = new Map((Array.isArray(cert.documents) ? cert.documents : []).map(d => [d.path, d.sha256]));
  const files = [];
  for (const rel of expected) {
    // The dashboard is LOCAL ONLY and is never delivered. map.md/html/canvas
    // are views over the certificate itself, so the gate that produces the
    // verdict cannot byte-bind the document that displays it — it would be
    // certifying its own answer. That left the only shippable document nobody
    // could vouch for: a stale or hand-edited map.md went out under the
    // certified banner with a hash check deliberately skipped. Rather than
    // ship an unverifiable document, push does not ship it at all. It stays
    // in .ogma/out/ for the operator, where coverage still requires it to
    // exist and integrity still requires it to be in the contract.
    if (/^map\./.test(rel)) continue;
    let text;
    try { text = fs.readFileSync(path.join(outDir, rel), 'utf8'); }
    catch { return { error: `out/${rel} is missing though the certificate passed — re-render, re-run \`ogma gate\`` }; }
    const hash = sha256(text);
    // The certificate names the bytes it certified. A document edited between
    // gate and push must not ship under the certified banner. Every remaining
    // document is certificate-listed, so this now holds with no exemptions.
    const want = certifiedSha.get(rel);
    if (want === undefined) return { error: `out/${rel} is not named in the certificate — re-run \`ogma gate\`` };
    if (want !== hash) return { error: `out/${rel} changed after the gate ran — re-run \`ogma gate\` before pushing` };
    files.push({ path: rel, text, sha256: hash });
  }
  return { config, headCommit, cert, files };
}

// ---------------------------------------------------------------------------
// Destination sniffing + the ask-once flow
// ---------------------------------------------------------------------------

function confluenceEnv(env) {
  const base = env.CONFLUENCE_BASE_URL;
  const email = env.CONFLUENCE_EMAIL;
  const token = env.CONFLUENCE_API_TOKEN;
  if (!base || !email || !token) return null;
  // https only — with one carve-out: plain http to the loopback interface,
  // for local test doubles. Credentials never ride cleartext off the machine.
  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base.replace(/\/+$/, ''));
  if (!/^https:\/\/[^\s/]+/.test(base) && !isLoopback) {
    return { error: 'CONFLUENCE_BASE_URL must be an https:// origin (http is allowed only for 127.0.0.1)' };
  }
  return { base: base.replace(/\/+$/, ''), email, token };
}

function sniff(env) {
  const found = ['markdown-only'];
  // Only list confluence when the environment yields a USABLE config. A
  // non-https / non-loopback base makes confluenceEnv return an {error}
  // object (truthy) that a real push would then refuse — listing it as
  // "detected" would promise a destination that cannot be used.
  const cf = confluenceEnv(env);
  if (cf && !cf.error) found.push('confluence');
  return found;
}

function printAsk(log, env) {
  const found = sniff(env);
  log('No delivery destination is on record, and consent is never assumed — nothing was delivered.');
  log(`Detected in this environment: ${found.join(', ')}.`);
  log('Choose once and it persists in .ogma/config.json:');
  log('  ogma push --to markdown-only            the local out/ fleet is the destination');
  log('  ogma push --to confluence --space <KEY> --parent <PAGE-ID>');
  log('    (requires CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN in the environment)');
}

// Parse push's argv tail. Closed flag set; anything else refuses.
function parseArgs(rest) {
  const out = { to: undefined, space: undefined, parent: undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--to' || a === '--space' || a === '--parent') {
      const v = rest[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      if (a === '--to') out.to = v; else if (a === '--space') out.space = v; else out.parent = v;
    } else {
      return { error: `unrecognized argument: ${S.safe(a, 60)}` };
    }
  }
  if (out.to !== 'confluence' && (out.space !== undefined || out.parent !== undefined)) {
    return { error: '--space/--parent only make sense with --to confluence' };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Confluence adapter — REST v2 pages API, env-credentialed, fetch-back
// verified. Titles are "<project> · <doc path>"; the path -> page_id mapping
// persists in push-state so re-pushes update in place.
// ---------------------------------------------------------------------------

function docTitle(project, relPath) {
  return `${project} · ${relPath.replace(/\.md$/, '')}`;
}

async function cfFetch(cf, pathname, options = {}) {
  const auth = Buffer.from(`${cf.email}:${cf.token}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${cf.base}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSpaceId(cf, spaceKey) {
  const r = await cfFetch(cf, `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`);
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.results) || r.body.results.length === 0) {
    throw new Error(`space "${spaceKey}" not found (HTTP ${r.status})`);
  }
  return String(r.body.results[0].id);
}

async function pushOneToConfluence(cf, spaceId, parentId, title, storageBody, existingPageId) {
  if (existingPageId) {
    // read current version, then update
    const cur = await cfFetch(cf, `/wiki/api/v2/pages/${existingPageId}`);
    if (cur.status !== 200 || !cur.body) throw new Error(`page ${existingPageId} not readable (HTTP ${cur.status}) — mapping may be stale; delete it from push-state to recreate`);
    const curVersion = cur.body.version && cur.body.version.number;
    if (!Number.isInteger(curVersion)) throw new Error(`page ${existingPageId} response carried no version.number — unexpected Confluence API shape, refusing to guess the next version`);
    const nextVersion = curVersion + 1;
    const upd = await cfFetch(cf, `/wiki/api/v2/pages/${existingPageId}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: existingPageId, status: 'current', title,
        body: { representation: 'storage', value: storageBody },
        version: { number: nextVersion }
      })
    });
    if (upd.status !== 200) throw new Error(`update of page ${existingPageId} failed (HTTP ${upd.status})`);
    // fetch-back: version advanced, status current, title as sent
    const back = await cfFetch(cf, `/wiki/api/v2/pages/${existingPageId}`);
    if (back.status !== 200 || !back.body) throw new Error(`update of ${existingPageId} could not be read back (HTTP ${back.status})`);
    const backVersion = back.body.version && back.body.version.number;
    if (backVersion !== nextVersion || back.body.status !== 'current' || back.body.title !== title) {
      throw new Error(`update of ${existingPageId} did not verify: version ${backVersion} (wanted ${nextVersion}), status ${back.body.status}`);
    }
    return { pageId: existingPageId, action: 'updated', version: nextVersion };
  }
  const crt = await cfFetch(cf, '/wiki/api/v2/pages', {
    method: 'POST',
    body: JSON.stringify({
      spaceId, status: 'current', title, parentId,
      body: { representation: 'storage', value: storageBody }
    })
  });
  if (crt.status !== 200 || !crt.body || !crt.body.id) throw new Error(`creation of "${title}" failed (HTTP ${crt.status})`);
  const pageId = String(crt.body.id);
  // fetch-back for a CREATE is the full-content tier: the body must come back
  // with every heading present — an API 200 alone is not proof of content.
  // From here on the page EXISTS on the remote: any verification failure
  // carries the created id so the caller can record the orphan honestly.
  const fail = (msg) => {
    const err = new Error(msg);
    err.createdPageId = pageId;
    return err;
  };
  const back = await cfFetch(cf, `/wiki/api/v2/pages/${pageId}?body-format=storage`);
  if (back.status !== 200 || !back.body) throw fail(`created page ${pageId} could not be read back (HTTP ${back.status})`);
  const gotBody = back.body.body && back.body.body.storage ? String(back.body.body.storage.value) : '';
  const headings = [...storageBody.matchAll(/<h[1-6]>(.*?)<\/h[1-6]>/g)].map(m => m[1]);
  const missing = headings.filter(h => !gotBody.includes(h));
  if (back.body.title !== title || missing.length > 0) {
    throw fail(`created page ${pageId} did not verify: ${missing.length} heading(s) absent from the read-back body`);
  }
  return { pageId, action: 'created', version: 1 };
}

// Validate-then-write the push-state record. Returns true on success; a
// state that will not validate is a defect and is never written.
function writeState(cwd, kind, commit, files, log) {
  const state = {
    push_state_version: S.PUSH_STATE_VERSION,
    kind,
    commit,
    delivered_at: nowIso(),
    files
  };
  const errors = [];
  S.validatePushState(state, errors);
  if (errors.length) { log('ogma push failed: produced an invalid push-state: ' + errors.slice(0, 3).join('; ')); return false; }
  ogmaWrite(cwd, 'push-state.json', JSON.stringify(state, null, 2) + '\n');
  return true;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

async function cmdPush(cwd, rest = [], log = console.log, env = process.env) {
  try {
    const args = parseArgs(rest);
    if (args.error) { log(`ogma push: ${args.error}`); return 1; }

    // Provenance FIRST — before the fleet is loaded, before consent is read or
    // recorded. `init` refuses a repo-supplied destination, but push can run
    // without init ever having run, and a repo can ship .ogma/config.json (a
    // pre-seeded consent or targeting block), .ogma/push-state.json (attacker
    // page-id mappings a replay would UPDATE), or the Ogham itself (facts
    // authored by the repo, rendered and delivered as this operator's
    // verified truth).
    //
    // Order matters: loading the fleet first meant a tracked Ogham was
    // reported as a stale certificate, which sends the operator to `ogma
    // watch` to "refresh" — advice that walks them toward certifying the
    // repo's own facts instead of telling them the state is not theirs.
    //
    // The scope is ALL of .ogma/, not the consent files alone. An earlier,
    // narrower gate reasoned that a committed certificate cannot lie — true,
    // it would have to name the commit that contains it — and wrongly
    // generalised that fixpoint to the rest of the directory. facts/,
    // terrain.json and ledger.json have no such property, and the one binding
    // a hostile repo cannot forge (the manifest at HEAD) is supplied by the
    // victim's own ingest run. init writes .ogma/.gitignore so an ordinary
    // `git add -A` cannot produce tracked state by accident.
    const tracked = trackedOgmaState(cwd);
    if (tracked.length > 0) { refuseTrackedOgma('push', tracked, log); return 1; }

    const fleet = loadCertifiedFleet(cwd);
    if (fleet.error) { log(`ogma push refused: ${fleet.error}`); return 1; }
    const { config, headCommit, files } = fleet;
    const configPath = path.join(cwd, '.ogma', 'config.json');

    // --- consent -------------------------------------------------------------
    if (args.to !== undefined) {
      if (!S.DESTINATION_KINDS.includes(args.to) || args.to === null) {
        log(`ogma push: unknown destination "${S.safe(String(args.to), 40)}" — one of: ${S.DESTINATION_KINDS.filter(k => k).join(', ')}`);
        return 1;
      }
      if (!BUILT_ADAPTERS.includes(args.to)) {
        log(`ogma push: the ${args.to} adapter is not built yet. OGMA ships complete; it refuses to pretend.`);
        return 1;
      }
      config.destination.kind = args.to;
      config.destination.asked = true;
      if (args.to === 'confluence') {
        const prior = config.destination.confluence || {};
        config.destination.confluence = {
          space_key: args.space !== undefined ? args.space : prior.space_key,
          parent_page_id: args.parent !== undefined ? args.parent : prior.parent_page_id
        };
      }
      const errors = [];
      S.validateConfig(config, errors);
      if (errors.length) { log(`ogma push: that choice does not validate: ${errors.slice(0, 3).join('; ')}`); return 1; }
      ogmaWrite(cwd, 'config.json', JSON.stringify(config, null, 2) + '\n');
      log(`Destination recorded: ${args.to} (persisted in .ogma/config.json — ask-once, asked).`);
    } else if (config.destination.asked !== true || config.destination.kind === null) {
      printAsk(log, env);
      return 1;
    }
    const kind = config.destination.kind;
    if (!BUILT_ADAPTERS.includes(kind)) {
      log(`ogma push: the recorded destination "${kind}" has no built adapter yet.`);
      return 1;
    }

    // --- prior state (for replay + page mapping) -----------------------------
    const statePath = path.join(cwd, '.ogma', 'push-state.json');
    let prior = null;
    if (fs.existsSync(statePath)) {
      const stateRead = readJson(statePath);
      if (stateRead.error) { log(`ogma push refused: push-state.json exists but is unreadable: ${S.safe(stateRead.error, 160)}`); return 1; }
      const sErrors = [];
      S.validatePushState(stateRead.value, sErrors);
      if (sErrors.length) { log(`ogma push refused: push-state.json is not valid: ${sErrors.slice(0, 3).join('; ')}`); return 1; }
      prior = stateRead.value;
    }
    const priorByPath = new Map((prior ? prior.files : []).map(f => [f.path, f]));

    // --- deliver -------------------------------------------------------------
    const delivered = [];
    if (kind === 'markdown-only') {
      // The fleet on disk IS the destination; delivery is verification + the
      // replayable record. Diff against the prior push so the output says what
      // actually changed. Page-id mappings from an earlier page-backed push
      // ride through untouched — dropping them here would make the next
      // confluence push CREATE duplicates of every page it ever made.
      log(`Destination: markdown-only — the local .ogma/out/ fleet (${files.length} document(s)).`);
      for (const f of files) {
        const was = priorByPath.get(f.path);
        const change = !was ? 'new' : (was.sha256 === f.sha256 ? 'unchanged' : 'changed');
        const entry = { path: f.path, sha256: f.sha256 };
        if (was && was.page_id) {
          entry.page_id = was.page_id;
          if (was.verified === false) entry.verified = false;
        }
        delivered.push(entry);
        log(`  ${change.padEnd(9)} out/${f.path}`);
      }
    } else if (kind === 'confluence') {
      const cf = confluenceEnv(env);
      if (!cf) {
        log('ogma push refused: confluence needs CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in the environment. Nothing was delivered.');
        return 1;
      }
      if (cf.error) { log(`ogma push refused: ${cf.error}`); return 1; }
      const settings = config.destination.confluence;
      if (!settings) {
        log('ogma push refused: no confluence settings on record — run `ogma push --to confluence --space <KEY> --parent <PAGE-ID>` once.');
        return 1;
      }
      // Say WHERE, before anything moves. A push that never prints its target
      // is a push whose redirection nobody notices.
      log(`Destination: confluence at ${cf.base}, space ${settings.space_key}, parent page ${settings.parent_page_id} — ${files.length} document(s).`);
      const spaceId = await resolveSpaceId(cf, settings.space_key);
      let inFlight = null;   // the file being delivered, for honest failure records
      try {
        for (const f of files) {
          const was = priorByPath.get(f.path);
          if (was && was.page_id && was.sha256 === f.sha256 && was.verified !== false) {
            // Verified content already on that page from a prior push; replay
            // skips it rather than bumping versions with identical bodies.
            delivered.push({ path: f.path, sha256: f.sha256, page_id: was.page_id });
            log(`  unchanged ${f.path} (page ${was.page_id})`);
            continue;
          }
          const body = mdToStorage(f.text);
          inFlight = f;
          const r = await pushOneToConfluence(
            cf, spaceId, settings.parent_page_id,
            docTitle(config.project, f.path), body,
            was && was.page_id ? was.page_id : null
          );
          inFlight = null;
          delivered.push({ path: f.path, sha256: f.sha256, page_id: r.pageId });
          log(`  ${r.action.padEnd(9)} ${f.path} → page ${r.pageId} v${r.version} (read back, verified)`);
        }
      } catch (e) {
        // A CREATE that succeeded but failed its read-back verification left
        // a real page on the remote. Losing that mapping makes the next push
        // CREATE a duplicate; recording it as verified would be a lie. It is
        // recorded with verified:false — replay never skips it, the next push
        // UPDATEs it in place.
        if (e && e.createdPageId && inFlight) {
          delivered.push({ path: inFlight.path, sha256: inFlight.sha256, page_id: e.createdPageId, verified: false });
          log(`  UNVERIFIED ${inFlight.path} → page ${e.createdPageId} exists on the remote but its content did not verify — recorded for update, not for replay`);
        }
        // A mid-fleet failure must not lose the mapping of pages already
        // created and verified this run — losing it makes the next push
        // CREATE duplicates. Record what verified (per-file sha256 is ground
        // truth for what each page actually holds), keep prior entries for
        // everything not reached, and fail honestly.
        if (delivered.length > 0) {
          const kept = (prior ? prior.files : []).filter(p => !delivered.some(d => d.path === p.path));
          writeState(cwd, kind, headCommit, [...delivered, ...kept], log);
          log(`ogma push failed after ${delivered.length} deliver(ies) — their page mapping is recorded; the rest keeps its prior state.`);
        }
        log(`ogma push failed: ${e.message}`);
        return 1;
      }
    }

    // --- record --------------------------------------------------------------
    if (!writeState(cwd, kind, headCommit, delivered, log)) return 1;
    log(`Delivered ${delivered.length} document(s) via ${kind} at ${headCommit.slice(0, 12)}. Wrote .ogma/push-state.json`);
    return 0;
  } catch (e) {
    log(`ogma push failed: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdPush, mdToStorage, parseArgs, sniff, confluenceEnv, loadCertifiedFleet, docTitle };
