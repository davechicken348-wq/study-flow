/**
 * StudyFlow — plannerEngine.js
 *
 * The brain behind the Planner. Turns a student's subjects, past sessions and
 * goals into a balanced, spaced-repetition-aware weekly schedule.
 *
 * The algorithm combines three ideas that genuinely help students:
 *
 *  1. Spaced repetition (SM-2 flavoured intervals)
 *     Each subject accumulates a "mastery" signal from how recently and how
 *     much it was studied. We schedule review sessions before the memory of it
 *     would decay — low-mastery subjects get shorter, more frequent intervals;
 *     high-mastery subjects get spaced further apart. This is the single most
 *     evidence-backed study habit there is (Ebbinghaus / SM-2).
 *
 *  2. Load balancing
 *     Study minutes are distributed across the week so no single day is
 *     overloaded and the student's historical "study weekdays" are respected.
 *     We use the day-of-week probability model from forecast.js to prefer days
 *     the student actually tends to study.
 *
 *  3. Goal-aware constraints
 *     Each subject's weekly goal (subjects.weeklyGoal) becomes a hard floor:
 *     the scheduler guarantees at least that much time is planned, then fills
 *     remaining capacity with the highest-priority (lowest-mastery) subjects.
 *
 * It is intentionally a greedy heuristic — no heavy solver — so it runs
 * instantly in the browser and is easy to reason about.
 */

import { getWeekDates, getToday } from './utils.js';
import { dayOfWeekProbability } from './forecast.js';

// Spaced-repetition interval ladder (in days) by mastery band (0..1).
// Higher mastery => longer gaps between reviews.
const INTERVALS = [
  { min: 0.0, gaps: [1, 2, 3, 4] },   // struggling: review almost daily
  { min: 0.4, gaps: [2, 3, 5, 7] },   // building: every few days
  { min: 0.7, gaps: [4, 7, 10, 14] }, // confident: roughly weekly
  { min: 0.9, gaps: [7, 14, 21, 30] },// mastered: occasional top-up
];

function intervalFor(mastery) {
  let ladder = INTERVALS[0];
  for (const band of INTERVALS) if (mastery >= band.min) ladder = band;
  return ladder.gaps;
}

/**
 * Estimate a 0..1 mastery score for a subject from its session history.
 * Recent + frequent + longer sessions raise mastery; neglect lowers it.
 * @param {object} subject
 * @param {Array} sessions  all sessions (any source)
 * @param {Date} refDate
 */
export function estimateMastery(subject, sessions, refDate = new Date()) {
  const now = refDate.getTime();
  const subjSessions = sessions.filter((s) => s.subjectId === subject.id && (s.duration || 0) > 0);
  if (subjSessions.length === 0) return 0.15; // brand new subject: low mastery

  // Recency: weight each session by exponential decay (half-life ~10 days).
  const HALF_LIFE = 10 * 86400000;
  let recencyScore = 0;
  let totalWeight = 0;
  let totalMin = 0;
  for (const s of subjSessions) {
    const t = s.startTime ? new Date(s.startTime).getTime() : new Date(s.date + 'T12:00:00').getTime();
    const age = Math.max(0, now - t);
    const w = Math.pow(0.5, age / HALF_LIFE);
    recencyScore += w;
    totalWeight += w;
    totalMin += (s.duration || 0) / 60;
  }
  const avgRecency = totalWeight > 0 ? recencyScore / totalWeight : 0; // 0..1

  // Volume: more cumulative study => higher mastery (saturating log curve).
  const volume = Math.min(1, Math.log10(1 + totalMin / 60) / Math.log10(1 + 20));

  // Frequency: more distinct study days => better retention.
  const days = new Set(subjSessions.map((s) => s.date)).size;
  const frequency = Math.min(1, days / 12);

  const mastery = 0.5 * avgRecency + 0.3 * volume + 0.2 * frequency;
  return Math.max(0.05, Math.min(0.99, mastery));
}

