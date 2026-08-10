/**
 * StudyFlow — affinityWeaving.js
 *
 * "Affinity Weaving" — an algorithm that groups note cards by how closely
 * related they are, rather than by rigid folders/subjects.
 *
 * Each note pair is scored across several weighted signals; pairs above a
 * threshold become edges in a similarity graph. Groups are then *woven*
 * (grown) from that graph with overlapping membership and a "tangle cap"
 * that prevents one giant catch-all cluster.
 *
 * The edge threshold (`theta`), tangle cap, and weights are driven by user
 * Settings (affinityTightness, affinityMaxGroup) at call time so changes take
 * effect live without a reload.
 */

import Settings from './settings.js';

export const CONFIG = {
  // Edge threshold: a pair becomes linked only if combined weight >= theta.
  theta: 0.32,
  // Maximum size of a single woven group. When exceeded, a sibling group
  // is spawned from the spillover notes (keeps groups human-readable).
  tangleCap: 8,
  // How strongly each signal contributes to a pair's total weight.
  weights: {
    lexical: 0.55,   // token overlap on title + content
    subject: 0.20,   // same subjectId
    temporal: 0.12,  // created/updated close in time
    question: 0.08,  // shared question text
    cocitation: 0.05 // both referenced by a third note
  },
  // Temporal decay: half-life (ms) for the time-proximity bonus.
  temporalHalfLife: 1000 * 60 * 60 * 24 * 7, // 1 week
  // Labels are built from the top-N most distinctive tokens in a group.
  labelTokenCount: 2
};

// Map the user's "tightness" slider (10–90%) onto theta. Higher tightness =>
// higher theta => fewer, tighter links. 10% -> ~0.55 (loose), 90% -> ~0.12.
function effectiveTheta() {
  const t = (Settings.get('affinityTightness') || 50) / 100;
  return 0.55 - (t - 0.1) * (0.55 - 0.12) / 0.8;
}

function effectiveTangleCap() {
  return Settings.get('affinityMaxGroup') || CONFIG.tangleCap;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','for','of','to','in','on',
  'at','by','with','from','as','is','are','was','were','be','been','being','it',
  'this','that','these','those','i','you','he','she','we','they','my','your',
  'our','their','what','which','who','how','why','when','where','do','does',
  'did','have','has','had','will','would','can','could','should','may','might',
  'notes','note','about','into','out','up','down','so','than','too','very',
  'just','also','because','while','after','before','between','over','under'
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[#*_`\[\](){}]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Distinctive tokens per note, with frequency, used for lexical scoring + labels.
function buildLexicon(notes) {
  const perNote = new Map();
  const corpusFreq = new Map();
  for (const n of notes) {
    const toks = tokenize((n.title || '') + ' ' + (n.content || ''));
    const freq = new Map();
    for (const t of toks) {
      freq.set(t, (freq.get(t) || 0) + 1);
      corpusFreq.set(t, (corpusFreq.get(t) || 0) + 1);
    }
    perNote.set(n.id, freq);
  }
  // Weight each token by inverse document frequency so common words matter less.
  const N = notes.length || 1;
  const idf = new Map();
  for (const [t, c] of corpusFreq) idf.set(t, Math.log(N / c) + 1);
  return { perNote, idf };
}

// Cosine-like similarity on tf-idf vectors, normalized to [0,1].
function lexicalSimilarity(aFreq, bFreq, idf) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, f] of aFreq) {
    const w = f * (idf.get(t) || 1);
    na += w * w;
    const fb = bFreq.get(t);
    if (fb) dot += w * (fb * (idf.get(t) || 1));
  }
  for (const [t, f] of bFreq) {
    const w = f * (idf.get(t) || 1);
    nb += w * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function temporalProximity(a, b) {
  const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
  if (!ta || !tb) return 0;
  const gap = Math.abs(ta - tb);
  // Exponential decay: full bonus at gap 0, halves every halfLife.
  return Math.pow(0.5, gap / CONFIG.temporalHalfLife);
}

// Extract question texts referenced by a note (from its questions array).
function questionTexts(note) {
  if (!note.questions || !note.questions.length) return new Set();
  return new Set(note.questions.map((q) => String(q.text || '').toLowerCase().trim()).filter(Boolean));
}

function questionOverlap(a, b) {
  const qa = questionTexts(a), qb = questionTexts(b);
  if (!qa.size || !qb.size) return 0;
  let shared = 0;
  for (const t of qa) if (qb.has(t)) shared++;
  return shared / Math.max(qa.size, qb.size);
}

// Co-citation: notes linked by [[Title]] references in the same source note.
function buildCocitationMap(notes) {
  const titleToIds = new Map();
  for (const n of notes) {
    const key = (n.title || '').toLowerCase().trim();
    if (key) {
      if (!titleToIds.has(key)) titleToIds.set(key, []);
      titleToIds.get(key).push(n.id);
    }
  }
  // Map of "srcId -> Set of referenced note ids".
  const refs = new Map();
  for (const n of notes) {
    const ids = new Set();
    const matches = String(n.content || '').match(/\[\[(.+?)\]\]/g) || [];
    for (const m of matches) {
      const title = m.slice(2, -2).toLowerCase().trim();
      const targets = titleToIds.get(title);
      if (targets) targets.forEach((id) => { if (id !== n.id) ids.add(id); });
    }
    if (ids.size) refs.set(n.id, ids);
  }
  // For each pair both referenced by the same source, record co-citation.
  const cocit = new Map(); // "a|b" -> count
  for (const set of refs.values()) {
    const arr = [...set];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] < arr[j] ? arr[i] + '|' + arr[j] : arr[j] + '|' + arr[i];
        cocit.set(key, (cocit.get(key) || 0) + 1);
      }
    }
  }
  return cocit;
}

