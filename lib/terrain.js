// ogma terrain — the Eyes. Deterministic scan of a repository into terrain.json:
// surfaces (deployables), entry points, module candidates, language stats.
// Zero-LLM: everything here is derivable from the file tree and manifest files.
// The skill layer refines names and summaries during ingest; this scan never
// overwrites a refinement (merge preserves existing surfaces and modules — the
// same "kept must not mean clobbered" stance init takes with the ledger).
//
// Reads the repo ONLY through git at HEAD (`ls-tree`, `show`), never the
// working tree: untracked and ignored files are not part of any certified
// state, and a scan that read them would describe a repo no commit contains.
//
// Framework and ecosystem names below (dependency names, config filenames,
// directory conventions) are DETECTION DATA, not identity: a terrain engine
// that cannot name `package.json` or `react` cannot detect anything. The
// purity rule bans absorbed-tool and client names as identity; it does not ban
// the vocabulary of the ecosystems OGMA exists to read (see CLAUDE.md #4).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  validateTerrain, isSafeRepoPath, safe, MAX_ARRAY
} = require('./schema');
const { refuseSymlink, ogmaWrite } = require('./util');

// Upper bound on any single manifest file this scan will read. A package
// manifest is settings, not data; anything larger is skipped with a note.
const MAX_MANIFEST_BYTES = 1024 * 1024;
// Upper bound on the ls-tree listing itself (~100k files comfortably).
const MAX_LISTING_BYTES = 64 * 1024 * 1024;
// A directory becomes a module candidate at this many code files. One-file
// directories are usually structure noise; the threshold is documented in
// docs/ogham-schema.md and the files it leaves unassigned are counted and
// reported, never silently dropped.
const MIN_MODULE_FILES = 2;
const MAX_ENTRY_POINTS = 8;

// Directories whose contents are vendored or generated: never a surface,
// never a module, never counted in language stats.
const EXCLUDED_DIRS = new Set([
  'node_modules', 'vendor', 'vendors', 'third_party', 'thirdparty',
  'dist', 'build', 'out', 'target', 'obj', 'coverage', '__pycache__',
  '.venv', 'venv', 'Pods', 'DerivedData', '.next', '.nuxt', '.svelte-kit',
  '.output', '.turbo', '.cache', 'bower_components', '.ogma'
]);

// Deployable manifests: a directory holding one is a surface candidate.
const MANIFEST_NAMES = new Set([
  'package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'pyproject.toml', 'setup.py', 'composer.json',
  'Gemfile', 'mix.exs'
]);
const isManifestName = base => MANIFEST_NAMES.has(base) || base.endsWith('.csproj');

// Extension -> canonical language key. Doubles as the "what counts as code"
// set for module clustering. Keys follow the schema's short-key convention.
const LANG_BY_EXT = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  vue: 'vue', svelte: 'svelte',
  cs: 'cs', fs: 'fs', fsx: 'fs',
  py: 'py', go: 'go', rs: 'rs',
  java: 'java', kt: 'kt', kts: 'kt', scala: 'scala', groovy: 'groovy',
  rb: 'rb', php: 'php', swift: 'swift', dart: 'dart',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  m: 'objc', mm: 'objc',
  ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', clj: 'clojure', lua: 'lua', r: 'r', jl: 'julia',
  pl: 'perl', sh: 'sh', bash: 'sh', ps1: 'ps1',
  sql: 'sql', html: 'html', css: 'css', scss: 'css', sass: 'css', less: 'css'
};

// Dependency names that mark a package.json surface as a user interface.
const UI_DEPS = new Set([
  'react', 'react-dom', 'vue', 'svelte', '@angular/core', 'preact',
  'solid-js', 'next', 'nuxt', 'astro', '@remix-run/react', 'expo', 'react-native'
]);

const ADMIN_RX = /(^|[-_./])(admin|backoffice|back-office|console|cms|ops|dashboard)([-_./]|$)/i;
const WORKER_RX = /(^|[-_./])(worker|jobs?|consumer|daemon|scheduler|cron)([-_./]|$)/i;

// Well-known entry filenames, relative to a surface root, in priority order.
const ENTRY_CANDIDATES = [
  'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
  'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
  'index.html', 'public/index.html',
  'main.py', 'app.py', 'manage.py', 'src/main.py', 'app/main.py',
  'main.go', 'src/main.rs', 'Program.cs',
  'server.js', 'app.js', 'index.js', 'main.js', 'index.ts'
];

const SOURCE_BASES = ['src', 'app', 'lib', 'source'];

// ---------------------------------------------------------------------------