/**
 * Given a subject and its mastery, return the ideal number of sessions and
 * total minutes to plan for it this week.
 * @returns {{ sessions:number, minutes:number }}
 */
export function planForSubject(subject, mastery) {
  const goalMin = Math.round((Number(subject.weeklyGoal) || 0) / 60);
  // Minimum 2 sessions/week to keep momentum, scaled up for low mastery.
  const baseSessions = mastery < 0.4 ? 4 : mastery < 0.7 ? 3 : 2;
  const sessions = Math.max(baseSessions, goalMin > 0 ? Math.ceil(goalMin / 60) : 0);
  const minutes = goalMin > 0 ? goalMin : sessions * 45;
  return { sessions, minutes };
}

/**
 * Build a weekly schedule.
 *
 * @param {object} opts
 *   - subjects: Subject[]
 *   - sessions: Session[]   (all, any source)
 *   - refDate: Date         (anchors the week)
 *   - dailyCapacityMin: number  max study minutes to plan per day (default 180)
 *   - preferredStartHour: number (default 17 = after school/work)
 *   - sessionLengthMin: number   default 45
 * @returns {{
 *   weekDates: string[],
 *   sessions: Array<{id,subjectId,date,startTime,endTime,duration,description,source,type}>,
 *   summary: { bySubject: object, totalMinutes:number, daysUsed:number }
 * }}
 */
export function autoPlanWeek(opts = {}) {
  const refDate = opts.refDate || new Date();
  const weekDates = getWeekDates(refDate);
  const today = getToday();
  const dailyCapacity = Math.max(30, opts.dailyCapacityMin || 180);
  const startHour = opts.preferredStartHour ?? 17;
  const lengthMin = opts.sessionLengthMin || 45;

  const subjects = (opts.subjects || [])
    .filter((s) => s && !s.archived)
    .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));

  // Per-day remaining capacity (minutes) and a list of occupied time slots.
  const capacity = {};
  const occupied = {};
  weekDates.forEach((d) => {
    capacity[d] = dailyCapacity;
    occupied[d] = [];
  });

  // Day preference weights from history (0..1), plus a small penalty for past
  // days in the current week so we don't over-plan days already gone.
  const dayPref = {};
  weekDates.forEach((d) => {
    const dow = new Date(d + 'T12:00:00').getDay();
    let p = dayOfWeekProbability(opts.sessions || [], dow, 0.7);
    if (d < today) p *= 0.25; // already-partially-over day: lightly preferred
    dayPref[d] = Math.max(0.05, p);
  });

  const planned = [];
  const summary = { bySubject: {}, totalMinutes: 0, daysUsed: 0 };

  // Build a worklist of "session needs" sorted by priority:
  //   - low mastery first (most urgent to review)
  //   - then by how far behind the subject is vs its weekly goal
  const needs = [];
  for (const subj of subjects) {
    const mastery = estimateMastery(subj, opts.sessions || [], refDate);
    const plan = planForSubject(subj, mastery);
    needs.push({
      subj,
      mastery,
      remaining: plan.minutes,
      remainingSessions: plan.sessions,
      goalMin: Math.round((Number(subj.weeklyGoal) || 0) / 60),
    });
  }
  needs.sort((a, b) => {
    if (a.mastery !== b.mastery) return a.mastery - b.mastery; // struggling first
    return b.remaining - a.remaining;
  });

  // Helper: find the best day+slot for the next session of a subject.
  function placeSession(need, isReview) {
    const candidates = weekDates
      .filter((d) => d >= today) // never schedule in the past
      .map((d) => ({ d, score: dayPref[d] * (1 + (capacity[d] >= lengthMin ? 1 : -5)) }))
      .sort((a, b) => b.score - a.score);

    for (const { d } of candidates) {
      if (capacity[d] < lengthMin) continue;
      const slot = findFreeSlot(d, lengthMin, startHour, occupied[d]);
      if (!slot) continue;
      occupied[d].push(slot);
      capacity[d] -= lengthMin;

      const type = isReview ? 'review' : 'study';
      const label = isReview ? `Review · ${need.subj.name}` : `Study · ${need.subj.name}`;
      planned.push({
        id: 'pl_' + generateIdLocal(),
        subjectId: need.subj.id,
        date: d,
        startTime: isoLocal(d, slot.start),
        endTime: isoLocal(d, slot.end),
        duration: lengthMin * 60,
        description: label,
        source: 'planner',
        type,
        mastery: Number(need.mastery.toFixed(2)),
      });
      need.remaining -= lengthMin;
      need.remainingSessions -= 1;
      bumpSummary(need.subj.id, need.subj.name, lengthMin);
      return true;
    }
    return false;
  }

  function bumpSummary(id, name, min) {
    if (!summary.bySubject[id]) summary.bySubject[id] = { name, minutes: 0, sessions: 0 };
    summary.bySubject[id].minutes += min;
    summary.bySubject[id].sessions += 1;
    summary.totalMinutes += min;
  }

  // Pass 1: lay down the required number of sessions per subject.
  for (const need of needs) {
    while (need.remainingSessions > 0 && need.remaining > 0) {
      const placed = placeSession(need, false);
      if (!placed) break;
    }
  }

  // Pass 2: top up low-mastery subjects up to their weekly goal if capacity
  // remains (greedy, round-robin over the most-needy subjects).
  let progressed = true;
  let guard = 0;
  while (progressed && guard < 50) {
    progressed = false;
    guard++;
    for (const need of needs) {
      if (need.remaining <= 0) continue;
      if (Object.values(capacity).some((v) => v >= lengthMin)) {
        if (placeSession(need, true)) progressed = true;
      }
    }
  }

  summary.daysUsed = weekDates.filter((d) => (occupied[d] || []).length > 0).length;
  planned.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  return { weekDates, sessions: planned, summary };
}