// Build the full similarity graph: adjacency map id -> [{ other, weight }].
function buildGraph(notes, lex) {
  const cocit = buildCocitationMap(notes);
  const graph = new Map();
  notes.forEach((n) => graph.set(n.id, []));

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i], b = notes[j];
      const w =
        CONFIG.weights.lexical * lexicalSimilarity(lex.perNote.get(a.id), lex.perNote.get(b.id), lex.idf) +
        CONFIG.weights.subject * (a.subjectId && a.subjectId === b.subjectId ? 1 : 0) +
        CONFIG.weights.temporal * temporalProximity(a, b) +
        CONFIG.weights.question * questionOverlap(a, b);

      const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      const coc = cocit.get(key) ? 1 : 0;
      const total = w + CONFIG.weights.cocitation * coc;

      if (total >= effectiveTheta()) {
        graph.get(a.id).push({ other: b.id, weight: total });
        graph.get(b.id).push({ other: a.id, weight: total });
      }
    }
  }
  return graph;
}

/**
 * Weave groups out of the graph.
 * Overlapping membership: a note joins every group it is strongly connected
 * to (primary group = highest-weight group; others flagged "related").
 * Groups exceeding tangleCap spawn a sibling from their weakest spillover.
 */
export function weaveGroups(notes, graph) {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const visited = new Set();
  const groups = [];

  // Seed from highest-degree (most-connected) unused node each pass.
  const degree = (id) => graph.get(id).length;
  const order = [...graph.keys()].sort((x, y) => degree(y) - degree(x));

  for (const seed of order) {
    if (visited.has(seed)) continue;
    const members = new Set([seed]);
    const queue = [seed];
    visited.add(seed);

    while (queue.length) {
      const cur = queue.shift();
      const neighbors = graph.get(cur)
        .filter((e) => !members.has(e.other))
        .sort((x, y) => y.weight - x.weight);
      for (const e of neighbors) {
        members.add(e.other);
        visited.add(e.other);
        queue.push(e.other);
      }
    }

    groups.push([...members]);
  }

  // Apply tangle cap: split oversized groups by dropping weakest links.
  const capped = [];
  for (const g of groups) {
    if (g.length <= effectiveTangleCap()) { capped.push(g); continue; }
    const core = new Set([g[0]]);
    const spill = g.slice(1);
    spill.sort((a, b) => degree(b) - degree(a));
    for (const id of spill) {
      const connects = graph.get(id).some((e) => core.has(e.other));
      if (core.size < CONFIG.tangleCap && connects) core.add(id);
    }
    const rest = g.filter((id) => !core.has(id));
    capped.push([...core]);
    if (rest.length) capped.push(rest);
  }

  // Build group objects with derived labels and membership roles.
  return capped.map((memberIds, idx) => {
    const members = memberIds.map((id) => byId.get(id)).filter(Boolean);
    const label = deriveLabel(members, lexFromNotes(members));
    return {
      id: 'grp_' + idx,
      label,
      members,
      size: members.length
    };
  });
}

// Lightweight lexicon just for label derivation within a group.
function lexFromNotes(members) {
  const perNote = new Map();
  const corpusFreq = new Map();
  for (const n of members) {
    const toks = tokenize((n.title || '') + ' ' + (n.content || ''));
    const freq = new Map();
    for (const t of toks) {
      freq.set(t, (freq.get(t) || 0) + 1);
      corpusFreq.set(t, (corpusFreq.get(t) || 0) + 1);
    }
    perNote.set(n.id, freq);
  }
  const N = members.length || 1;
  const idf = new Map();
  for (const [t, c] of corpusFreq) idf.set(t, Math.log(N / c) + 1);
  return { perNote, idf, corpusFreq };
}