function extOf(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function isExcluded(p) {
  for (const seg of p.split('/')) if (EXCLUDED_DIRS.has(seg)) return true;
  return false;
}

function slugify(s, fallback = 'x') {
  const slug = String(s).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slug || fallback;
}

function humanize(slug) {
  return slug.split(/[-_]+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function uniqueId(want, taken) {
  let id = want;
  for (let n = 2; taken.has(id); n++) id = `${want}-${n}`;
  taken.add(id);
  return id;
}

function joinRel(root, sub) {
  return root === '.' ? sub : `${root}/${sub}`;
}

// Normalize a manifest-declared path ("./src/main.js") into a repo path under
// root. Pure normalization, no safety judgment of its own: the ONE citability
// rule lives at tree intake (analyzeTree drops non-citable tracked paths), so
// membership in the tracked file set is the only gate a candidate entry point
// needs — a traversal, absolute, or argv-shaped value simply names no file in
// the set. One rule in one place; a second copy here would just hide the
// first one's deletion from the bench.
function manifestPath(root, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null;
  let v = value.replace(/\\/g, '/');
  while (v.startsWith('./')) v = v.slice(2);
  if (v === '') return null;
  return joinRel(root, v);
}

// ---------------------------------------------------------------------------
// The pure core. entries: [{path, size}] (repo-relative POSIX paths, tracked
// blobs only). readText(path) -> string|null. Never throws on hostile shapes:
// a broken manifest is a note, not a crash.
function analyzeTree({ entries, readText, projectName } = {}) {
  const notes = [];
  const read = typeof readText === 'function' ? readText : () => null;

  const files = [];
  const sizeByPath = new Map();
  let uncitable = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.path !== 'string' || e.path.length === 0) continue;
    if (isExcluded(e.path)) continue;
    // A path the schema cannot cite (backslash, control bytes, argv-shaped
    // leading dash — git will happily track all of these) must not reach
    // module roots: one such file would make the whole terrain invalid and
    // brick the scan. Skipping it LOUDLY is the honest alternative — the note
    // is the difference between "excluded, told you" and "silently missing".
    if (!isSafeRepoPath(e.path)) { uncitable++; continue; }
    const size = Number.isFinite(e.size) && e.size >= 0 ? e.size : 0;
    files.push(e.path);
    sizeByPath.set(e.path, size);
  }
  if (uncitable > 0) notes.push(`${uncitable} tracked files have non-citable paths and were skipped — they will not appear in any output`);
  const fileSet = new Set(files);

  // Language stats over the whole included tree.
  const languages = {};
  for (const p of files) {
    const lang = LANG_BY_EXT[extOf(p)];
    if (lang) languages[lang] = (languages[lang] || 0) + sizeByPath.get(p);
  }

  // -- surfaces --------------------------------------------------------------
  const manifestDirs = new Map(); // root -> [manifest paths]
  for (const p of files) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!isManifestName(base)) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
    if (!manifestDirs.has(dir)) manifestDirs.set(dir, []);
    manifestDirs.get(dir).push(p);
  }

  const readManifest = (p) => {
    const size = sizeByPath.get(p) || 0;
    if (size > MAX_MANIFEST_BYTES) {
      notes.push(`skipped oversized manifest ${safe(p, 120)} (${size} bytes)`);
      return null;
    }
    return read(p);
  };

  const surfaceRoots = [];
  for (const [dir, manifests] of manifestDirs) {
    // A workspace-root package.json is tooling for the packages below it, not
    // a deployable of its own — skip it when it declares workspaces and other
    // surface candidates exist beneath it.
    const pkgPath = manifests.find(m => m.endsWith('package.json'));
    let pkg = null;
    if (pkgPath) {
      const text = readManifest(pkgPath);
      if (text !== null) {
        try { pkg = JSON.parse(text); }
        catch { notes.push(`unparseable ${safe(pkgPath, 120)} — treated as opaque`); }
      }
      if (pkg !== null && (typeof pkg !== 'object' || Array.isArray(pkg))) pkg = null;
    }
    surfaceRoots.push({ root: dir, manifests, pkg });
  }
  const rootsSet = new Set(surfaceRoots.map(s => s.root));
  const kept = surfaceRoots.filter(s => {
    const isWorkspaceRoot = s.pkg && s.pkg.workspaces !== undefined
      && [...rootsSet].some(r => r !== s.root && (s.root === '.' || r.startsWith(s.root + '/')));
    if (isWorkspaceRoot) notes.push(`workspace root ${safe(s.root, 120)} is tooling, not a surface`);
    return !isWorkspaceRoot;
  });

  // No manifest anywhere: the repo itself is one service surface.
  if (kept.length === 0 && files.length > 0) {
    kept.push({ root: '.', manifests: [], pkg: null });
    notes.push('no deployable manifest found — treating the repo root as one surface');
  }

  const takenSurfaceIds = new Set();
  const surfaces = [];
  for (const s of kept.sort((a, b) => a.root.localeCompare(b.root))) {
    const filesUnder = (p) => s.root === '.' ? true : p === s.root || p.startsWith(s.root + '/');
    const ownFiles = files.filter(p => filesUnder(p)
      && !kept.some(o => o !== s && o.root !== '.' && (p === o.root || p.startsWith(o.root + '/'))
        && (s.root === '.' || o.root.startsWith(s.root + '/'))));

    // Kind.
    const deps = s.pkg ? { ...(s.pkg.dependencies || null), ...(s.pkg.devDependencies || null) } : {};
    const hasUiDep = Object.keys(deps).some(d => UI_DEPS.has(d));
    const hasHtml = ownFiles.some(p => p.endsWith('.html'));
    const nameHints = `${s.root} ${s.pkg && typeof s.pkg.name === 'string' ? s.pkg.name : ''}`;
    let kind = 'service';
    let csprojWorker = false;
    for (const m of s.manifests.filter(m => m.endsWith('.csproj'))) {
      const text = readManifest(m);
      if (typeof text === 'string' && /Sdk="Microsoft\.NET\.Sdk\.Worker"/.test(text)) csprojWorker = true;
    }
    if (csprojWorker || WORKER_RX.test(nameHints)) kind = 'worker';
    else if ((hasUiDep || hasHtml) && ADMIN_RX.test(nameHints)) kind = 'admin-web';
    else if (hasUiDep || hasHtml) kind = 'frontend';

    // Id.
    const lastSeg = s.root === '.'
      ? slugify(projectName || 'app', 'app')
      : slugify(s.root.slice(s.root.lastIndexOf('/') + 1), 'app');
    const id = uniqueId(lastSeg, takenSurfaceIds);

    // Entry points: manifest-declared first, then well-known names.
    const entryPoints = [];
    const push = (p) => {
      if (p && fileSet.has(p) && !entryPoints.includes(p) && entryPoints.length < MAX_ENTRY_POINTS) entryPoints.push(p);
    };
    if (s.pkg) {
      push(manifestPath(s.root, s.pkg.main));
      push(manifestPath(s.root, s.pkg.module));
      const bin = s.pkg.bin;
      if (typeof bin === 'string') push(manifestPath(s.root, bin));
      else if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
        for (const v of Object.values(bin)) push(manifestPath(s.root, v));
      }
    }
    for (const c of ENTRY_CANDIDATES) push(joinRel(s.root, c));
    for (const p of ownFiles) {            // Go convention: cmd/<name>/main.go
      if (/(^|\/)cmd\/[^/]+\/main\.go$/.test(p)) push(p);
    }
    if (entryPoints.length === 0) for (const m of s.manifests) push(m);
    if (entryPoints.length === 0 && ownFiles.length > 0) push(ownFiles[0]);

    surfaces.push({ id, kind, root: s.root, entry_points: entryPoints, _ownFiles: ownFiles });
  }

  // -- module candidates -----------------------------------------------------
  const takenModuleIds = new Set();
  const modules = [];
  let unassigned = 0;
  for (const s of surfaces) {
    const codeFiles = s._ownFiles.filter(p => LANG_BY_EXT[extOf(p)] && !p.endsWith('.html') && !p.endsWith('.css'));
    const prefix = s.root === '.' ? '' : s.root + '/';
    const base = SOURCE_BASES.map(b => joinRel(s.root, b))
      .find(b => codeFiles.some(p => p.startsWith(b + '/'))) || s.root;
    const basePrefix = base === '.' ? '' : base + '/';

    const buckets = new Map(); // first segment under base -> {count, bytes, langs}
    let baseLoose = 0;
    for (const p of codeFiles) {
      if (!p.startsWith(basePrefix)) { unassigned++; continue; }
      const rest = p.slice(basePrefix.length);
      const cut = rest.indexOf('/');
      if (cut === -1) { baseLoose++; continue; }
      const seg = rest.slice(0, cut);
      if (!buckets.has(seg)) buckets.set(seg, { count: 0, bytes: {} });
      const b = buckets.get(seg);
      b.count++;
      const lang = LANG_BY_EXT[extOf(p)];
      b.bytes[lang] = (b.bytes[lang] || 0) + (sizeByPath.get(p) || 0);
    }

    let made = 0;
    for (const [seg, b] of [...buckets].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (b.count < MIN_MODULE_FILES) { unassigned += b.count; continue; }
      const root = joinRel(base, seg);
      const want = slugify(seg, 'module');
      const id = uniqueId(takenModuleIds.has(want) ? `${s.id}-${want}` : want, takenModuleIds);
      const topLang = Object.entries(b.bytes).sort((x, y) => y[1] - x[1])[0];
      modules.push({
        id, name: humanize(want), surface_ids: [s.id], roots: [root],
        summary: `Auto-detected area under ${root}: ${b.count} code files` +
          `${topLang ? `, mostly ${topLang[0]}` : ''}. Not yet refined by ingest.`
      });
      made++;
    }
    unassigned += baseLoose;
    if (made === 0 && codeFiles.length > 0) {
      const id = uniqueId(`${s.id}-main`, takenModuleIds);
      modules.push({
        id, name: humanize(id), surface_ids: [s.id], roots: [base],
        summary: `Auto-detected: the whole ${s.id} surface (${codeFiles.length} code files, ` +
          `no subdirectory reached the ${MIN_MODULE_FILES}-file threshold). Not yet refined by ingest.`
      });
      unassigned -= codeFiles.length;
      if (unassigned < 0) unassigned = 0;
    }
  }
  if (unassigned > 0) notes.push(`${unassigned} code files sit outside every module candidate (threshold: ${MIN_MODULE_FILES} files per directory)`);
  if (surfaces.length > MAX_ARRAY || modules.length > MAX_ARRAY) {
    notes.push('scan exceeded schema array caps — output truncated');
    surfaces.length = Math.min(surfaces.length, MAX_ARRAY);
    modules.length = Math.min(modules.length, MAX_ARRAY);
  }

  for (const s of surfaces) delete s._ownFiles;
  return { terrain: { surfaces, modules, languages }, notes };
}

