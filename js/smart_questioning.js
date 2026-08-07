/**
 * StudyFlow — smart_questioning.js
 *
 * The "smart_questioning" algorithm detects moments in a note where the writer
 * is expressing an open question, uncertainty, or a tentative idea, and turns
 * those moments into trackable reflection questions.
 *
 * Detection is a weighted heuristic over four signal families:
 *   1. Interrogative markers   — '?', question-word sentence starts
 *   2. Uncertainty lexicon     — "I'm not sure", "confused about", …
 *   3. Tentative hedges        — "maybe", "I think", "guess", …
 *   4. Contrast + question     — "but why", "however, can…"
 *
 * Each signal adds to a confidence score. Above THRESHOLD (and not already a
 * tracked question), the line is surfaced as a candidate.
 */

const SQ = (() => {
  const THRESHOLD = 1.0;

  const QUESTION_WORDS = [
    'what', 'why', 'how', 'when', 'where', 'who', 'whom', 'which',
    'can', 'could', 'would', 'should', 'do', 'does', 'did', 'is', 'are',
    'was', 'were', 'will', 'am', 'have', 'has', 'had',
  ];

  const UNCERTAINTY = [
    /i'?m not sure/i, /not sure (about|why|if|what|how)/i, /i don'?t understand/i,
    /don'?t understand/i, /confused (about|by|why|how)/i, /stuck on/i,
    /not certain/i, /unsure/i, /can'?t figure (out|why|how)/i, /no idea/i,
    /what if/i, /why does/i, /why do(es)?/i, /how come/i, /wonder(ing)? (why|how|if|what)/i,
  ];

  const HEDGES = [
    /\bmaybe\b/i, /\bi think\b/i, /\bi guess\b/i, /\bperhaps\b/i, /\bpossibly\b/i,
    /\bnot (100|entirely|totally) (sure|certain)\b/i, /\bseems (like|to)\b/i,
    /\bsort of\b/i, /\bkind of\b/i, /\bprobably\b/i,
  ];

  const CONTRAST = [/\bbut\b/i, /\bhowever\b/i, /\byet\b/i, /\balthough\b/i, /\bthough\b/i];

  function scoreLine(line) {
    const text = line.trim();
    if (!text) return { score: 0, hits: [] };

    const hits = [];
    let score = 0;

    // 1. Interrogative: trailing question mark
    if (/\?\s*$/.test(text)) {
      score += 1.0;
      hits.push('question-mark');
    }

    // 1b. Sentence starts with a question word
    const firstWord = text.replace(/^[-*]\s*/, '').split(/\s+/)[0].replace(/[^a-z]/gi, '').toLowerCase();
    if (QUESTION_WORDS.includes(firstWord)) {
      score += 0.9;
      hits.push('question-word');
    }

    // 2. Uncertainty lexicon
    for (const re of UNCERTAINTY) {
      if (re.test(text)) { score += 1.1; hits.push('uncertainty'); break; }
    }

    // 3. Tentative hedges
    for (const re of HEDGES) {
      if (re.test(text)) { score += 0.5; hits.push('hedge'); break; }
    }

    // 4. Contrast followed by an interrogative cue
    const hasContrast = CONTRAST.some((re) => re.test(text));
    if (hasContrast && /(\?|\b(why|how|what|when|who|can|do|does|is|are|will)\b)/i.test(text)) {
      score += 0.7;
      hits.push('contrast-question');
    }

    // Discount very short / trivial lines so "?" alone isn't over-valued
    if (text.replace(/[^a-z0-9]/gi, '').length < 6 && !/question-word|uncertainty/.test(hits.join(' '))) {
      score -= 0.5;
    }

    return { score, hits, firstWord };
  }

  /**
   * Analyze full note content and return candidate question lines.
   * @param {string} content
   * @param {Array} existingQuestions  questions already attached (with their line refs)
   * @returns {Array<{lineNumber:number, line:string, score:number, hits:string[]}>}
   */
  function analyze(content, existingQuestions = []) {
    const lines = (content || '').split('\n');
    const knownLineNums = new Set(
      (existingQuestions || [])
        .map((q) => q.lineNumber)
        .filter((n) => typeof n === 'number')
    );

    const candidates = [];
    lines.forEach((line, i) => {
      const { score, hits } = scoreLine(line);
      if (score >= THRESHOLD && !knownLineNums.has(i + 1)) {
        candidates.push({ lineNumber: i + 1, line: line.trim(), score, hits });
      }
    });
    return candidates;
  }

  function isQuestionLine(line) {
    return scoreLine(line).score >= THRESHOLD;
  }

  return { analyze, scoreLine, isQuestionLine, THRESHOLD, QUESTION_WORDS };
})();

export default SQ;