// Distinctive label: tokens that appear across many members but are rare overall.
function deriveLabel(members, lex) {
  const score = new Map();
  for (const n of members) {
    const freq = lex.perNote.get(n.id);
    if (!freq) continue;
    for (const [t, f] of freq) {
      const idf = lex.idf.get(t) || 1;
      score.set(t, (score.get(t) || 0) + f * idf);
    }
  }
  const top = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONFIG.labelTokenCount)
    .map((e) => e[0]);
  if (!top.length) return 'Unsorted';
  return top.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' · ');
}

/**
 * Public entry point.
 * @param {Array} notes  raw note objects from storage
 * @returns {{ groups: Array, graph: Map, ungrouped: Array }}
 */
export function groupNotes(notes) {
  if (!notes || notes.length === 0) return { groups: [], graph: new Map(), ungrouped: [] };
  if (notes.length === 1) {
    return {
      groups: [{ id: 'grp_0', label: deriveLabel(notes, lexFromNotes(notes)), members: notes, size: 1 }],
      graph: new Map([[notes[0].id, []]]),
      ungrouped: []
    };
  }

  const lex = buildLexicon(notes);
  const graph = buildGraph(notes, lex);
  const groups = weaveGroups(notes, graph);

  const groupedIds = new Set();
  groups.forEach((g) => g.members.forEach((m) => groupedIds.add(m.id)));
  const ungrouped = notes.filter((n) => !groupedIds.has(n.id));

  return { groups, graph, ungrouped };
}

/* ------------------------------------------------------------------ */
/* Additional grouping lenses                                          */
/* ------------------------------------------------------------------ */

function finalizeGroup(idx, members, label) {
  return { id: 'grp_' + idx, label, members, size: members.length };
}

// Group strictly by subjectId; "No subject" collects subject-less notes.
export function groupBySubject(notes, subjects = []) {
  const nameById = new Map(subjects.map((s) => [s.id, s.name]));
  const buckets = new Map();
  const noSubject = [];
  for (const n of notes) {
    if (!n.subjectId) { noSubject.push(n); continue; }
    if (!buckets.has(n.subjectId)) buckets.set(n.subjectId, []);
    buckets.get(n.subjectId).push(n);
  }
  const groups = [];
  let i = 0;
  for (const [id, members] of buckets) {
    groups.push(finalizeGroup(i++, members, nameById.get(id) || 'Subject'));
  }
  if (noSubject.length) groups.push(finalizeGroup(i++, noSubject, 'No subject'));
  return { groups, ungrouped: [] };
}

// Group by recency into rolling time windows.
function recencyBucket(ts) {
  const t = new Date(ts || 0).getTime();
  if (!t) return 'Unknown date';
  const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
  if (days < 1) return 'Today';
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  if (days < 90) return 'Last 3 months';
  return 'Older';
}
const RECENCY_ORDER = ['Today', 'This week', 'This month', 'Last 3 months', 'Older', 'Unknown date'];

export function groupByRecency(notes) {
  const buckets = new Map();
  for (const n of notes) {
    const key = recencyBucket(n.updatedAt || n.createdAt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
  }
  const groups = RECENCY_ORDER
    .filter((k) => buckets.has(k))
    .map((k, i) => finalizeGroup(i, buckets.get(k), k));
  return { groups, ungrouped: [] };
}

// Group by shared question text.
export function groupByQuestions(notes) {
  const buckets = new Map();
  const noQ = [];
  for (const n of notes) {
    const qs = questionTexts(n);
    if (!qs.size) { noQ.push(n); continue; }
    // Assign each note to its first question's bucket (stable, non-overlapping).
    const key = [...qs][0];
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
  }
  const groups = [];
  let i = 0;
  for (const [q, members] of buckets) {
    const label = q.length > 42 ? q.slice(0, 42) + '…' : q;
    groups.push(finalizeGroup(i++, members, label));
  }
  if (noQ.length) groups.push(finalizeGroup(i++, noQ, 'No questions'));
  return { groups, ungrouped: [] };
}

/**
 * Smart dispatcher: pick a grouping lens.
 * @param {Array} notes
 * @param {string} lens  'affinity' | 'subject' | 'recency' | 'questions'
 * @param {Array}  subjects  needed only for the subject lens
 */
export function groupNotesByLens(notes, lens = 'affinity', subjects = []) {
  switch (lens) {
    case 'subject':   return groupBySubject(notes, subjects);
    case 'recency':   return groupByRecency(notes);
    case 'questions': return groupByQuestions(notes);
    case 'affinity':
    default:          return groupNotes(notes);
  }
}