// ---------------------------------------------------------------------------
// Merge a fresh scan into an existing (already validated) terrain. Human and
// skill refinements always win: existing surfaces and modules are kept
// verbatim; the scan only appends genuinely new candidates and refreshes the
// purely derived languages block. Returns { terrain, added }.
function mergeTerrain(existing, scanned) {
  const surfaces = existing.surfaces.map(s => ({ ...s }));
  const modules = existing.modules.map(m => ({ ...m }));
  const added = [];

  const knownSurfaceRoots = new Set(surfaces.map(s => s.root));
  const knownSurfaceIds = new Set(surfaces.map(s => s.id));
  for (const s of scanned.surfaces) {
    if (knownSurfaceRoots.has(s.root)) continue;
    const id = uniqueId(s.id, knownSurfaceIds);
    surfaces.push({ ...s, id });
    added.push(`surface ${id} (${s.root})`);
  }

  // A module is "covered" if any existing module claims one of its roots
  // (exactly or as a parent) — renamed or re-rooted refinements stay theirs.
  const covered = (root) => modules.some(m => (m.roots || []).some(r =>
    r === root || root.startsWith(r + '/') || r.startsWith(root + '/')));
  const knownModuleIds = new Set(modules.map(m => m.id));
  const surfaceIds = new Set(surfaces.map(s => s.id));
  for (const m of scanned.modules) {
    if ((m.roots || []).every(covered)) continue;
    if (!m.surface_ids.every(id => surfaceIds.has(id))) continue;
    const id = uniqueId(m.id, knownModuleIds);
    modules.push({ ...m, id });
    added.push(`module ${id} (${m.roots.join(', ')})`);
  }

  return { terrain: { surfaces, modules, languages: scanned.languages }, added };
}