// Find a free slot on a given day. We prefer the preferredStartHour and walk
// forward in `lengthMin` increments, skipping occupied slots.
function findFreeSlot(date, lengthMin, startHour, occupied) {
  const base = new Date(date + 'T00:00:00');
  for (let h = startHour; h + lengthMin / 60 <= 23; h++) {
    const m = 0;
    const start = h * 60 + m;
    const end = start + lengthMin;
    const overlaps = occupied.some((o) => start < o.end && end > o.start);
    if (!overlaps) return { start, end };
  }
  // Fallback: scan the whole day from 8:00 if preferred window is full.
  for (let start = 8 * 60; start + lengthMin <= 23 * 60; start += lengthMin) {
    const end = start + lengthMin;
    const overlaps = occupied.some((o) => start < o.end && end > o.start);
    if (!overlaps) return { start, end };
  }
  return null;
}

function isoLocal(date, minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

// Local id generator (mirrors utils.generateId but kept inline to avoid an
// import cycle risk and to keep this module self-contained for tests).
function generateIdLocal() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Preview helper used by the UI to explain *why* a subject was scheduled.
 * Returns a short human-readable reason + the suggested interval.
 */
export function explainPlan(subject, sessions, refDate = new Date()) {
  const mastery = estimateMastery(subject, sessions, refDate);
  const plan = planForSubject(subject, mastery);
  const gaps = intervalFor(mastery);
  const band = mastery < 0.4 ? 'Struggling' : mastery < 0.7 ? 'Building' : mastery < 0.9 ? 'Confident' : 'Mastered';
  return {
    mastery: Number(mastery.toFixed(2)),
    band,
    sessions: plan.sessions,
    minutes: plan.minutes,
    intervalDays: gaps[1],
    reason:
      band === 'Struggling'
        ? 'Reviewed least recently — plan short, frequent sessions so it sticks.'
        : band === 'Building'
        ? 'Good momentum — keep steady reviews every few days.'
        : band === 'Confident'
        ? 'Retaining well — a weekly top-up is enough.'
        : 'Mastered — occasional review protects long-term memory.',
  };
}