// ---------------------------------------------------------------------------

function git(cwd, args, maxBuffer = MAX_LISTING_BYTES) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer });
  if (r.error) throw new Error(`git is not available: ${r.error.code || r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${safe((r.stderr || '').trim(), 200)}`);
  return r.stdout;
}

// One blob at a pinned revision, size-capped by maxBuffer; null on any
// failure. Shared with the graph indexer — the "read only through git"
// posture lives here, in one place.
function gitShow(cwd, file, maxBuffer) {
  try { return git(cwd, ['show', `HEAD:${file}`], maxBuffer); }
  catch { return null; }
}

function listTracked(cwd) {
  const commit = git(cwd, ['rev-parse', 'HEAD']).trim();
  const raw = git(cwd, ['ls-tree', '-r', '-l', '-z', 'HEAD']);
  const entries = [];
  let submodules = 0;
  for (const rec of raw.split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    if (tab === -1) continue;
    const meta = rec.slice(0, tab).split(/\s+/);   // mode type hash size
    const p = rec.slice(tab + 1);
    if (meta[1] === 'commit') { submodules++; continue; }
    if (meta[1] !== 'blob') continue;
    entries.push({ path: p, size: Number(meta[3]) || 0 });
  }
  return { commit, entries, submodules };
}

function cmdTerrain(cwd, log = console.log) {
  try {
    const ogham = path.join(cwd, '.ogma', 'ogham');
    if (!fs.existsSync(ogham)) {
      log('No .ogma/ogham/ here — run `ogma init` first.');
      return 1;
    }

    let listed;
    try { listed = listTracked(cwd); }
    catch (e) {
      // A repo with no commits (or no repo at all) fails rev-parse with git
      // internals in the message; the honest sentence is the translated one.
      if (/rev-parse failed/.test(e.message)) {
        log('ogma terrain failed: not a git repository with commits — OGMA reads only committed state, so commit something first.');
        return 1;
      }
      throw e;
    }
    const { commit, entries, submodules } = listed;
    if (entries.length === 0) {
      log('HEAD has no tracked files — nothing to scan.');
      return 1;
    }

    const readText = (p) => gitShow(cwd, p, MAX_MANIFEST_BYTES + 1024);
    const { terrain: scanned, notes } = analyzeTree({
      entries, readText, projectName: path.basename(cwd)
    });
    if (submodules > 0) notes.push(`${submodules} submodules skipped (their content is not in this repo)`);

    // Every tracked file was skipped (non-citable paths, excluded dirs):
    // "surfaces must be a non-empty array" is the validator talking to
    // itself, not an answer for the person who ran the scan.
    if (scanned.surfaces.length === 0) {
      log('ogma terrain failed: nothing citable here — every tracked file was skipped (non-citable path or excluded directory).');
      log('OGMA cannot document files it cannot cite; see the notes below for what was skipped and why.');
      for (const n of notes) log(`  note: ${n}`);
      return 1;
    }

    const terrainPath = path.join(ogham, 'terrain.json');
    const st = refuseSymlink(terrainPath);
    let result = scanned;
    let added = null;
    if (st) {
      if (!st.isFile()) throw new Error('cannot write terrain.json: a directory with that name already exists');
      let existing;
      try { existing = JSON.parse(fs.readFileSync(terrainPath, 'utf8')); }
      catch (e) { throw new Error(`terrain.json exists but cannot be read: ${safe(e.message, 200)}`); }
      const existingErrors = [];
      validateTerrain(existing, existingErrors);
      if (existingErrors.length) {
        throw new Error(`terrain.json exists but is not valid, refusing to merge into it: ${existingErrors.slice(0, 5).join('; ')}`);
      }
      ({ terrain: result, added } = mergeTerrain(existing, scanned));
    }

    const errors = [];
    validateTerrain(result, errors);
    if (errors.length) {
      throw new Error(`scan produced an invalid terrain, refusing to write it: ${errors.slice(0, 5).join('; ')}`);
    }
    ogmaWrite(cwd, 'ogham/terrain.json', JSON.stringify(result, null, 2) + '\n');

    log(`Scanned HEAD (${commit.slice(0, 12)}): ${entries.length} tracked files.`);
    for (const s of result.surfaces) {
      const count = result.modules.filter(m => m.surface_ids.includes(s.id)).length;
      log(`  surface ${s.id} [${s.kind}] root=${s.root} — ${count} modules, entry: ${s.entry_points[0] || '?'}`);
    }
    const langs = Object.entries(result.languages).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, v]) => `${k} ${v < 1024 ? `${v}B` : `${Math.round(v / 1024)}kB`}`).join(', ');
    if (langs) log(`  languages: ${langs}`);
    if (added !== null) {
      log(added.length
        ? `  merged into existing terrain — kept every existing entry, added: ${added.join('; ')}`
        : '  merged into existing terrain — nothing new to add, refinements untouched');
    }
    for (const n of notes) log(`  note: ${n}`);
    log(`Wrote .ogma/ogham/terrain.json (${result.surfaces.length} surfaces, ${result.modules.length} module candidates).`);
    return 0;
  } catch (e) {
    log(`ogma terrain failed: ${e.message}`);
    return 1;
  }
}

module.exports = { cmdTerrain, analyzeTree, mergeTerrain, listTracked, gitShow, MIN_MODULE_FILES, EXCLUDED_DIRS, LANG_BY_EXT };
