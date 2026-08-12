// @ts-nocheck
import { generateId, getToday, localDateOf, formatDate, formatTime, formatDuration, formatDurationClock, getWeekDates, getStartOfWeek, escapeHtml, debounce, parseMarkdown } from './utils.js';
import Storage from './storage.js';
import SQ from './smart_questioning.js';
import { groupNotes, groupNotesByLens } from './affinityWeaving.js';
import { FocusEngine, PHASE, FOCUS_DEFAULTS } from './focusEngine.js';
import Settings from './settings.js';
import { ensureDailyQuest, isDailyQuest, buildDailyQuest } from './questSeed.js';
import { buildForecast, holtForecast, weeklyMinutesSeries } from './forecast.js';
import { autoPlanWeek, explainPlan, estimateMastery } from './plannerEngine.js';
import { playPhaseSound, unlockAudio } from './sounds.js';

function attachQuestionToggle(container) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const mark = e.target.closest('.question-inline-mark');
    if (!mark) return;
    e.preventDefault();
    const inline = mark.closest('.question-inline');
    if (inline) inline.classList.toggle('collapsed');
  });
}

const APP_VERSION = '2.0.0';

function attachQuestionTooltip({ container, tooltipEl, questions }) {
  if (document.body.contains(tooltipEl)) {
    tooltipEl.remove();
  }
  document.body.appendChild(tooltipEl);

  const showTooltip = (marker) => {
    const qid = marker.dataset.questionId;
    const q = questions.find(x => x.id === qid);
    if (!q) return;
    const answerText = q.answer ? escapeHtml(q.answer) : '<em>No answer yet</em>';
    tooltipEl.innerHTML = `<strong>Q:</strong> ${escapeHtml(q.text)}<br><strong>A:</strong> ${answerText}`;
    tooltipEl.classList.toggle('resolved', !!q.resolved);
    tooltipEl.style.display = 'block';
    const rect = marker.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    let top = rect.top - tooltipRect.height - 8;
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    if (top < 8) top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + tooltipRect.width > window.innerWidth - 8) left = window.innerWidth - tooltipRect.width - 8;
    tooltipEl.style.top = top + 'px';
    tooltipEl.style.left = left + 'px';
  };

  const hideTooltip = () => {
    tooltipEl.classList.remove('resolved');
    tooltipEl.style.display = 'none';
  };

  container.addEventListener('mouseover', (e) => {
    const marker = e.target.closest('.question-marker');
    if (marker) showTooltip(marker);
  });

  container.addEventListener('mouseout', (e) => {
    const marker = e.target.closest('.question-marker');
    if (marker) hideTooltip();
  });

  container.addEventListener('scroll', hideTooltip);
  return { showTooltip, hideTooltip };
}

const PRESET_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#64748b'];

const app = {
  engine: null,
  activeSettingsTab: null,

  async init() {
    await Settings.load();
    await this.ensureDailyQuest();
    this.initImageFallback();
    this.setupListeners();
    this.bindSettingsReactivity();
    this.bindSidebar();
    await this.restoreTimerState();
    this.initNotifications();
    this._currentPage = window.location.hash.slice(1) || 'dashboard';
    this.handleRoute();
  },

  bindSettingsReactivity() {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (Settings.get('theme') === 'system') Settings.set('theme', 'system'); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    }
    Settings.subscribe('noteOfflineMath', (on) => {
      if (on && 'caches' in window) {
        caches.open('studyflow-v6').then((c) => c.addAll([
          'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
          'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js',
          'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap',
        ]).catch(() => {})).catch(() => {});
        this.toast('Math & fonts cached for offline use', 'success');
      }
    });
    // Keep notification prefs mirrored into IndexedDB so the service worker
    // (which only has IndexedDB, not the app's localStorage settings blob)
    // reads the current values.
    const mirrorNotif = () => {
      const mirror = {
        notificationsEnabled: Settings.get('notificationsEnabled') ? 'true' : 'false',
        notifySessionReminders: Settings.get('notifySessionReminders') ? 'true' : 'false',
        notifyLeadTime: String(Settings.get('notifyLeadTime') || 15),
        notifyQuietStart: Settings.get('notifyQuietStart'),
        notifyQuietEnd: Settings.get('notifyQuietEnd'),
      };
      Object.entries(mirror).forEach(([k, v]) => Storage.setSetting(k, v).catch(() => {}));
    };
    ['notificationsEnabled', 'notifySessionReminders', 'notifyLeadTime', 'notifyQuietStart', 'notifyQuietEnd']
      .forEach((k) => Settings.subscribe(k, mirrorNotif));
    mirrorNotif();
  },

  // Keep the desktop sidebar's expand/collapse state in sync with the
  // `sidebarExpanded` setting: flip the root attribute (CSS handles layout),
  // and update the collapse button's icon + aria to reflect the current mode.
  bindSidebar() {
    const sync = () => {
      const expanded = !!Settings.get('sidebarExpanded');
      const btn = document.getElementById('sidebarCollapse');
      if (btn) {
        btn.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        btn.setAttribute('title', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        btn.classList.toggle('is-collapsed', !expanded);
      }
    };
    Settings.subscribe('sidebarExpanded', sync);
    sync();
  },

  handleImageError(img) {
    if (!img || img.dataset.fallbackApplied) return;
    img.dataset.fallbackApplied = '1';
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const stroke = isDark ? '#7c83a8' : '#c3c8e8';
    const label = (img.alt && img.alt.trim()) ? img.alt.trim() : '';
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="4"/>
        <path d="M8 12h8"/><path d="M12 8v8"/>
      </svg>`
    );
    img.src = `data:image/svg+xml,${svg}`;
    img.classList.add('img-fallback');
    if (label) img.alt = label;
    img.removeAttribute('onerror');
  },

  initImageFallback() {
    document.addEventListener('error', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG') this.handleImageError(t);
    }, true);
  },

  initTheme() {
    // Theme is now owned by Settings (applied on load). No-op kept for safety.
  },

  setTheme(theme) {
    return Settings.set('theme', theme);
  },

  setupListeners() {
    window.addEventListener('hashchange', () => this.handleRoute());
    // Persist the live timer whenever the tab is hidden or unloaded, so a
    // reload (or the PWA service worker) restores it instead of starting over.
    const snapshot = () => { if (this._currentPage === 'timer') this.persistEngine(); };
    window.addEventListener('pagehide', snapshot);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') snapshot(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModals();
    });

    // Sidebar toggle + backdrop
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('visible');
    });
    backdrop?.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('visible');
    });

    // Sidebar collapse / expand (desktop). Persisted via Settings; on mobile
    // the drawer is controlled by sidebarToggle instead.
    document.getElementById('sidebarCollapse')?.addEventListener('click', () => {
      const expanded = Settings.get('sidebarExpanded');
      Settings.set('sidebarExpanded', !expanded);
    });

    // Sidebar nav links
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        history.pushState(null, '', `#${page}`);
        this.handleRoute();
      });
    });

    // Bottom nav (mobile)
    document.querySelectorAll('.bottom-nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        history.pushState(null, '', `#${page}`);
        this.handleRoute();
      });
    });

    document.getElementById('installBtn')?.addEventListener('click', () => this.installPWA());
    document.getElementById('installDismiss')?.addEventListener('click', () => {
      document.getElementById('installPrompt').classList.add('hidden');
    });
  },

  async handleRoute() {
    const hash = window.location.hash.slice(1);

    const noteMatch = hash.match(/^note\/(.+)$/);
    if (noteMatch) {
      this.renderNote(noteMatch[1]);
      return;
    }

    const page = hash || 'dashboard';

    // Sync sidebar nav
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.page === hash);
    });
    // Sync bottom nav
    document.querySelectorAll('.bottom-nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.page === hash);
    });

    // Close sidebar on mobile
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (window.innerWidth < 769) {
      sidebar?.classList.remove('open');
      backdrop?.classList.remove('visible');
    }
    // Snapshot the timer before leaving it so a reload/return keeps progress.
    // (In-memory `app.engine` already survives hash navigation; this also
    // covers full page reloads where the engine object is lost.)
    if (this._currentPage === 'timer' && hash !== 'timer') {
      this.persistEngine();
    }
    // If we're returning to the timer with a restored/live engine, make sure
    // it is bound, configured from current Settings, and repainted — this
    // prevents it from appearing to "start over" when coming back.
    if (hash === 'timer' && this.engine && this.engine.phase !== PHASE.IDLE && this.engine.phase !== PHASE.COMPLETE) {
      this.bindEngine();
      this.engine.configure(await this.loadFocusConfig());
      this.engine.rehydrate();
    }

    const pages = {
      dashboard: () => this.renderDashboard(),
      subjects: () => this.renderSubjects(),
      planner: () => this.renderPlanner(),
      timer: () => this.renderTimer(),
      notes: () => this.renderNotes(),
      statistics: () => this.renderStatistics(),
      goals: () => this.renderGoals(),
      settings: () => this.renderSettings(),
    };
    const render = pages[hash] || pages.dashboard;
    this._currentPage = hash;
    document.getElementById('pageContent').innerHTML = '';
    render();
  },

  // Re-render the currently visible page so quest/dashboard panels reflect
  // progress changes (e.g. after a timer session completes). Avoids clobbering
  // an actively-running timer session.
  async refreshCurrentPage() {
    const hash = window.location.hash.slice(1) || 'dashboard';
    const liveTimer = this.engine && this.engine.isRunning()
      && this.engine.phase !== PHASE.IDLE && this.engine.phase !== PHASE.COMPLETE;
    if (hash === 'timer' && liveTimer) return; // don't disrupt a running session
    if (hash === 'note') return; // note view manages its own refresh
    this.handleRoute();
  },

  openModal(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const overlay = wrap.firstElementChild;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeModals();
    });
  },

  closeModals() {
    document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
  },

  toast(message, type = 'success', duration = 3000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  },

  congratsOverlay(message) {
    const imgs = [
      'assets/congrats_illustration/Being-Happy-2--Streamline-Barcelona.png',
      'assets/congrats_illustration/Graduation-1--Streamline-Barcelona.png',
      'assets/congrats_illustration/Showing-Pride-1--Streamline-Barcelona.png',
    ];
    const img = imgs[Math.floor(Math.random() * imgs.length)];
    this.openModal(`
      <div class="modal-overlay congrats-overlay">
        <div class="congrats-card">
          <img class="congrats-illo" src="${img}" alt="">
          <h2>Goal reached! 🎉</h2>
          <p class="muted">${escapeHtml(message)}</p>
          <button class="btn btn-primary" id="congratsClose">Awesome!</button>
        </div>
      </div>
    `);
    const overlay = document.querySelector('.congrats-overlay');
    const close = () => overlay?.remove();
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('congratsClose')?.addEventListener('click', close);
  },

  async renderDashboard() {
    const [subjects, sessions, goals, focusState] = await Promise.all([
      Storage.getAllSubjects(), Storage.getAllSessions(), Storage.getAllGoals(),
      Storage.getSetting('focusEngine'),
    ]);
    const today = getToday();
    const todaySessions = sessions.filter((s) => s.date === today);
    const todayTime = todaySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const weekDates = getWeekDates();
    const weekSessions = sessions.filter((s) => weekDates.includes(s.date));
    const weekTime = weekSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const streak = this.calculateStreak(sessions);
    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);
    const profile = Settings.questProfile();
    const info = Settings.questLevelInfo(profile.xp);
    const weekSet = new Set(weekDates);
    const el = document.getElementById('pageContent');
    const hour = new Date().getHours();
    let greeting = 'Good morning';
    if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
    else if (hour >= 17) greeting = 'Good evening';

    if (subjects.length === 0 && sessions.length === 0) {
      el.innerHTML = `
        <div class="dash-hero card dash-hero-onboard">
          <div class="dash-hero-text">
            <span class="dash-hero-badge">Get started</span>
            <h1>${escapeHtml(greeting)} 👋</h1>
            <p class="muted">Welcome to StudyFlow. Track sessions, plan your week, and hit your goals.</p>
            <button class="btn btn-primary mt" id="onboardingAddSubjectBtn">Add your first subject</button>
          </div>
          <div class="dash-hero-illo-wrap">
            <img class="dash-hero-illo" src="assets/illustrations/Start-Up-Team--Streamline-Bangalore.png" alt="">
          </div>
        </div>
      `;
      document.getElementById('onboardingAddSubjectBtn').addEventListener('click', () => this.showSubjectForm());
      return;
    }

    el.innerHTML = `
      <div class="dash-hero card">
        <div class="dash-hero-text">
          <h1>${escapeHtml(greeting)} 👋</h1>
          <p class="muted">Ready to focus? Here's your overview.</p>
        </div>
        <div class="dash-hero-illo-wrap">
          <img class="dash-hero-illo" src="assets/illustrations/Start-Up-Team--Streamline-Bangalore.png" alt="">
        </div>
      </div>
      <div class="grid grid-4 gap mt">
        <div class="card">
          <div class="stat-value">${formatDuration(todayTime)}</div>
          <div class="stat-label">Today's Study Time</div>
        </div>
        <div class="card">
          <div class="stat-value">${formatDuration(weekTime)}</div>
          <div class="stat-label">This Week</div>
        </div>
        <div class="card">
          <div class="stat-value">${streak} days</div>
          <div class="stat-label">Current Streak</div>
        </div>
        <div class="card">
          <div class="stat-value">${subjects.length}</div>
          <div class="stat-label">Total Subjects</div>
        </div>
      </div>

      <div class="dash-two-col">
      <div class="card">
        <div class="card-header flex justify-between items-center">
          <h2>Today's Plan</h2>
          <button class="btn btn-primary btn-sm" id="dashAddPlanBtn" aria-label="Add session">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </button>
        </div>
        ${todaySessions.filter((s) => s.source === 'planner').length === 0 ? `
          <div class="empty-state">
            <img class="empty-illo" src="assets/illustrations/Robot-Learning-From-Human--Streamline-Bangalore.png" alt="">
            <h3>No planned sessions today</h3>
            <p>Plan your study sessions in the Planner to see them here.</p>
          </div>` : `
          <div class="mt">
            ${todaySessions.filter((s) => s.source === 'planner').sort((a, b) => {
              if (!a.startTime) return 1;
              if (!b.startTime) return -1;
              return a.startTime.localeCompare(b.startTime);
            }).map((s) => {
              const subj = subjects.find((x) => x.id === s.subjectId);
              const start = s.startTime ? formatTime(s.startTime) : '';
              const end = s.endTime ? formatTime(s.endTime) : '';
              const now = new Date();
              const sessionStart = s.startTime ? new Date(s.startTime) : null;
              let timeLabel = '';
              if (sessionStart) {
                const diffMs = sessionStart.getTime() - now.getTime();
                const diffMin = Math.round(diffMs / 60000);
                if (diffMin > 0 && diffMin <= 60) timeLabel = `in ${diffMin}m`;
                else if (diffMin > 60) timeLabel = `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;
              }
              return `
                <div class="flex justify-between items-center mb-sm">
                  <div>
                    <div class="font-medium">${subj ? escapeHtml(subj.name) : 'Unknown'}</div>
                    <div class="muted text-sm">${start}${start && end ? ' - ' : ''}${end}${s.description ? ' · ' + escapeHtml(s.description) : ''}</div>
                  </div>
                  <span class="badge ${timeLabel ? 'badge-warning' : 'badge-success'}">${timeLabel || 'Scheduled'}</span>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>

      <div class="card">
        <div class="card-header flex justify-between items-center">
          <h2>Today's Sessions</h2>
          <button class="btn btn-primary btn-sm" id="dashAddSubjectBtn" aria-label="Add subject">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 4 21l.5-3.5L17 3z"/></svg>
          </button>
        </div>
          ${todaySessions.filter((s) => s.source === 'timer').length === 0 ? `
            <div class="empty-state">
              <img class="empty-illo" src="assets/illustrations/Development-Code-Learning-01--Streamline-Bangalore.png" alt="">
              <h3>No timer sessions yet today</h3>
              <p>Use the Timer to start tracking your study time.</p>
            </div>` : `
            <div class="mt">
              ${todaySessions.filter((s) => s.source === 'timer').map((s) => {
                const subj = subjects.find((x) => x.id === s.subjectId);
                // Prefer the live engine (source of truth while the app is open);
                // fall back to the persisted focusState for reloads.
                const liveEng = this.engine;
                const liveActive = liveEng && liveEng.sessionId === s.id && liveEng.phase !== PHASE.IDLE && liveEng.phase !== PHASE.COMPLETE;
                const persistedActive = focusState && focusState.sessionId === s.id && !focusState.closed
                  && focusState.phase !== 'idle' && focusState.phase !== 'complete';
                const isActive = liveActive || persistedActive;
                const paused = liveActive ? liveEng.paused : (focusState ? focusState.paused : false);
                const activeState = liveActive ? liveEng : focusState;
                let status, badge;
                if (s.endTime) {
                  status = formatDuration(s.duration || 0);
                  badge = 'badge-success';
                } else if (isActive && paused) {
                  status = 'Paused';
                  badge = 'badge-muted';
                } else if (isActive) {
                  const phase = activeState && activeState.phase === 'break' ? 'Break' : 'Focus';
                  const cfg = activeState && activeState.config;
                  const roundInfo = cfg && cfg.rounds > 1
                    ? ` · R${Math.min((activeState.round || 0) + 1, cfg.rounds)}/${cfg.rounds}` : '';
                  status = phase + roundInfo;
                  badge = 'badge-primary';
                } else {
                  status = 'In progress';
                  badge = 'badge-warning';
                }
                const goal = s.goalId ? goals.find((g) => g.id === s.goalId) : null;
                const subLabel = goal ? (subj ? subj.name + ' · ' : '') + (goal.label || goal.type)
                                      : (subj ? subj.name : 'Unknown');
                return `
                  <div class="flex justify-between items-center mb-sm">
                    <div>
                      <div class="font-medium">${escapeHtml(subLabel)}</div>
                      <div class="muted text-sm">${s.description ? escapeHtml(s.description) : ''}</div>
                    </div>
                    <span class="badge ${badge}">${status}</span>
                  </div>
                `;
              }).join('')}
            </div>
          `}
      </div>
      </div>

      ${(() => {
        if (!dailyGoal) return '';
        const isTask = dailyGoal.kind === 'task' && dailyGoal.metric;
        const pct = isTask
          ? Math.min(100, Math.round(((dailyGoal.progress || 0) / (dailyGoal.target || 1)) * 100))
          : Math.min(100, (todayTime / (dailyGoal.target * 3600)) * 100);
        const cur = isTask ? (dailyGoal.progress || 0) : todayTime;
        const tot = isTask ? (dailyGoal.target || 0) : dailyGoal.target * 3600;
        return `
        <div class="card mt">
          <div class="card-header flex justify-between items-center">
            <h2>Daily Quest</h2>
            <span class="flex gap-xs items-center">
              ${isTask ? `<button class="btn btn-ghost btn-sm" data-quest-how="${dailyGoal.metric}" data-quest-label="${escapeHtml(dailyGoal.label || '')}" aria-label="How to complete">How?</button>` : ''}
              <span class="badge badge-primary">+${dailyGoal.bonusXp || 0} XP</span>
            </span>
          </div>
          <p class="muted text-sm">${escapeHtml(dailyGoal.description || dailyGoal.label || '')}</p>
          <div class="progress-bar mt">
            <div class="progress-fill ${pct >= 100 ? 'success' : ''}" style="width: ${pct}%"></div>
          </div>
          <p class="muted text-center mt-sm">${isTask ? `${dailyGoal.progress || 0} / ${dailyGoal.target} ${dailyGoal.unit}` : `${formatDuration(cur)} / ${formatDuration(tot)}`}</p>
        </div>`;
      })()}

      ${(() => {
        const active = goals.filter((g) => g.type !== 'daily' && g.active);
        if (active.length === 0) return '';
        return `
        <div class="card mt">
          <div class="card-header flex justify-between items-center">
            <h2>Your Quests</h2>
            <a class="btn btn-ghost btn-sm" href="#goals" data-goto="goals">View all →</a>
          </div>
          <div class="dash-quests mt-sm">
            ${active.slice(0, 4).map((q) => {
              const pct = Math.min(100, Math.round(this.questProgress(q, sessions, weekSet) * 100));
              const isTracking = (this.engine && this.engine.goalId === q.id) || this.pendingGoalId === q.id;
              return `
                <div class="dash-quest-row">
                  <span class="font-medium truncate">${escapeHtml(q.label || 'Quest')}${isTracking ? ' <span class="badge badge-success">Tracking</span>' : ''}</span>
                  <div class="progress-bar" style="flex:1;margin:0 8px">
                    <div class="progress-fill ${pct >= 100 ? 'success' : ''}" style="width:${pct}%"></div>
                  </div>
                  <span class="muted text-xs">${pct}%</span>
                </div>`;
            }).join('')}
          </div>
        </div>`;
      })()}

      <div class="card quest-hero quest-hero-compact mt">
        <div class="quest-hero-avatar" aria-hidden="true">
          <div class="quest-level-badge">${info.level}</div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="6"/><path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5"/>
          </svg>
        </div>
        <div class="quest-hero-body">
          <div class="quest-hero-top">
            <div>
              <div class="quest-rank">${this.questRankTitle(info.level)}</div>
              <div class="quest-level">Level ${info.level} · 🔥 ${streak}d</div>
            </div>
            <a class="btn btn-ghost btn-sm" href="#goals" data-goto="goals">Quests →</a>
          </div>
          <div class="quest-xp mt-sm">
            <div class="progress-bar quest-xp-bar">
              <div class="progress-fill" style="width:${info.pct}%"></div>
            </div>
            <div class="quest-xp-label">${info.into} / ${info.span} XP · ${info.toNext} to next level</div>
          </div>
        </div>
      </div>
    `;
    document.getElementById('dashAddSubjectBtn')?.addEventListener('click', () => this.showSubjectForm());
    document.getElementById('dashAddPlanBtn')?.addEventListener('click', () => this.showSessionForm({ date: getToday() }));
    el.querySelectorAll('[data-quest-how]').forEach((b) => {
      b.addEventListener('click', () => this.showQuestHowTo(b.dataset.questHow, b.dataset.questLabel));
    });
  },

  async renderSubjects() {
    const [subjects, sessions] = await Promise.all([
      Storage.getAllSubjects(), Storage.getAllSessions(),
    ]);
    const el = document.getElementById('pageContent');

    const weekDates = getWeekDates();
    const weekSet = new Set(weekDates);
    const active = this.orderSubjects(subjects.filter((s) => !s.archived));
    const archived = this.orderSubjects(subjects.filter((s) => s.archived));

    el.innerHTML = `
      <div class="page-header flex justify-between items-center page-header-inline">
        <h1>Subjects</h1>
        <div class="flex gap-xs items-center">
          ${archived.length > 0 ? `<span class="subjects-archived-badge" title="${archived.length} archived subject${archived.length > 1 ? 's' : ''}">${archived.length} archived</span>` : ''}
          <button class="btn btn-primary btn-sm" id="addSubjectBtn" aria-label="Add subject">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add subject
          </button>
        </div>
      </div>
      ${(active.length === 0 && archived.length === 0) ? `
        <div class="empty-state card mt empty-state-lg">
          <img class="empty-illo" src="assets/illustrations/Education-Online-Learning-02--Streamline-Bangalore.png" alt="">
          <h3>No subjects yet</h3>
          <p>Add your first subject to start organising your study sessions.</p>
        </div>` : `
        <div class="subjects-toolbar mt flex items-center justify-between" id="subjectsToolbar">
          <p class="muted text-sm" id="subjectsOrderHint">${active.length === 0 ? 'No active subjects — everything is archived.' : 'Drag cards to reorder. Pinned subjects stay on top.'}</p>
          <button class="btn btn-ghost btn-sm" id="toggleArchivedBtn" aria-pressed="false">${archived.length > 0 ? `Show archived (${archived.length})` : 'Show archived'}</button>
        </div>
        ${active.length > 0 ? `
          <div class="grid grid-2 gap mt" id="subjectsGrid">
            ${active.map((s) => this.subjectCardHtml(s, sessions, weekSet)).join('')}
          </div>
        ` : `
          <div class="empty-state card mt">
            <img class="empty-illo" src="assets/illustrations/Drawing-Painting--Streamline-Bangalore.png" alt="">
            <h3>No active subjects</h3>
            <p>Everything is archived. Use “Show archived” below to restore one.</p>
          </div>
        `}
          <div id="archivedWrap" class="hidden mt">
            <h3 class="muted text-sm" style="margin:24px 0 12px">Archived</h3>
            ${archived.length > 0 ? `
              <div class="grid grid-2 gap">
                ${archived.map((s) => this.subjectCardHtml(s, sessions, weekSet)).join('')}
              </div>
            ` : `
              <div class="empty-state card">
                <img class="empty-illo" src="assets/illustrations/No-Drafts-01--Streamline-Bangalore.png" alt="">
                <h3>No archived subjects</h3>
                <p>Archive a subject to tuck it away without losing its sessions and notes.</p>
              </div>
            `}
          </div>
      `}
    `;

    document.getElementById('addSubjectBtn')?.addEventListener('click', () => this.showSubjectForm());
    el.querySelectorAll('[data-action="edit-subject"]').forEach((b) => {
      b.addEventListener('click', () => this.showSubjectForm(subjects.find((s) => s.id === b.dataset.id)));
    });
    el.querySelectorAll('[data-action="delete-subject"]').forEach((b) => {
      b.addEventListener('click', () => this.deleteSubject(b.dataset.id));
    });
    el.querySelectorAll('[data-action="pin-subject"]').forEach((b) => {
      b.addEventListener('click', () => this.togglePinSubject(b.dataset.id));
    });
    el.querySelectorAll('[data-action="archive-subject"]').forEach((b) => {
      b.addEventListener('click', () => this.toggleArchiveSubject(b.dataset.id));
    });
    this.initSubjectDrag(el);
    const toggleArchived = document.getElementById('toggleArchivedBtn');
    toggleArchived?.addEventListener('click', () => {
      const wrap = document.getElementById('archivedWrap');
      const hidden = wrap.classList.toggle('hidden');
      toggleArchived.setAttribute('aria-pressed', String(!hidden));
      toggleArchived.textContent = hidden ? 'Show archived' : 'Hide archived';
    });
  },

  orderSubjects(subjects) {
    const active = subjects.filter((s) => !s.archived);
    const archived = subjects.filter((s) => s.archived);
    const sortActive = (a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      const ao = typeof a.order === 'number' ? a.order : 9999;
      const bo = typeof b.order === 'number' ? b.order : 9999;
      if (ao !== bo) return ao - bo;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    };
    return [...active.sort(sortActive), ...archived.sort(sortActive)];
  },

  subjectCardHtml(s, sessions, weekSet) {
    const count = sessions.filter((x) => x.subjectId === s.id).length;
    const total = sessions.filter((x) => x.subjectId === s.id).reduce((sum, x) => sum + (x.duration || 0), 0);
    const weekTotal = sessions
      .filter((x) => x.subjectId === s.id && x.date && weekSet.has(x.date))
      .reduce((sum, x) => sum + (x.duration || 0), 0);
    const goal = Number(s.weeklyGoal) || 0;
    const pct = goal > 0 ? Math.min(100, Math.round((weekTotal / goal) * 100)) : 0;
    const goalClass = pct >= 100 ? 'success' : (pct >= 60 ? '' : 'warning');

    const iconSrc = s.icon
      ? `assets/subject_illustrations/${s.icon}`
      : 'assets/subject_illustrations/Education-Graduation-01--Streamline-Bangalore.png';

    return `
      <div class="card subject-card ${s.archived ? 'is-archived' : ''} ${s.pinned ? 'is-pinned' : ''}" style="--subj: ${escapeHtml(s.color)}" draggable="${!s.archived}" data-id="${s.id}">
        <div class="subject-card-top">
          <div class="subject-avatar"><img src="${iconSrc}" alt="${escapeHtml(s.name || 'Subject')}"></div>
          <div class="flex gap-xs">
            <button class="btn btn-ghost btn-sm" data-action="pin-subject" data-id="${s.id}" aria-label="${s.pinned ? 'Unpin' : 'Pin'}" title="${s.pinned ? 'Unpin' : 'Pin'}">
              <svg viewBox="0 0 24 24" fill="${s.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm" data-action="edit-subject" data-id="${s.id}" aria-label="Edit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 4 21l.5-3.5L17 3z"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm" data-action="archive-subject" data-id="${s.id}" aria-label="${s.archived ? 'Restore' : 'Archive'}" title="${s.archived ? 'Restore' : 'Archive'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            </button>
            <button class="btn btn-danger btn-sm" data-action="delete-subject" data-id="${s.id}" aria-label="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>
        <h3 class="truncate">${escapeHtml(s.name)}</h3>
        <p class="muted text-sm subject-desc">${escapeHtml(s.description || 'No description')}</p>
        <div class="subject-meta">
          <span class="subject-chip">${count} sessions</span>
          <span class="subject-chip">${formatDuration(total)}</span>
        </div>
        ${goal > 0 ? `
        <div class="subject-goal mt">
          <div class="flex justify-between text-xs muted" style="margin-bottom:6px">
            <span>Weekly goal</span>
            <span>${formatDuration(weekTotal)} / ${formatDuration(goal)}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill ${goalClass}" style="width:${pct}%"></div></div>
        </div>` : ''}
      </div>
    `;
  },

  initSubjectDrag(root) {
    const grid = root.querySelector('#subjectsGrid');
    if (!grid) return;
    let dragId = null;
    grid.querySelectorAll('.subject-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        dragId = card.dataset.id;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        dragId = null;
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragId || card.dataset.id === dragId) return;
        const dragging = grid.querySelector('.dragging');
        if (!dragging) return;
        const rect = card.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        grid.insertBefore(dragging, after ? card.nextSibling : card);
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        this.persistSubjectOrder(grid);
      });
    });
  },

  async persistSubjectOrder(grid) {
    const active = Array.from(grid.querySelectorAll('.subject-card'));
    const ids = active.map((c) => c.dataset.id);
    const all = await Storage.getAllSubjects();
    ids.forEach((id, i) => {
      const s = all.find((x) => x.id === id);
      if (s) s.order = i;
    });
    await Promise.all(all.map((s) => Storage.saveSubject(s)));
  },

  async togglePinSubject(id) {
    const s = await Storage.getSubject(id);
    if (!s) return;
    s.pinned = !s.pinned;
    await Storage.saveSubject(s);
    this.toast(s.pinned ? 'Subject pinned' : 'Subject unpinned', 'success');
    this.renderSubjects();
  },

  async toggleArchiveSubject(id) {
    const s = await Storage.getSubject(id);
    if (!s) return;
    s.archived = !s.archived;
    await Storage.saveSubject(s);
    this.toast(s.archived ? 'Subject archived' : 'Subject restored', 'success');
    this.renderSubjects();
  },

  async showSubjectForm(subject) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!subject;
    const data = subject || { id: generateId(), name: '', description: '', color: PRESET_COLORS[0], icon: '', weeklyGoal: 0 };

    const icons = [
      'Education-Graduation-01--Streamline-Bangalore.png',
      'Education-Student-Active-01--Streamline-Bangalore.png',
      'Education-Online-Exams-Tests-01--Streamline-Bangalore.png',
      'Astronaut--Streamline-Bangalore.png',
      'Development-Code-Learning-01--Streamline-Bangalore.png',
      'Qa-Engineer-2--Streamline-Bangalore.png',
      'Design-Design-Thinking-01--Streamline-Bangalore.png',
      'Content-Creation-2--Streamline-Bangalore.png',
      'Content-Creation-Writing--Streamline-Bangalore.png',
      'Business-Go-To-Market-Strategy-01--Streamline-Bangalore.png',
      'Collaboration--Streamline-Bangalore.png',
      'Working-Together--Streamline-Bangalore.png',
      'Sharing-Ideas-2--Streamline-Bangalore.png',
      'Users-People-Trophy-Awards-01--Streamline-Bangalore.png',
      'Be-Patient--Streamline-Bangalore.png',
      'Users-People-Protect-Privacy-01--Streamline-Bangalore.png',
    ];
    const ICON_BASE = 'assets/subject_illustrations/';

    const goalTotalMin = data.weeklyGoal ? Math.round(data.weeklyGoal / 60) : 0;
    const goalHours = Math.floor(goalTotalMin / 60);
    const goalMins = goalTotalMin % 60;
    const previewIcon = data.icon || 'Education-Graduation-01--Streamline-Bangalore.png';
    const previewColor = data.color || PRESET_COLORS[0];

    this.openModal(`
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header"><h2>${isEdit ? 'Edit' : 'Add'} Subject</h2></div>
          <form id="subjectForm" class="p">
            <input type="hidden" id="subjectId" value="${data.id}">
            <div class="form-group">
              <label>Name</label>
              <input type="text" id="subjectName" required value="${data.name}">
            </div>
            <div class="form-group">
              <label>Description</label>
              <textarea id="subjectDesc">${data.description || ''}</textarea>
            </div>

            <div class="subject-form-preview">
              <div class="card subject-card" id="subjectPreview" style="--subj: ${escapeHtml(previewColor)}">
                <div class="subject-card-top">
                  <div class="subject-avatar"><img id="previewIconImg" src="${ICON_BASE}${previewIcon}" alt=""></div>
                </div>
                <h3 class="truncate" id="previewName">${escapeHtml(data.name || 'Subject name')}</h3>
                <p class="muted text-sm subject-desc" id="previewDesc">${escapeHtml(data.description || 'No description')}</p>
              </div>
            </div>

            <div class="form-group">
              <label>Icon</label>
              <div class="icon-grid mt">
                ${icons.map((ic) => `
                  <div class="icon-swatch ${previewIcon === ic ? 'selected' : ''}" data-icon="${ic}" title="${ic}">
                    <img src="${ICON_BASE}${ic}" alt="">
                  </div>
                `).join('')}
              </div>
              <input type="hidden" id="subjectIcon" value="${previewIcon}">
            </div>

            <div class="form-group">
              <label>Weekly goal</label>
              <div class="goal-inputs">
                <div class="form-group">
                  <label class="text-xs muted">Hours</label>
                  <input type="number" id="subjectGoalH" min="0" step="1" value="${goalHours}" placeholder="0">
                </div>
                <div class="form-group">
                  <label class="text-xs muted">Minutes</label>
                  <input type="number" id="subjectGoalM" min="0" max="59" step="5" value="${goalMins}" placeholder="0">
                </div>
              </div>
              <span class="muted text-xs">Leave both at 0 for no goal.</span>
            </div>

            <div class="form-group">
              <label>Color</label>
              <div class="color-picker mt">
                ${PRESET_COLORS.map((c) => `
                  <div class="color-swatch ${previewColor === c ? 'selected' : ''}" data-color="${c}" style="background: ${c}"></div>
                `).join('')}
                <div class="color-swatch custom-swatch ${!PRESET_COLORS.includes(previewColor) ? 'selected' : ''}" title="Custom color">
                  <input type="color" id="subjectCustomColor" value="${previewColor}">
                </div>
              </div>
              <input type="hidden" id="subjectColor" value="${previewColor}">
            </div>

            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    let selectedColor = previewColor;
    let selectedIcon = previewIcon;
    const colorInput = document.getElementById('subjectColor');
    const iconInput = document.getElementById('subjectIcon');
    const preview = document.getElementById('subjectPreview');
    const previewName = document.getElementById('previewName');
    const previewDesc = document.getElementById('previewDesc');
    const previewIconImg = document.getElementById('previewIconImg');

    const syncPreview = () => {
      preview.style.setProperty('--subj', selectedColor);
      previewName.textContent = document.getElementById('subjectName').value.trim() || 'Subject name';
      previewDesc.textContent = document.getElementById('subjectDesc').value.trim() || 'No description';
      previewIconImg.src = ICON_BASE + selectedIcon;
    };

    document.getElementById('subjectName').addEventListener('input', syncPreview);
    document.getElementById('subjectDesc').addEventListener('input', syncPreview);

    document.querySelectorAll('.color-swatch:not(.custom-swatch)').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        swatch.classList.add('selected');
        selectedColor = swatch.dataset.color;
        colorInput.value = selectedColor;
        syncPreview();
      });
    });

    const customInput = document.getElementById('subjectCustomColor');
    const customSwatch = customInput.closest('.color-swatch');
    customInput.addEventListener('input', () => {
      document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      customSwatch.classList.add('selected');
      selectedColor = customInput.value;
      colorInput.value = selectedColor;
      customSwatch.style.background = selectedColor;
      syncPreview();
    });

    document.querySelectorAll('.icon-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.icon-swatch').forEach((s) => s.classList.remove('selected'));
        swatch.classList.add('selected');
        selectedIcon = swatch.dataset.icon;
        iconInput.value = selectedIcon;
        syncPreview();
      });
    });

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('subjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('subjectId').value;
      const name = document.getElementById('subjectName').value.trim();
      const desc = document.getElementById('subjectDesc').value.trim();
      const color = colorInput.value;
      const h = parseInt(document.getElementById('subjectGoalH').value, 10) || 0;
      const m = parseInt(document.getElementById('subjectGoalM').value, 10) || 0;
      const goalMin = h * 60 + m;
      if (!name) return this.toast('Name is required', 'error');
      const existing = id ? subjects.find((s) => s.id === id) : null;
      const subj = { ...existing, id, name, description: desc, color, icon: iconInput.value, weeklyGoal: goalMin * 60 };
      if (existing) {
        if (!subj.createdAt) subj.createdAt = existing.createdAt;
        if (typeof subj.order !== 'number') subj.order = existing.order;
        subj.pinned = !!existing.pinned;
        subj.archived = !!existing.archived;
      }
      Storage.saveSubject(subj).then(() => {
        this.toast(isEdit ? 'Subject updated' : 'Subject added', 'success');
        this.closeModals();
        this.renderSubjects();
      });
    });
  },

  async deleteSubject(id) {
    if (!confirm('Delete this subject? All associated sessions and notes will also be deleted.')) return;
    await Storage.deleteSubject(id);
    this.toast('Subject deleted', 'success');
    this.renderSubjects();
  },

  async renderPlanner(refDate) {
    const [sessions, subjects] = await Promise.all([
      Storage.getAllSessions(), Storage.getAllSubjects(),
    ]);
    const weekDates = getWeekDates(refDate);
    const el = document.getElementById('pageContent');

    const weekSet = new Set(weekDates);
    const plannedCount = sessions.filter((s) => weekSet.has(s.date) && s.source === 'planner').length;

    el.innerHTML = `
      <div class="page-header flex justify-between items-center page-header-inline">
        <div>
          <h1>Planner</h1>
          <p class="muted">Week of ${formatDate(getStartOfWeek(refDate).toISOString())}</p>
        </div>
        <div class="flex gap-xs items-center">
          <button class="btn btn-ghost btn-sm" id="plannerClearBtn" aria-label="Clear plan">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            Clear
          </button>
          <button class="btn btn-primary btn-sm" id="plannerAutoBtn" aria-label="Auto-plan week">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>
            Auto-plan week
          </button>
        </div>
      </div>

      ${this.plannerPriorityHtml(subjects, sessions, refDate)}

      <div class="grid grid-7 gap-sm mt">
        ${weekDates.map((date) => {
          const daySessions = sessions.filter((s) => s.date === date && s.source !== 'timer').sort((a, b) => {
            if (!a.startTime) return 1;
            if (!b.startTime) return -1;
            return a.startTime.localeCompare(b.startTime);
          });
          const isToday = date === getToday();
          const d = new Date(date + 'T12:00:00');
          const dayName = d.toLocaleDateString(Settings.locale(), { weekday: 'short' });
          const dayNum = d.getDate();
          const dayTotal = Math.round(daySessions.reduce((sum, s) => sum + (s.duration || 0), 0) / 60);
          return `
            <div class="planner-day ${isToday ? 'today' : ''}">
              <div class="planner-day-header">
                <div class="planner-day-date">${dayNum}</div>
                <div>${dayName}</div>
              </div>
              ${dayTotal > 0 ? `<div class="planner-day-total">${dayTotal}m</div>` : ''}
              <div class="flex flex-col gap-xs mt-sm">
                ${daySessions.length === 0 ? '<p class="muted text-sm">No sessions</p>' : daySessions.map((s) => {
                  const subj = subjects.find((x) => x.id === s.subjectId);
                  const start = s.startTime ? formatTime(s.startTime) : '';
                  const end = s.endTime ? formatTime(s.endTime) : '';
                  const type = s.type || 'study';
                  const mastery = typeof s.mastery === 'number' ? s.mastery : (subj ? Number(estimateMastery(subj, sessions, refDate).toFixed(2)) : null);
                  const typeLabel = type === 'review' ? 'Review' : 'Study';
                  return `
                    <div class="planner-session planner-session-${type}" style="--subj: ${subj ? escapeHtml(subj.color) : 'var(--accent)'}">
                      <div class="planner-session-name">${subj ? escapeHtml(subj.name) : 'Unknown'}</div>
                      <div class="planner-session-time">${start}${start && end ? ' - ' : ''}${end}</div>
                      <div class="planner-session-meta">
                        <span class="planner-tag planner-tag-${type}">${typeLabel}</span>
                        ${mastery != null ? `<span class="planner-mastery" title="Mastery ${Math.round(mastery * 100)}%">${this.masteryDots(mastery)}</span>` : ''}
                      </div>
                      <div class="planner-session-actions flex gap-xs mt-sm">
                        <button class="btn btn-ghost btn-sm" data-action="edit-planner-session" data-id="${s.id}" aria-label="Edit">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 4 21l.5-3.5L17 3z"/></svg>
                        </button>
                        <button class="btn btn-danger btn-sm" data-action="delete-planner-session" data-id="${s.id}" aria-label="Delete">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        </button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
              <button class="btn btn-ghost btn-sm btn-block mt-sm" data-action="add-session-day" data-date="${date}" aria-label="Add session">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
            </div>
          `;
        }).join('')}
      </div>
      ${plannedCount === 0 ? `
        <div class="planner-hint card mt">
          <img class="empty-illo" src="assets/illustrations/Robot-Learning-From-Human--Streamline-Bangalore.png" alt="">
          <div>
            <h3>Let the planner do the work</h3>
            <p class="muted">Hit <strong>Auto-plan week</strong> and StudyFlow spaces out your subjects using spaced-repetition — reviewing the ones you're about to forget, balancing the load, and hitting each subject's weekly goal.</p>
          </div>
        </div>` : ''}
    `;

    document.getElementById('plannerAutoBtn')?.addEventListener('click', () => this.runAutoPlan(refDate));
    document.getElementById('plannerClearBtn')?.addEventListener('click', () => this.clearPlan(refDate));
    el.querySelectorAll('[data-action="add-session-day"]').forEach((b) => {
      b.addEventListener('click', () => this.showSessionForm({ date: b.dataset.date }));
    });
    el.querySelectorAll('[data-action="edit-planner-session"]').forEach((b) => {
      b.addEventListener('click', async () => {
        const s = sessions.find((x) => x.id === b.dataset.id);
        if (s) await this.showSessionForm(s);
      });
    });
    el.querySelectorAll('[data-action="delete-planner-session"]').forEach((b) => {
      b.addEventListener('click', () => this.deleteSession(b.dataset.id));
    });
  },

  // Priority panel that explains, per subject, why the auto-planner would
  // schedule it (driven by the same engine the auto-plan uses).
  plannerPriorityHtml(subjects, sessions, refDate) {
    const active = subjects.filter((s) => !s.archived);
    if (active.length === 0) return '';
    const rows = active
      .map((s) => ({ s, info: explainPlan(s, sessions, refDate) }))
      .sort((a, b) => a.info.mastery - b.info.mastery);
    return `
      <div class="card planner-priority mt">
        <div class="card-header flex justify-between items-center">
          <h2>This week's focus</h2>
          <span class="muted text-sm">Spaced by mastery</span>
        </div>
        <div class="planner-priority-list">
          ${rows.map(({ s, info }) => {
            const goalMin = Math.round((Number(s.weeklyGoal) || 0) / 60);
            const pct = goalMin > 0 ? Math.min(100, Math.round((info.minutes / goalMin) * 100)) : 100;
            return `
              <div class="planner-priority-row" style="--subj: ${escapeHtml(s.color)}">
                <div class="planner-priority-main">
                  <span class="planner-priority-name">${escapeHtml(s.name)}</span>
                  <span class="planner-mastery" title="Mastery ${Math.round(info.mastery * 100)}%">${this.masteryDots(info.mastery)}</span>
                  <span class="badge ${info.band === 'Struggling' ? 'badge-warning' : info.band === 'Mastered' ? 'badge-success' : 'badge-primary'}">${info.band}</span>
                </div>
                <div class="planner-priority-meta muted text-xs">${info.sessions} sessions · ${info.minutes}m planned · review every ~${info.intervalDays}d</div>
                ${goalMin > 0 ? `
                  <div class="progress-bar planner-priority-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  },

  masteryDots(mastery) {
    const filled = Math.round(Math.max(0, Math.min(1, mastery)) * 5);
    let html = '<span class="mastery-dots">';
    for (let i = 0; i < 5; i++) html += `<i class="${i < filled ? 'on' : ''}"></i>`;
    html += '</span>';
    return html;
  },

  async runAutoPlan(refDate) {
    const [sessions, subjects] = await Promise.all([
      Storage.getAllSessions(), Storage.getAllSubjects(),
    ]);
    const result = autoPlanWeek({ subjects, sessions, refDate });
    if (result.sessions.length === 0) {
      this.toast('Add subjects with weekly goals first', 'error');
      return;
    }
    // Replace existing planner-generated sessions for the week, keep timer ones.
    const weekSet = new Set(result.weekDates);
    const toDelete = sessions.filter((s) => weekSet.has(s.date) && s.source === 'planner');
    await Promise.all(toDelete.map((s) => Storage.deleteSession(s.id)));
    await Promise.all(result.sessions.map((s) => Storage.saveSession(s)));
    this.toast(`Planned ${result.sessions.length} sessions · ${Math.round(result.summary.totalMinutes / 60)}h this week`, 'success');
    this.renderPlanner(refDate);
  },

  async clearPlan(refDate) {
    const sessions = await Storage.getAllSessions();
    const weekSet = new Set(getWeekDates(refDate));
    const toDelete = sessions.filter((s) => weekSet.has(s.date) && s.source === 'planner');
    if (toDelete.length === 0) { this.toast('No planned sessions to clear', 'success'); return; }
    if (!confirm(`Remove ${toDelete.length} planned session${toDelete.length > 1 ? 's' : ''}?`)) return;
    await Promise.all(toDelete.map((s) => Storage.deleteSession(s.id)));
    this.toast('Plan cleared', 'success');
    this.renderPlanner(refDate);
  },

  async showSessionForm(session) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!(session && session.id);
    const data = (session && session.id) ? session : { id: generateId(), subjectId: '', date: session?.date || getToday(), startTime: '', endTime: '', description: '', source: 'planner', type: 'study' };
    const sessType = data.type || (data.source === 'planner' ? 'study' : 'study');

    this.openModal(`
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header"><h2>${isEdit ? 'Edit' : 'Add'} Session</h2></div>
          <form id="sessionForm" class="p">
            <input type="hidden" id="sessionId" value="${data.id}">
            <div class="form-group">
              <label>Subject</label>
              <select id="sessionSubject">
                <option value="">Select subject</option>
                ${subjects.map((s) => `<option value="${s.id}" ${data.subjectId === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Date</label>
              <input type="date" id="sessionDate" required value="${data.date || getToday()}">
            </div>
            <div class="form-group">
              <label>Start Time</label>
              <input type="time" id="sessionStart" required value="${data.startTime ? this._isoToLocalTime(data.startTime) : ''}">
            </div>
            <div class="form-group">
              <label>End Time</label>
              <input type="time" id="sessionEnd" value="${data.endTime ? this._isoToLocalTime(data.endTime) : ''}">
            </div>
            <div class="form-group">
              <label>Description</label>
              <textarea id="sessionDesc">${data.description || ''}</textarea>
            </div>
            <div class="form-group">
              <label>Session type</label>
              <div class="seg-toggle" id="sessionTypeToggle">
                <button type="button" class="seg-btn ${sessType === 'study' ? 'active' : ''}" data-type="study">Study</button>
                <button type="button" class="seg-btn ${sessType === 'review' ? 'active' : ''}" data-type="review">Review</button>
              </div>
              <input type="hidden" id="sessionType" value="${sessType}">
              <span class="muted text-xs">Review sessions are spaced-repetition top-ups the planner suggests for subjects you're about to forget.</span>
            </div>
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());

    const typeToggle = document.getElementById('sessionTypeToggle');
    const typeInput = document.getElementById('sessionType');
    typeToggle?.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        typeToggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        typeInput.value = btn.dataset.type;
      });
    });

    document.getElementById('sessionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('sessionId').value;
      const subjectId = document.getElementById('sessionSubject').value;
      const date = document.getElementById('sessionDate').value;
      const startVal = document.getElementById('sessionStart').value;
      const endVal = document.getElementById('sessionEnd').value;
      const desc = document.getElementById('sessionDesc').value.trim();
      const type = document.getElementById('sessionType').value;

      if (!subjectId || !date || !startVal) return this.toast('Please fill required fields', 'error');
      if (endVal && endVal <= startVal) return this.toast('End time must be after start time', 'error');

      const startTime = `${date}T${startVal}:00`;
      const endTime = endVal ? `${date}T${endVal}:00` : null;
      const duration = endTime ? Math.floor((new Date(endTime) - new Date(startTime)) / 1000) : null;

      const existing = id ? (await Storage.getSession(id)) : null;
      const sess = { ...existing, id, subjectId, date, startTime, endTime, duration, description: desc, type, paused: false, source: existing?.source || 'planner' };
      await Storage.saveSession(sess);
      this.checkGoalCelebrations();
      this.toast(isEdit ? 'Session updated' : 'Session added', 'success');
      this.closeModals();
      this.renderPlanner(new Date(date + 'T12:00:00'));
    });
  },

  _isoToLocalTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  },

  async deleteSession(id) {
    if (!confirm('Delete this session?')) return;
    await Storage.deleteSession(id);
    this.toast('Session deleted', 'success');
    const hash = window.location.hash.slice(1);
    if (hash === 'planner') this.renderPlanner();
    else if (hash === 'dashboard') this.renderDashboard();
  },

  async renderTimer() {
    const subjects = await Storage.getAllSubjects();
    const goals = await Storage.getAllGoals();
    const linkableGoals = goals.filter((g) => g.active && g.type !== 'daily');
    const el = document.getElementById('pageContent');

    if (!this.engine) this.engine = new FocusEngine();
    this._goalsCache = goals;
    const eng = this.engine;
    const phase = eng.phase;
    const running = eng.isRunning() && phase !== PHASE.IDLE && phase !== PHASE.COMPLETE;
    const paused = !!eng.paused && phase !== PHASE.IDLE && phase !== PHASE.COMPLETE;
    const awaitingStart = !!eng.isAwaitingStart();
    const hasSession = phase !== PHASE.IDLE;

    const phaseLabel = paused ? 'Paused' : (phase === PHASE.BREAK ? 'Break' : (phase === PHASE.COMPLETE ? 'Complete' : 'Focus'));
    const ringProgress = hasSession ? Math.round(eng.progress() * 100) : 0;
    const display = hasSession ? formatDurationClock(eng.remainingInPhase()) : formatDurationClock(0);
    const roundsInfo = eng.config.rounds > 1 ? `Round ${Math.min(eng.round + (running ? 1 : 0), eng.config.rounds)} / ${eng.config.rounds}` : '';

    const illoCaption = hasSession
      ? (phase === PHASE.BREAK ? "Step away for a moment — you've earned it." : (phase === PHASE.COMPLETE ? "That's a wrap. Nicely done." : "Stay with it. One round at a time."))
      : "Pick a focus and begin when you're ready.";

    // Today's focus data — so the page reads & displays data like the rest.
    const today = getToday();
    const allSessions = await Storage.getAllSessions();
    const todaySessions = allSessions.filter((s) => s.date === today && s.source === 'timer');
    const todayFocusSecs = todaySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const todayRounds = todaySessions.filter((s) => s.endTime).length;
    const streak = this.calculateStreak(allSessions);

    el.innerHTML = `
      <div class="page-header flex justify-between items-center page-header-inline">
        <div>
          <h1>Focus Timer</h1>
          <p class="muted">${escapeHtml(illoCaption)}</p>
        </div>
        <button class="btn btn-ghost btn-sm" id="timerHelpBtn" title="How the timer works" aria-label="How the timer works">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          How it works
        </button>
      </div>

      <div class="timer-layout">
        <div class="card timer-session-card ${phase === PHASE.BREAK ? 'is-break' : ''}">
          <div class="focus-ring-wrap">
            <svg class="focus-ring" viewBox="0 0 220 220">
              <circle class="focus-ring-bg" cx="110" cy="110" r="100"></circle>
              <circle class="focus-ring-fg ${phase === PHASE.BREAK ? 'is-break' : ''}" cx="110" cy="110" r="100"
                style="stroke-dasharray:628; stroke-dashoffset:${628 - (628 * ringProgress) / 100}"></circle>
            </svg>
            <div class="focus-ring-center">
              <div class="timer-display ${running ? 'timer-running' : ''}" id="timerDisplay">${display}</div>
              <div class="focus-phase-label" id="focusPhaseLabel">${phaseLabel}</div>
              ${roundsInfo ? `<div class="focus-rounds" id="focusRounds">${roundsInfo}</div>` : ''}
            </div>
          </div>
          <p class="timer-session-caption" id="timerCompanionCaption">${illoCaption}</p>

          ${!hasSession ? `
            <div class="flex gap mt timer-setup-actions">
              <button class="btn btn-primary btn-lg" id="startTimerBtn" ${subjects.length === 0 ? 'disabled' : ''}>Start session</button>
            </div>
          ` : `
            <div class="flex gap mt timer-setup-actions">
              ${running ? `<button class="btn btn-ghost btn-lg" id="pauseTimerBtn">Pause</button>` : ''}
              ${paused ? `<button class="btn btn-primary btn-lg" id="resumeTimerBtn">Resume</button>` : ''}
              ${awaitingStart ? `<button class="btn btn-primary btn-lg" id="beginPhaseBtn">${phase === PHASE.FOCUS ? `Start round ${Math.min(eng.round + 1, eng.config.rounds)}` : 'Start break'}</button>` : ''}
              ${phase === PHASE.FOCUS && running ? `<button class="btn btn-ghost btn-lg" id="skipTimerBtn">Skip phase</button>` : ''}
              ${phase !== PHASE.COMPLETE ? `<button class="btn btn-danger btn-lg" id="stopTimerBtn">Stop</button>` : ''}
            </div>
            ${phase === PHASE.COMPLETE ? `<p class="timer-complete-msg mt">Session complete — great work! 🎉</p>` : ''}
          `}
        </div>

        <div class="card timer-setup-card">
          ${!hasSession ? `
            <div class="card-header">
              <h2>Set up</h2>
            </div>
            <div class="focus-config">
              <div class="focus-config-row">
                <label>Subject</label>
                <select id="timerSubject" ${subjects.length === 0 ? 'disabled' : ''}>
                  <option value="">Select subject</option>
                  ${subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
                </select>
                ${subjects.length === 0 ? `<span class="focus-config-hint">Add a subject first on the Subjects page.</span>` : ''}
              </div>
              <div class="focus-config-row">
                <label>Goal (optional)</label>
                <select id="timerGoal">
                  <option value="">No goal</option>
                  ${linkableGoals.map((g) => `<option value="${g.id}" ${this.pendingGoalId === g.id ? 'selected' : ''}>${escapeHtml((g.label || g.type) + (g.target ? ' (' + g.target + (g.unit || '') + ')' : ''))}</option>`).join('')}
                </select>
              </div>
              <div class="focus-config-block">
                <div class="focus-config-block-head">
                  <span>Session length</span>
                  <span class="focus-config-block-sub">Set in Settings</span>
                </div>
                <div class="focus-readout">
                  <div class="focus-readout-item"><span class="focus-readout-val">${Settings.get('focusLength')}<small>min</small></span><span class="focus-readout-label">Focus</span></div>
                  <div class="focus-readout-item"><span class="focus-readout-val">${Settings.get('breakLength')}<small>min</small></span><span class="focus-readout-label">Break</span></div>
                  <div class="focus-readout-item"><span class="focus-readout-val">${Settings.get('rounds')}</span><span class="focus-readout-label">Rounds</span></div>
                </div>
                <p class="focus-readout-note">These are display-only — change them in <a href="#settings" data-goto="settings">Settings → Focus &amp; Timer</a>.</p>
              </div>
              <div class="focus-config-presets">
                <div class="focus-config-block-head">
                  <span>Presets</span>
                </div>
                <div class="focus-presets-list" id="timerPresetsList"></div>
                <button class="btn btn-ghost btn-sm" id="saveTimerPresetBtn">Save current as preset</button>
              </div>
              <a class="timer-setup-more" href="#settings" data-goto="settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                Settings → Focus &amp; Timer
              </a>
            </div>
          ` : `
            <div class="card-header">
              <h2>Session details</h2>
            </div>
            <div class="timer-active-config">
              <div class="timer-active-row">
                <span class="muted text-sm">Subject</span>
                <strong>${escapeHtml((subjects.find((x) => x.id === eng.subjectId) || {}).name || '—')}</strong>
              </div>
              <div class="timer-active-row">
                <span class="muted text-sm">Quest</span>
                <strong>${eng.goalId ? escapeHtml((goals.find((g) => g.id === eng.goalId) || {}).label || 'Linked quest') : 'None'}</strong>
              </div>
              <div class="timer-active-row">
                <span class="muted text-sm">Focus / Break / Rounds</span>
                <strong>${Settings.get('focusLength')}m / ${Settings.get('breakLength')}m × ${Settings.get('rounds')}</strong>
              </div>
              ${eng.goalId ? this.timerQuestProgressHtml(eng.goalId) : ''}
            </div>
          `}
        </div>
      </div>

      <div class="grid grid-4 gap mt">
        <div class="card forecast-stat">
          <div class="stat-value">${formatDuration(todayFocusSecs)}</div>
          <div class="stat-label">Focus today</div>
        </div>
        <div class="card forecast-stat">
          <div class="stat-value">${todayRounds}</div>
          <div class="stat-label">Rounds today</div>
        </div>
        <div class="card forecast-stat">
          <div class="stat-value">${streak}</div>
          <div class="stat-label">Day streak</div>
        </div>
        <div class="card forecast-stat">
          <div class="stat-value">${todaySessions.length}</div>
          <div class="stat-label">Sessions today</div>
        </div>
      </div>
    `;

    document.getElementById('startTimerBtn')?.addEventListener('click', () => this.startTimer());
    document.getElementById('pauseTimerBtn')?.addEventListener('click', () => this.pauseTimer());
    document.getElementById('resumeTimerBtn')?.addEventListener('click', () => this.resumeTimer());
    document.getElementById('beginPhaseBtn')?.addEventListener('click', () => this.beginPhase());
    document.getElementById('stopTimerBtn')?.addEventListener('click', () => this.stopTimer());
    document.getElementById('skipTimerBtn')?.addEventListener('click', () => this.skipTimer());


    document.getElementById('saveTimerPresetBtn')?.addEventListener('click', () => this.saveTimerPreset());
    this.renderTimerPresets();

    document.getElementById('timerHelpBtn')?.addEventListener('click', () => this.showTimerHelp());
    if (!(await Storage.getSetting('timerHelpSeen'))) {
      await Storage.setSetting('timerHelpSeen', true);
      this.showTimerHelp();
    }
  },

  // Resolve the quest the user is currently tracking (linked to the live timer
  // or previously chosen via "Earn in Timer"), or null if none.
  getTrackedQuest(goals) {
    const trackedId = (this.engine && this.engine.goalId) || this.pendingGoalId || null;
    if (!trackedId) return null;
    return goals.find((g) => g.id === trackedId) || null;
  },

  // Live tracked-quest block used inside the quest hero card so it actually
  // reflects the quest in progress instead of only the player's level.
  questHeroTrackedHtml(goals) {
    const goal = this.getTrackedQuest(goals);
    if (!goal) {
      return `
        <div class="quest-hero-tracked quest-hero-tracked-empty">
          <span class="muted text-sm">No quest tracked yet — link one from the Timer or pick “Earn in Timer” on a quest below.</span>
        </div>`;
    }
    const pct = Math.min(100, Math.round(this.questProgress(goal, [], new Set(getWeekDates())) * 100));
    const completed = pct >= 100;
    const unitLabel = goal.unit === 'minutes' ? 'min' : goal.unit === 'sessions' ? 'sessions' : 'h';
    return `
      <div class="quest-hero-tracked">
        <div class="quest-hero-tracked-head">
          <span class="quest-hero-tracked-label">Tracking · ${escapeHtml(goal.label || 'Quest')}</span>
          <span class="badge badge-success">${pct}%</span>
        </div>
        <div class="progress-bar" style="margin-top:6px"><div class="progress-fill ${completed ? 'success' : ''}" style="width:${pct}%"></div></div>
        <div class="muted text-xs mt-xs">${completed ? '✅ Quest complete!' : `${Math.floor(this.questCurrentValue(goal) * 10) / 10} / ${goal.target || 0} ${unitLabel}`}</div>
      </div>`;
  },

  // Live progress line for the quest linked to the running timer.
  timerQuestProgressHtml(goalId) {
    const goal = (this._goalsCache || []).find((g) => g.id === goalId);
    if (!goal) return '';
    const pct = Math.min(100, Math.round((this.questProgress(goal, [], new Set(getWeekDates())) * 100)));
    const completed = pct >= 100;
    return `
      <div class="timer-active-row timer-quest-progress">
        <span class="muted text-sm">Quest progress</span>
        <div class="flex items-center gap-xs" style="flex:1">
          <div class="progress-bar" style="flex:1"><div class="progress-fill ${completed ? 'success' : ''}" style="width:${pct}%"></div></div>
          <span class="muted text-xs">${pct}%</span>
        </div>
      </div>`;
  },

  renderTimerPresets() {
    const list = document.getElementById('timerPresetsList');
    if (!list) return;
    const presets = Settings.get('timerPresets') || [];
    if (!presets.length) { list.innerHTML = '<span class="subtle text-sm">No saved presets yet.</span>'; return; }
    list.innerHTML = presets.map((p, i) => `
      <button class="btn btn-ghost btn-sm preset-chip" data-idx="${i}" title="Apply ${escapeHtml(p.name)}">
        ${escapeHtml(p.name)} <span class="preset-x" data-del="${i}" aria-label="Delete">×</span>
      </button>`).join('');
    list.querySelectorAll('.preset-chip').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        if (e.target.dataset.del != null) {
          e.stopPropagation();
          const presets2 = Settings.get('timerPresets').slice();
          presets2.splice(parseInt(e.target.dataset.del, 10), 1);
          await Settings.set('timerPresets', presets2);
          this.renderTimerPresets();
          return;
        }
        const p = Settings.get('timerPresets')[parseInt(btn.dataset.idx, 10)];
        await Settings.setMany({ focusLength: p.focusLength, breakLength: p.breakLength, rounds: p.rounds, longBreakLength: p.longBreakLength, longBreakEvery: p.longBreakEvery });
        if (this.engine) this.engine.configure(await this.loadFocusConfig());
        this.renderTimer();
      });
    });
  },

  async saveTimerPreset() {
    const f = Settings.get('focusLength');
    const b = Settings.get('breakLength');
    const r = Settings.get('rounds');
    const name = `${f}/${b}×${r}`;
    const presets = (Settings.get('timerPresets') || []).filter((p) => p.name !== name);
    presets.push({ name, focusLength: f, breakLength: b, rounds: r, longBreakLength: Settings.get('longBreakLength'), longBreakEvery: Settings.get('longBreakEvery') });
    await Settings.set('timerPresets', presets.slice(-8));
    this.renderTimerPresets();
    this.toast('Preset saved: ' + name, 'success');
  },

  showTimerHelp() {
    this.openModal(`
      <div class="modal-overlay">
        <div class="modal timer-help-modal" style="max-width:560px">
          <div class="timer-help-hero">
            <img class="timer-help-illo" src="assets/illustrations/Time-In-For-Work--Streamline-Bangalore.png" alt="">
            <div class="timer-help-hero-text">
              <h2>How the Focus Timer works</h2>
              <p class="muted">Study in focused rounds with breaks in between — the ring shows your progress, your stats show the payoff.</p>
            </div>
            <button class="btn btn-ghost btn-sm timer-help-close" id="closeTimerHelp" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="timer-help-body">
            <div class="timer-help-steps">
              <div class="timer-help-step">
                <div class="timer-help-step-ico" style="--step:var(--accent)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                </div>
                <div>
                  <h3>1 · Set up</h3>
                  <p>Pick a <strong>Subject</strong> and optionally a <strong>Goal</strong>. Choose lengths with presets like <code>25/5 ×4</code> or <code>50/10 ×2</code> — your last one is remembered.</p>
                </div>
              </div>
              <div class="timer-help-step">
                <div class="timer-help-step-ico" style="--step:var(--accent)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <div>
                  <h3>2 · Focus</h3>
                  <p>Press <strong>Start</strong>. The ring fills and counts down; a round counter shows your place. <strong>Pause</strong>, <strong>Resume</strong>, <strong>Skip</strong> or <strong>Stop</strong> whenever you need.</p>
                </div>
              </div>
              <div class="timer-help-step">
                <div class="timer-help-step-ico" style="--step:#10b981">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.25 21a9 9 0 1 1 9-9"/><path d="M8 4.5A9 9 0 0 1 20.25 16"/><path d="M16 3v6h-6"/></svg>
                </div>
                <div>
                  <h3>3 · Break &amp; repeat</h3>
                  <p>Each round flows into a <span class="timer-help-break">green Break</span>, then the next round. After the last, the session is <strong>Complete</strong> and saved.</p>
                </div>
              </div>
            </div>
            <div class="timer-help-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <span>Your session is restored if you leave — phase, elapsed time and round are kept. Completed focus time feeds your stats and any linked goal. Tip: <strong>pause</strong> (don't stop) for short interruptions.</span>
            </div>
          </div>
        </div>
      </div>
    `);
    document.getElementById('closeTimerHelp')?.addEventListener('click', () => this.closeModals());
  },

  // Explains, per quest metric, exactly how a student can complete it.
  questHowToText(metric) {
    const map = {
      notesReviewed: 'Open any note from the Notes page (or make an edit) today. Simply viewing a note counts as revisiting it. Tip: open the notes you want to remember to check them off.',
      notesCreated: 'Tap “Add note” on the Notes page and create a new note today. Each saved note counts toward this quest.',
      questionsCaptured: 'While writing a note, end a line with “?” or start it with a question word (What / Why / How). StudyFlow will offer to turn it into a tracked question — tap “Add”. Each captured question counts.',
      focusRounds: 'On the Timer page, pick a subject (and optionally a quest), then Start. Each completed focus round — even a single 25-minute round — counts.',
      subjectsStudied: 'Study with the Timer across different subjects today. Each distinct subject you log a session for counts toward this quest.',
      sessionsPlanned: 'On the Planner page, add at least the target number of sessions for today. Each planned session counts.',
    };
    return map[metric] || 'Make progress with the Timer, Notes, or Planner — your activity is tracked automatically.';
  },

  showQuestHowTo(metric, label) {
    this.openModal(`
      <div class="modal-overlay">
        <div class="modal" style="max-width:520px">
          <div class="modal-header">
            <h2>How to complete this quest</h2>
            <button class="btn btn-ghost btn-sm" id="closeQuestHowTo">Close</button>
          </div>
          <div class="quest-howto-body">
            ${label ? `<p class="muted mb">${escapeHtml(label)}</p>` : ''}
            <p>${escapeHtml(this.questHowToText(metric))}</p>
            <p class="subtle mt-sm">Quests track your real activity — no manual check-in needed. Finish it and you'll get the bonus XP automatically.</p>
          </div>
        </div>
      </div>
    `);
    document.getElementById('closeQuestHowTo')?.addEventListener('click', () => this.closeModals());
  },

  async startTimer() {
    unlockAudio();
    const subjectId = document.getElementById('timerSubject').value;
    if (!subjectId) return this.toast('Please select a subject', 'error');
    const goalId = document.getElementById('timerGoal')?.value || null;
    const eng = this.engine;

    eng.configure(await this.loadFocusConfig());
    const session = {
      id: generateId(),
      subjectId,
      date: getToday(),
      startTime: new Date().toISOString(),
      endTime: null,
      duration: 0,
      description: '',
      paused: false,
      source: 'timer',
      goalId: goalId || undefined,
      createdAt: new Date().toISOString(),
    };
    await Storage.saveSession(session);

    eng.start({ subjectId, goalId, sessionId: session.id });
    this.bindEngine();
    await this.persistEngine();
    this.renderTimer();
    this.pendingGoalId = null;
    this.toast('Focus session started', 'success');
  },

  async pauseTimer() {
    if (!this.engine) return;
    this.engine.pause();
    await this.persistEngine();
    await this.saveSessionDuration();
    this.renderTimer();
  },

  async resumeTimer() {
    if (!this.engine) return;
    this.engine.resume();
    await this.persistEngine();
    this.renderTimer();
  },

  async beginPhase() {
    if (!this.engine) return;
    this.engine.beginPhase();
    await this.persistEngine();
    this.renderTimer();
  },

  async skipTimer() {
    if (!this.engine) return;
    this.engine.skip();
    await this.persistEngine();
    this.renderTimer();
  },

  async stopTimer() {
    if (!this.engine) return;
    const focusSeconds = this.engine.totalFocusSeconds();
    this.engine.stop();
    await this.saveSessionDuration();
    await this.persistEngine(true);
    this.engine = null;
    if (focusSeconds > 0) this.toast('Session saved', 'success');
    else this.toast('Timer reset', 'success');
    this.renderTimer();
  },

  /* ---------- Focus Engine glue ---------- */
  async loadFocusConfig() {
    return {
      focusLength: Settings.get('focusLength') * 60,
      breakLength: Settings.get('breakLength') * 60,
      rounds: Settings.get('rounds'),
      longBreakLength: Settings.get('longBreakLength') * 60,
      longBreakEvery: Settings.get('longBreakEvery'),
      autoStartBreaks: Settings.get('autoStartBreaks'),
      autoStartFocus: Settings.get('autoStartFocus'),
      breakLengthFor: (completedFocusRounds) => this.nextBreakLength(completedFocusRounds),
    };
  },

  // Decides whether the upcoming break is a long break based on Settings.
  nextBreakLength(completedFocusRounds) {
    const every = Settings.get('longBreakEvery');
    if (every >= 2 && completedFocusRounds > 0 && completedFocusRounds % every === 0) {
      return Settings.get('longBreakLength') * 60;
    }
    return Settings.get('breakLength') * 60;
  },

  bindEngine() {
    const eng = this.engine;
    eng.onTick = () => this.paintTimer();
    eng.onPhase = (phase) => {
      // Sound + vibrate on every phase boundary (including breaks).
      if (phase !== PHASE.IDLE) playPhaseSound(phase === PHASE.COMPLETE ? 'complete' : 'phase');
      this.paintTimer();
      this.persistEngine();
      this.renderTimer();
    };
    eng.onComplete = async ({ focusSeconds }) => {
      playPhaseSound('complete');
      await this.saveSessionDuration();
      await this.persistEngine(true);
      this.renderTimer();
    };
    eng.onError = (e) => this.toast(String(e), 'error');
  },

  async paintTimer() {
    const eng = this.engine;
    if (!eng) return;
    const display = document.getElementById('timerDisplay');
    const ring = document.querySelector('.focus-ring-fg');
    const phaseLbl = document.getElementById('focusPhaseLabel');
    const rounds = document.getElementById('focusRounds');
    if (display) display.textContent = formatDurationClock(eng.remainingInPhase());
    if (ring) {
      const p = Math.round(eng.progress() * 100);
      ring.style.strokeDashoffset = String(628 - (628 * p) / 100);
    }
    if (phaseLbl) phaseLbl.textContent = eng.phase === PHASE.BREAK ? 'Break' : (eng.phase === PHASE.COMPLETE ? 'Complete' : 'Focus');
    if (rounds && eng.config.rounds > 1) {
      const running = eng.isRunning() && eng.phase !== PHASE.IDLE && eng.phase !== PHASE.COMPLETE;
      rounds.textContent = `Round ${Math.min(eng.round + (running ? 1 : 0), eng.config.rounds)} / ${eng.config.rounds}`;
    }
  },

  async saveSessionDuration() {
    const eng = this.engine;
    if (!eng || !eng.sessionId) return;
    const session = await Storage.getSession(eng.sessionId);
    if (!session) return;
    const duration = eng.totalFocusSeconds();
    // End the session record when it's finished (complete) or explicitly stopped.
    if (eng.phase === PHASE.COMPLETE || eng.phase === PHASE.IDLE) {
      session.endTime = new Date().toISOString();
    }
    session.duration = duration;
    session.paused = eng.phase === PHASE.IDLE;
    await Storage.saveSession(session);
    // Award XP + quest progress once per session, when it is finalized
    // (stopped early or completed). This also captures partial focus time.
    if ((eng.phase === PHASE.COMPLETE || eng.phase === PHASE.IDLE) && !session.xpAwarded) {
      session.xpAwarded = true;
      await this.awardQuestXp(Math.round(duration / 60));
      await this.contributeToGoal(duration, { silent: true });
    }
    this.checkGoalCelebrations();
  },

  async checkGoalCelebrations() {
    const [subjects, sessions, goals] = await Promise.all([
      Storage.getAllSubjects(), Storage.getAllSessions(), Storage.getAllGoals(),
    ]);
    const weekDates = getWeekDates();
    const weekSet = new Set(weekDates);
    const today = getToday();

    // Auto-accumulate study-time quests from saved sessions so they track on
    // their own, without requiring an explicit timer→quest link.
    await this.syncStudyQuests(sessions, goals);

    if (!Settings.get('goalCelebrations')) return;
    const flags = JSON.parse(localStorage.getItem('goalCelebrations') || '{}');
    const weekKey = weekDates[0];
    let changed = false;

    for (const s of subjects) {
      const goal = Number(s.weeklyGoal) || 0;
      if (goal <= 0) continue;
      const weekTotal = sessions
        .filter((x) => x.subjectId === s.id && x.date && weekSet.has(x.date))
        .reduce((sum, x) => sum + (x.duration || 0), 0);
      if (weekTotal < goal) continue;
      const key = `subj_${s.id}_${weekKey}`;
      if (flags[key]) continue;
      flags[key] = true;
      changed = true;
      this.congratsOverlay(`${s.name}: weekly goal reached!`);
    }

    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);
    if (dailyGoal && dailyGoal.target > 0) {
      const dailyTarget = dailyGoal.target * 3600;
      const todayTotal = sessions
        .filter((x) => x.date === today)
        .reduce((sum, x) => sum + (x.duration || 0), 0);
      if (todayTotal >= dailyTarget) {
        const key = `daily_${today}`;
        if (!flags[key]) {
          flags[key] = true;
          changed = true;
          this.congratsOverlay('Daily study goal reached — amazing work!');
          const bonus = dailyGoal.bonusXp || 0;
          if (bonus && !dailyGoal.completedDate) {
            dailyGoal.completedDate = today;
            await Storage.saveGoal(dailyGoal);
            await this.awardQuestXp(0, bonus);
          }
        }
      }
    }

    // User-defined (generic) quests: celebrate + award a difficulty-based bonus
    // the first time each one reaches its target.
    const QUEST_BONUS = { easy: 15, normal: 30, hard: 50, epic: 80 };
    for (const g of goals) {
      if (g.type !== 'quest' || !g.active) continue;
      const done = (g.progress || 0) >= (g.target || 0);
      if (!done) continue;
      const key = `quest_${g.id}`;
      if (flags[key]) continue;
      flags[key] = true;
      changed = true;
      const bonus = g.bonusXp || QUEST_BONUS[g.difficulty] || 30;
      if (!g.completedDate) {
        g.completedDate = today;
        await Storage.saveGoal(g);
      }
      await this.awardQuestXp(0, bonus);
      this.congratsOverlay(`Quest complete: ${g.label || 'Quest'}! +${bonus} XP 🎉`);
    }

    if (changed) localStorage.setItem('goalCelebrations', JSON.stringify(flags));

    // Task-style daily quests (review notes, capture questions, etc.) are
    // measured from live data rather than study time.
    await this.evaluateDailyQuest();

    // Reflect any progress/completion changes on the currently visible page.
    this.refreshCurrentPage().catch(() => {});
  },

  // Auto-accumulate study-time quests from saved sessions. A quest counts as a
  // study quest when it has time/session units (not a task-metric quest), and
  // tracks focus time across its lifetime (optionally scoped to a week or a
  // subject via `scope`). This makes quests fill on their own as you study —
  // no manual timer→quest link needed.
  async syncStudyQuests(sessions, goals) {
    if (!sessions || !goals) return;
    const studyUnits = new Set(['hours', 'minutes', 'sessions']);
    const weekSet = new Set(getWeekDates());
    for (const g of goals) {
      if (g.type !== 'quest' || !g.active) continue;
      if (g.metric || g.kind === 'task') continue;
      if (!studyUnits.has(g.unit)) continue;
      const isWeekly = g.scope === 'weekly';
      const isSubject = g.scope === 'subject' && g.subjectId;
      const secs = sessions
        .filter((s) => {
          if (!s.duration) return false;
          if (isWeekly && !weekSet.has(s.date)) return false;
          if (isSubject && s.subjectId !== g.subjectId) return false;
          return true;
        })
        .reduce((sum, s) => sum + (s.duration || 0), 0);
      if (secs !== (g.progress || 0)) {
        g.progress = secs;
        await Storage.saveGoal(g);
      }
    }
  },

  async contributeToGoal(focusSeconds, opts = {}) {
    const eng = this.engine;
    if (!eng || !eng.goalId || !focusSeconds) return;
    const goal = await Storage.getGoal(eng.goalId);
    if (!goal) return;
    goal.progress = (goal.progress || 0) + focusSeconds;
    await Storage.saveGoal(goal);
    if (!opts.silent) this.toast(`Added ${formatDuration(focusSeconds)} to goal`, 'success');
    await this.awardQuestXp(Math.round(focusSeconds / 60));
  },

  /* ---------- Daily quest (auto-generated, bonus XP) ---------- */

  async ensureDailyQuest() {
    try {
      await ensureDailyQuest();
    } catch (e) {
      console.warn('[questSeed] ensure failed', e);
    }
  },

  // Measure a task-type daily quest's current value from live data.
  async measureDailyMetric(metric) {
    const today = getToday();
    if (metric === 'focusRounds') {
      const sessions = await Storage.getAllSessions();
      return sessions.filter((s) => s.date === today && s.source === 'timer' && s.endTime).length;
    }
    if (metric === 'sessionsPlanned') {
      const sessions = await Storage.getAllSessions();
      return sessions.filter((s) => s.date === today && s.source !== 'timer').length;
    }
    if (metric === 'subjectsStudied') {
      const sessions = await Storage.getAllSessions();
      return new Set(sessions.filter((s) => s.date === today && s.subjectId).map((s) => s.subjectId)).size;
    }
    if (metric === 'notesCreated' || metric === 'notesReviewed') {
      const notes = await Storage.getAllNotes();
      if (metric === 'notesCreated') {
        return notes.filter((n) => localDateOf(n.createdAt) === today).length;
      }
      // Reviewed = opened (lastViewedAt) or edited (updatedAt) today,
      // including notes created today.
      return notes.filter((n) => {
        const viewed = localDateOf(n.lastViewedAt) === today;
        const edited = localDateOf(n.updatedAt) === today;
        return viewed || edited;
      }).length;
    }
    if (metric === 'questionsCaptured') {
      const notes = await Storage.getAllNotes();
      return notes.reduce((sum, n) => sum + ((n.questions || []).filter((q) => (q.createdAt || '').slice(0, 10) === today).length), 0);
    }
    return 0;
  },

  // Recompute progress for a task-type daily quest and award the bonus on
  // first completion. Returns true if the quest was just completed now.
  async evaluateDailyQuest() {
    const goals = await Storage.getAllGoals();
    const daily = goals.find((g) => g.id === 'daily' && g.active);
    if (!daily || !isDailyQuest(daily)) return false;
    if (daily.kind === 'study') return false; // study-time dailies handled in checkGoalCelebrations

    const metricVal = await this.measureDailyMetric(daily.metric);
    const prev = daily.progress || 0;
    const next = Math.max(prev, metricVal);
    const wasDone = prev >= (daily.target || 0);
    const isDone = next >= (daily.target || 0);

    let justCompleted = false;
    if (!wasDone && isDone) justCompleted = true;

    if (next !== prev || (isDone && !daily.completedDate)) {
      daily.progress = next;
      if (isDone && !daily.completedDate) daily.completedDate = getToday();
      await Storage.saveGoal(daily);
    }

    if (justCompleted) {
      const bonus = daily.bonusXp || 0;
      if (bonus) await this.awardQuestXp(0, bonus);
      this.congratsOverlay('Daily quest complete — bonus XP earned! 🎉');
      return true;
    }
    return false;
  },

  async awardQuestXp(minutes, bonus = 0) {
    if ((!minutes || minutes <= 0) && (!bonus || bonus <= 0)) return;
    let xp = (minutes || 0) * (Number(Settings.get('questXpPerMinute')) || 10);
    if (bonus) xp += bonus;
    const res = await Settings.questAddXp(xp);
    this.toast(`+${xp} XP`, 'success');
    if (res.leveledUp) {
      this.levelUpOverlay(res.level);
    }
  },

  levelUpOverlay(level) {
    this.openModal(`
      <div class="modal-overlay congrats-overlay">
        <div class="congrats-card">
          <img class="congrats-illo" src="assets/congrats_illustration/Graduation-1--Streamline-Bangalore.png" alt="">
          <h2>Level up! ⚡</h2>
          <p class="muted">You reached <strong>Level ${level}</strong> — ${escapeHtml(this.questRankTitle(level))}.</p>
          <button class="btn btn-primary" id="levelUpClose">Nice!</button>
        </div>
      </div>
    `);
    document.getElementById('levelUpClose')?.addEventListener('click', () => this.closeModals());
  },

  async persistEngine(closed = false) {
    if (!this.engine) return;
    const data = this.engine.serialize();
    data.closed = closed;
    await Storage.setSetting('focusEngine', data);
  },

  async restoreTimerState() {
    const data = await Storage.getSetting('focusEngine');
    if (!data || data.closed) return;
    const eng = FocusEngine.deserialize(data);
    if (eng.phase === PHASE.IDLE || eng.phase === PHASE.COMPLETE) return;
    this.engine = eng;
    this.bindEngine();
    // Re-apply live config: the serialized config loses `breakLengthFor`
    // (a function) and must reflect current Settings for autoStart/long breaks.
    eng.configure(await this.loadFocusConfig());
    eng.rehydrate();
  },

  noteCardHTML(n, subjects) {
    const subj = subjects.find((x) => x.id === n.subjectId);
    const subjColor = subj && subj.color ? subj.color : 'var(--accent)';
    return `
      <div class="card note-card" data-note-id="${n.id}" style="--subj: ${subjColor}">
        <div class="note-card-head">
          <div class="note-card-icon"><img src="assets/illustrations/Pin-Post-It-Note--Streamline-Ux.png" alt="${escapeHtml(n.title || 'Note')}"></div>
          <span class="badge note-subject">${subj ? escapeHtml(subj.name) : 'No subject'}</span>
        </div>
        <h3 class="truncate">${escapeHtml(n.title)}</h3>
        <p class="note-content-preview muted">${escapeHtml(n.content || '')}</p>
        <div class="note-card-foot">
          <span class="muted text-sm">${formatDate(n.updatedAt || n.createdAt)}</span>
          <div class="flex gap-xs note-card-actions">
            <button class="btn btn-ghost btn-sm" data-action="preview-note" data-id="${n.id}" aria-label="Preview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="btn btn-danger btn-sm" data-action="delete-note" data-id="${n.id}" aria-label="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>
      </div>`;
  },

  async renderNotes() {
    const [notes, subjects] = await Promise.all([
      Storage.getAllNotes(), Storage.getAllSubjects(),
    ]);
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="page-header flex justify-between items-center page-header-inline">
        <h1>Notes</h1>
        <button class="btn btn-primary btn-sm" id="addNoteBtn" aria-label="Add note">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add note
        </button>
      </div>
      <div class="flex gap mt mb notes-toolbar">
        <input type="text" id="noteSearch" placeholder="Search notes..." class="form-control">
        <select id="noteSubjectFilter" class="form-control">
          <option value="">All subjects</option>
          ${subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <select id="noteGroupLens" class="form-control" title="Group notes by">
          <option value="subject" ${Settings.get('noteDefaultLens') === 'subject' ? 'selected' : ''}>Group: Subject</option>
          <option value="affinity" ${Settings.get('noteDefaultLens') !== 'subject' && Settings.get('noteDefaultLens') !== 'recency' && Settings.get('noteDefaultLens') !== 'questions' ? 'selected' : ''}>Group: Affinity</option>
          <option value="recency" ${Settings.get('noteDefaultLens') === 'recency' ? 'selected' : ''}>Group: Recency</option>
          <option value="questions" ${Settings.get('noteDefaultLens') === 'questions' ? 'selected' : ''}>Group: Questions</option>
        </select>
      </div>
      <div class="grid grid-2 gap" id="notesGrid"></div>
    `;

    const search = document.getElementById('noteSearch');
    const filter = document.getElementById('noteSubjectFilter');
    const lensSelect = document.getElementById('noteGroupLens');

    const renderGrouped = (srcNotes) => {
      const lens = lensSelect ? lensSelect.value : (Settings.get('noteDefaultLens') || 'affinity');
      const { groups, ungrouped } = groupNotesByLens(srcNotes, lens, subjects);
      const blocks = groups.map((g) => `
        <section class="note-group" style="grid-column:1/-1">
          <header class="note-group-head">
            <span class="note-group-label">${escapeHtml(g.label)}</span>
            <span class="note-group-count">${g.size} note${g.size === 1 ? '' : 's'}</span>
          </header>
          <div class="grid grid-2 gap note-group-grid">
            ${g.members.map((n) => this.noteCardHTML(n, subjects)).join('')}
          </div>
        </section>
      `).join('');
      const loose = ungrouped.length ? `
        <section class="note-group" style="grid-column:1/-1">
          <header class="note-group-head">
            <span class="note-group-label">Ungrouped</span>
            <span class="note-group-count">${ungrouped.length} note${ungrouped.length === 1 ? '' : 's'}</span>
          </header>
          <div class="grid grid-2 gap note-group-grid">
            ${ungrouped.map((n) => this.noteCardHTML(n, subjects)).join('')}
          </div>
        </section>` : '';
      return blocks + loose;
    };

    const applyFilter = () => {
      const query = search.value.toLowerCase();
      const subjectFilter = filter.value;
      const filtered = notes.filter((n) => {
        const matchText = (n.title + ' ' + (n.content || '')).toLowerCase().includes(query);
        const matchSubject = !subjectFilter || n.subjectId === subjectFilter;
        return matchText && matchSubject;
      });

      const grid = document.getElementById('notesGrid');
      if (notes.length === 0) {
        grid.innerHTML = `
          <div class="empty-state empty-state-lg" style="grid-column:1/-1">
            <img class="empty-illo" src="assets/illustrations/Communication-Contact-Post-It-To-Do-Notes-01--Streamline-Bangalore.png" alt="">
            <h3>No notes yet</h3>
            <p>Capture ideas, summaries, and key points from your study sessions.</p>
          </div>`;
      } else {
        grid.innerHTML = filtered.length === 0
          ? '<p class="muted">No notes match your search.</p>'
          : renderGrouped(filtered);
      }

      grid.querySelectorAll('[data-action="delete-note"]').forEach((b) => {
        b.addEventListener('click', () => this.deleteNote(b.dataset.id));
      });
      grid.querySelectorAll('[data-action="preview-note"]').forEach((b) => {
        b.addEventListener('click', () => this.showNotePreview(b.dataset.id));
      });
      grid.querySelectorAll('.note-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-action="delete-note"]') || e.target.closest('[data-action="preview-note"]')) return;
          history.pushState(null, '', `#note/${card.dataset.noteId}`);
          this.handleRoute();
        });
      });
    };

    search.addEventListener('input', debounce(applyFilter, 300));
    filter.addEventListener('change', applyFilter);
    lensSelect.addEventListener('change', applyFilter);
    applyFilter();

    document.getElementById('addNoteBtn')?.addEventListener('click', () => this.showNoteForm());
    el.querySelectorAll('[data-action="delete-note"]').forEach((b) => {
      b.addEventListener('click', () => this.deleteNote(b.dataset.id));
    });
    el.querySelectorAll('[data-action="preview-note"]').forEach((b) => {
      b.addEventListener('click', () => this.showNotePreview(b.dataset.id));
    });
    el.querySelectorAll('.note-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="delete-note"]') || e.target.closest('[data-action="preview-note"]')) return;
        history.pushState(null, '', `#note/${card.dataset.noteId}`);
        this.handleRoute();
      });
    });
  },

   async showNotePreview(noteId) {
     const notes = await Storage.getAllNotes();
     const subjects = await Storage.getAllSubjects();
     const note = notes.find(n => n.id === noteId);
     if (!note) return;

     const subj = subjects.find(s => s.id === note.subjectId);
     this.openModal(`
       <div class="modal-overlay">
         <div class="modal" style="max-width:640px">
           <div class="modal-header">
             <h2>${escapeHtml(note.title)}</h2>
             <button class="btn btn-ghost btn-sm" id="closePreviewModal">Close</button>
           </div>
           <div class="note-preview-full">
             <div class="flex gap-sm mb">
               <span class="badge">${subj ? escapeHtml(subj.name) : 'No subject'}</span>
               <span class="muted text-sm">${formatDate(note.updatedAt || note.createdAt)}</span>
             </div>
              <div class="note-preview-content" id="previewModalContent">${note.content && note.content.trim() ? parseMarkdown(note.content || '', note.questions || []) : `
                <div class="note-preview-empty">
                  <img class="note-preview-empty-illo" src="assets/illustrations/Documents-4--Streamline-Bangalore.png" alt="">
                  <p>This note is still a blank draft. Open the editor to start writing.</p>
                </div>
              `}</div>
              <div class="preview-question-tooltip" id="previewModalTooltip" aria-hidden="true"></div>
           </div>
         </div>
       </div>
     `);

     const modalContent = document.getElementById('previewModalContent');
     const modalTooltip = document.getElementById('previewModalTooltip');
      if (modalContent && modalTooltip && (note.questions || []).length) {
        attachQuestionTooltip({
          container: modalContent,
          tooltipEl: modalTooltip,
          questions: note.questions || [],
        });
      }
      attachQuestionToggle(modalContent);

      document.getElementById('closePreviewModal')?.addEventListener('click', () => this.closeModals());
      this.renderMathInPreview();
    },

    async showNoteForm(note) {
     const subjects = await Storage.getAllSubjects();
     const isEdit = !!note;
     const data = note || { id: generateId(), title: '', subjectId: Settings.get('noteDefaultSubject') || '', content: '' };

    const moodLines = [
      'Capture a thought before it slips away.',
      'What clicked for you today?',
      'Turn a messy idea into a clear note.',
      'Write it down — your future self will thank you.',
      'One small note, one step forward.',
    ];
    const mood = moodLines[Math.floor(Math.random() * moodLines.length)];

    this.openModal(`
      <div class="modal-overlay">
        <div class="modal note-composer">
          <div class="note-composer-head">
            <div class="note-composer-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 11v6M9 14h6"/></svg>
            </div>
            <div>
              <h2 class="note-composer-title">${isEdit ? 'Edit your note' : 'New note'}</h2>
              <p class="note-composer-mood">${escapeHtml(mood)}</p>
            </div>
          </div>
          <div class="note-composer-body">
            <form id="noteForm" class="p">
              <input type="hidden" id="noteId" value="${data.id}">
              <input type="hidden" id="noteSubject" value="${data.subjectId || ''}">
              <div class="form-group">
                <label for="noteTitle">Give it a title</label>
                <input type="text" id="noteTitle" required value="${data.title}" placeholder="e.g. Photosynthesis, Chapter 4 summary…" autocomplete="off">
                <div class="note-composer-counter"><span id="titleCount">0</span> characters</div>
              </div>
              <div class="form-group">
                <label>Tag a subject ${subjects.length ? '' : '<span class="muted">(optional)</span>'}</label>
                <div class="note-subject-chips" id="noteSubjectChips">
                  <button type="button" class="note-chip ${!data.subjectId ? 'selected' : ''}" data-subject="" style="--chip:#8a90b0">None</button>
                  ${subjects.map((s) => `
                    <button type="button" class="note-chip ${data.subjectId === s.id ? 'selected' : ''}" data-subject="${s.id}" style="--chip:${escapeHtml(s.color)}">
                      <span class="note-chip-dot"></span>${escapeHtml(s.name)}
                    </button>
                  `).join('')}
                </div>
              </div>
              <p class="subtle" style="margin-top:4px">After saving, you'll open the editor to write and sketch your note.</p>
              <div class="flex justify-end gap mt">
                <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save changes' : 'Create note'}</button>
              </div>
            </form>
            <div class="note-composer-preview">
              <span class="note-composer-preview-label">Preview</span>
              <div class="note-composer-preview-card" id="composerPreview">
                <h3 class="note-composer-preview-title" id="composerPreviewTitle">${escapeHtml(data.title) || '<span class="muted">Your title appears here</span>'}</h3>
                <p class="note-composer-preview-sub" id="composerPreviewSub">${data.subjectId && subjects.find(s => s.id === data.subjectId) ? escapeHtml(subjects.find(s => s.id === data.subjectId).name) : 'No subject yet'}</p>
                <div class="note-composer-preview-empty">Start typing a title to see your note take shape. Questions and formatting come alive in the editor.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    const titleInput = document.getElementById('noteTitle');
    const titleCount = document.getElementById('titleCount');
    const previewTitle = document.getElementById('composerPreviewTitle');
    const previewSub = document.getElementById('composerPreviewSub');
    titleInput?.addEventListener('input', () => {
      if (titleCount) titleCount.textContent = String(titleInput.value.length);
      if (previewTitle) {
        previewTitle.innerHTML = titleInput.value.trim()
          ? escapeHtml(titleInput.value)
          : '<span class="muted">Your title appears here</span>';
      }
    });

    document.querySelectorAll('#noteSubjectChips .note-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#noteSubjectChips .note-chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        document.getElementById('noteSubject').value = chip.dataset.subject || '';
        const subj = subjects.find((s) => s.id === chip.dataset.subject);
        if (previewSub) previewSub.textContent = subj ? subj.name : 'No subject yet';
      });
    });

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('noteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('noteId').value;
      const title = document.getElementById('noteTitle').value.trim();
      const subjectId = document.getElementById('noteSubject').value || null;
      const content = note?.content || '';

      if (!title) return this.toast('A title helps you find this later', 'error');
      const existing = note ? await Storage.getNote(id) : null;
      const noteObj = { ...existing, id, title, subjectId, content };
      await Storage.saveNote(noteObj);
      this.toast(isEdit ? 'Note updated' : 'Note added — keep going!', 'success');
      this.closeModals();
      this.evaluateDailyQuest();
      this.renderNotes();
    });
  },

  async deleteNote(id) {
    if (!confirm('Delete this note?')) return;
    await Storage.deleteNote(id);
    this.toast('Note deleted', 'success');
    this.renderNotes();
  },

  async renderNote(noteId) {
    const [notes, subjects] = await Promise.all([
      Storage.getAllNotes(), Storage.getAllSubjects(),
    ]);
    const note = notes.find(n => n.id === noteId);

    if (!note) {
      document.getElementById('pageContent').innerHTML = `
        <div class="empty-state card">
          <h3>Note not found</h3>
          <p>This note may have been deleted.</p>
        </div>
      `;
      return;
    }

    const subj = subjects.find(s => s.id === note.subjectId);
    const el = document.getElementById('pageContent');

    // Opening a note counts as a revisit for the daily quest.
    let needsQuestRefresh = false;
    try {
      await Storage.markNoteViewed(noteId);
      needsQuestRefresh = true;
    } catch (e) { /* non-fatal */ }
    // Recompute the daily quest immediately so the revisit registers without
    // waiting for a save or a trip to the Notes list.
    this.evaluateDailyQuest().catch(() => {});

    el.innerHTML = `
      <div class="note-view">
        <div class="note-view-header">
          <button class="btn btn-ghost btn-sm" id="noteBackBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Back
          </button>
          <div class="flex gap-xs">
            <button class="btn btn-ghost btn-sm" id="noteToggleViewBtn" aria-label="Toggle preview">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="btn btn-danger btn-sm" id="noteDeleteBtn" aria-label="Delete note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>

        <div class="note-view-meta">
          <input type="text" id="noteTitleInput" value="${escapeHtml(note.title)}" placeholder="Note title" style="font-size:1.2rem;font-weight:600;flex:1;min-width:200px">
          <select id="noteSubjectSelect">
            <option value="">No subject</option>
            ${subjects.map(s => `<option value="${s.id}" ${note.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>
          <span class="badge">${formatDate(note.updatedAt || note.createdAt)}</span>
        </div>

        <div class="note-editor-wrap">
          <div>
            <div class="note-meta-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span class="subtle" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em">Editor</span>
              <button class="btn btn-ghost btn-sm" id="noteMarkdownHelpBtn" style="padding:4px 10px;font-size:0.75rem">Markdown guide</button>
            </div>
              <div class="note-editor">
               <label for="noteContentInput" class="sr-only">Note content</label>
               <textarea id="noteContentInput" placeholder="Start writing..." spellcheck="${Settings.get('noteSpellcheck') ? 'true' : 'false'}">${escapeHtml(note.content || '')}</textarea>
             </div>
          </div>
          <div>
            <div class="note-meta-row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span class="subtle" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em">Preview</span>
              <span class="subtle" style="font-size:0.72rem">Live</span>
            </div>
            <div class="note-preview" id="notePreview">
              ${note.content && note.content.trim() ? `
              <div class="note-preview-scroll" id="notePreviewScroll">${parseMarkdown(note.content || '', note.questions || [])}</div>
              ` : `
              <div class="note-editor-empty" id="notePreviewScroll">
                <img class="note-editor-empty-illo" src="assets/illustrations/Documents-4--Streamline-Bangalore.png" alt="">
                <p>Nothing here yet — start typing in the editor to bring your note to life.</p>
              </div>
              `}
              <div class="preview-question-tooltip" id="previewQuestionTooltip" aria-hidden="true"></div>
            </div>
          </div>
        </div>

        <div class="note-editor-foot">
          <div class="note-word-count" id="noteWordCount">${(note.content || '').split(/\s+/).filter(Boolean).length} words</div>
          <div class="note-reflection" id="noteReflection" title="How inquiry-rich this note is">
            <span class="note-reflection-label">Reflection</span>
            <span class="note-reflection-dots" id="noteReflectionDots"></span>
          </div>
        </div>

        <div class="card mt" id="noteVoiceMemoCard">
          <div class="note-voice-memo-header">
            <h2>Voice memo</h2>
            <button class="btn btn-primary btn-sm" id="noteRecordBtn" aria-label="Record">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/></svg>
            </button>
          </div>
          <div class="note-recording-status hidden" id="noteRecordingStatus">
            <span class="badge badge-danger" id="noteRecordingDot">Recording</span>
            <span class="subtle" id="noteRecordingTimer">00:00</span>
            <button class="btn btn-danger btn-sm" id="noteStopRecordBtn">Stop</button>
          </div>
          <div id="noteRecordingsList"></div>
        </div>

        <div class="note-questions-section" id="noteQuestionsSection">
          <div class="note-questions-header">
            <h3>Questions</h3>
            <span class="note-questions-count" id="noteQuestionsCount"></span>
          </div>
          <div id="questionsList"><div class="note-questions-empty">No questions yet<br><span class="note-questions-empty-sub">Type QUES in the editor to create a question</span></div></div>
        </div>

        <div class="note-mdf-help hidden" id="noteMarkdownHelp">
          <div class="note-mdf-help-inner">
            <h3>Markdown reference</h3>
            <div class="note-mdf-grid">
              <div class="note-mdf-row"><span class="mdf-example"># Heading</span><span class="mdf-desc">H1</span></div>
              <div class="note-mdf-row"><span class="mdf-example">## Heading</span><span class="mdf-desc">H2</span></div>
              <div class="note-mdf-row"><span class="mdf-example">### Heading</span><span class="mdf-desc">H3</span></div>
              <div class="note-mdf-row"><span class="mdf-example">**bold**</span><span class="mdf-desc">Bold</span></div>
              <div class="note-mdf-row"><span class="mdf-example">*italic*</span><span class="mdf-desc">Italic</span></div>
              <div class="note-mdf-row"><span class="mdf-example">***bold italic***</span><span class="mdf-desc">Both</span></div>
              <div class="note-mdf-row"><span class="mdf-example">- item</span><span class="mdf-desc">List</span></div>
              <div class="note-mdf-row"><span class="mdf-example">- [ ] task</span><span class="mdf-desc">Checklist</span></div>
              <div class="note-mdf-row"><span class="mdf-example">- [x] done</span><span class="mdf-desc">Checked</span></div>
              <div class="note-mdf-row"><span class="mdf-example">[[Note Title]]</span><span class="mdf-desc">Link note</span></div>
            </div>
            <button class="btn btn-ghost btn-sm mt" id="noteMarkdownCloseBtn">Close</button>
          </div>
        </div>

        <div class="note-backlinks" id="noteBacklinks"></div>
      </div>
    `;

    this.renderMathInPreview();

    document.getElementById('noteBackBtn')?.addEventListener('click', () => {
      history.pushState(null, '', '#notes');
      this.handleRoute();
    });

    document.getElementById('noteMarkdownHelpBtn')?.addEventListener('click', () => {
      document.getElementById('noteMarkdownHelp').classList.remove('hidden');
    });
    document.getElementById('noteMarkdownCloseBtn')?.addEventListener('click', () => {
      document.getElementById('noteMarkdownHelp').classList.add('hidden');
    });

    document.getElementById('noteDeleteBtn')?.addEventListener('click', async () => {
      if (!confirm('Delete this note?')) return;
      await Storage.deleteNote(note.id);
      this.toast('Note deleted', 'success');
      history.pushState(null, '', '#notes');
      this.handleRoute();
    });

    const noteViewEl = document.querySelector('.note-view');
    const toggleViewBtn = document.getElementById('noteToggleViewBtn');
    const eyeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    const editIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 4 21l.5-3.5L17 3z"/></svg>';
    toggleViewBtn?.addEventListener('click', () => {
      const isPreviewOnly = noteViewEl.classList.toggle('preview-only');
      toggleViewBtn.innerHTML = isPreviewOnly ? editIcon : eyeIcon;
      toggleViewBtn.setAttribute('aria-label', isPreviewOnly ? 'Edit note' : 'Preview only');
    });

    const titleInput = document.getElementById('noteTitleInput');
    const contentInput = document.getElementById('noteContentInput');
    const preview = document.getElementById('notePreview');
    const previewScroll = document.getElementById('notePreviewScroll');
    const wordCount = document.getElementById('noteWordCount');

    const attachLinkHandlers = () => {
      previewScroll.querySelectorAll('.note-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const targetTitle = link.dataset.noteTitle;
          const target = notes.find(n => n.title.toLowerCase() === targetTitle.toLowerCase());
          if (target) {
            history.pushState(null, '', `#note/${target.id}`);
            this.handleRoute();
          } else {
            this.toast('Note not found: ' + targetTitle, 'error');
          }
        });
      });
    };

    let currentQuestions = note.questions && note.questions.length ? [...note.questions] : [];

    let updatePreview = debounce(async () => {
      const content = contentInput.value || '';
      const prevScroll = previewScroll.scrollTop;
      if (content.trim()) {
        previewScroll.className = 'note-preview-scroll';
        previewScroll.innerHTML = parseMarkdown(content, currentQuestions);
      } else {
        previewScroll.className = 'note-editor-empty';
        previewScroll.innerHTML = `
          <img class="note-editor-empty-illo" src="assets/illustrations/Documents-4--Streamline-Bangalore.png" alt="">
          <p>Nothing here yet — start typing in the editor to bring your note to life.</p>`;
      }
      const maxScroll = previewScroll.scrollHeight - previewScroll.clientHeight;
      previewScroll.scrollTop = prevScroll > maxScroll ? Math.max(0, maxScroll) : prevScroll;
       wordCount.textContent = content.split(/\s+/).filter(Boolean).length + ' words';

       const reflectionDots = document.getElementById('noteReflectionDots');
       if (reflectionDots) {
         const candidates = SQ.analyze(content, currentQuestions);
         const resolved = currentQuestions.filter((q) => q.resolved).length;
         const total = currentQuestions.length + candidates.length;
         const level = total === 0 ? 0 : Math.min(5, 1 + Math.round((total / 6) * 4));
         reflectionDots.innerHTML = Array.from({ length: 5 }, (_, i) =>
           `<span class="note-reflection-dot ${i < level ? (resolved >= total && total ? 'done' : 'on') : ''}"></span>`
         ).join('');
         reflectionDots.parentElement?.setAttribute('title',
           total === 0 ? 'Write a question or a doubt to grow your reflection'
                      : `${total} open inquiry${total > 1 ? 'ies' : 'y'}${resolved ? `, ${resolved} resolved` : ''}`);
       }
       attachLinkHandlers();
       this.renderMathInPreview();

       const title = titleInput.value.trim();
       const subjectId = document.getElementById('noteSubjectSelect').value || null;

       // Preview/reflection always updates. Persisting is gated by noteAutosave.
       if (!Settings.get('noteAutosave') || !title) return;

       const existing = await Storage.getNote(note.id);
       const noteObj = { ...existing, id: note.id, title, subjectId, content, questions: currentQuestions };
       await Storage.saveNote(noteObj);
       this.renderBacklinks(noteObj, await Storage.getAllNotes());
     }, 400);

    titleInput?.addEventListener('input', updatePreview);
    contentInput?.addEventListener('input', updatePreview);
    document.getElementById('noteSubjectSelect')?.addEventListener('change', updatePreview);

    attachLinkHandlers();
    this.renderBacklinks(note, notes);

    // ── Questions tracking ───────────────────────────────────────────────────
    const questionsListEl = document.getElementById('questionsList');
    const questionsCountEl = document.getElementById('noteQuestionsCount');

    const saveCurrentQuestions = async () => {
      const existing = await Storage.getNote(note.id);
      if (!existing) return;
      const title = titleInput.value.trim();
      const subjectId = document.getElementById('noteSubjectSelect').value || null;
      const noteObj = { ...existing, id: note.id, title, subjectId, content: contentInput.value, questions: currentQuestions };
      await Storage.saveNote(noteObj);
      note.questions = currentQuestions;
    };

    const renderQuestionsPanel = () => {
      if (!questionsListEl) return;
      const unresolved = currentQuestions.filter(q => !q.resolved).length;
      if (questionsCountEl) {
        questionsCountEl.textContent = currentQuestions.length > 0
          ? `${currentQuestions.length} total, ${unresolved} unresolved`
          : '';
      }

      if (currentQuestions.length === 0) {
        questionsListEl.innerHTML = `
          <div class="note-questions-empty note-questions-onboard">
            <img class="note-questions-illo" src="assets/illustrations/I-Have-A-Question-2--Streamline-Bangalore.png" alt="">
            <h3>No questions yet</h3>
            <p class="note-questions-onboard-text">Turn what you're unsure about into reviewable questions. As you write in the editor, we'll spot these moments and offer to capture them:</p>
            <ul class="note-questions-howto">
              <li><strong>Ask directly</strong> — end a line with <code>?</code> or start with a question word (What, Why, How…).</li>
              <li><strong>Name a doubt</strong> — write "I'm not sure…", "confused about…", or "stuck on…".</li>
              <li><strong>Stay curious</strong> — hedges like "maybe" or "I think" paired with a question also count.</li>
            </ul>
            <p class="note-questions-onboard-hint">When we spot one, a small chip appears — tap <em>Add</em> and it becomes a tracked question you can answer and resolve.</p>
          </div>`;
        return;
      }

      questionsListEl.innerHTML = currentQuestions.map(q => `
        <div class="note-question-item ${q.resolved ? 'resolved' : ''}" data-question-id="${q.id}">
          <div class="note-question-body">
            <div class="note-question-text">${escapeHtml(q.text)}</div>
            ${q.answer ? `<div class="note-question-answer"><strong>Answer:</strong> ${escapeHtml(q.answer)}</div>` : ''}
            ${!q.resolved ? `<div class="note-question-add-answer" data-question-id="${q.id}">
              <input type="text" placeholder="Add an answer...">
              <button class="btn btn-ghost btn-sm btn-answer-save" data-id="${q.id}">Save</button>
            </div>` : ''}
          </div>
          <div class="note-question-actions">
            <button class="btn btn-ghost btn-sm btn-toggle-resolve" data-id="${q.id}">${q.resolved ? 'Reopen' : 'Resolve'}</button>
            <button class="btn btn-danger btn-sm btn-delete-question" data-id="${q.id}">Delete</button>
          </div>
        </div>
      `).join('');

      questionsListEl.querySelectorAll('.btn-answer-save').forEach(btn => {
        btn.addEventListener('click', async () => {
          const qid = btn.dataset.id;
          const item = questionsListEl.querySelector(`[data-question-id="${qid}"]`);
          const input = item?.querySelector('.note-question-add-answer input');
          const text = input?.value.trim();
          if (!text) return;
          const q = currentQuestions.find(x => x.id === qid);
          if (!q) return;
          q.answer = text;
          await saveCurrentQuestions();
          renderQuestionsPanel();
          this.toast('Answer saved');
        });
      });

      questionsListEl.querySelectorAll('.note-question-add-answer input').forEach(input => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const qid = input.closest('[data-question-id]')?.dataset.questionId;
            const btn = questionsListEl.querySelector(`.btn-answer-save[data-id="${qid}"]`);
            btn?.click();
          }
        });
      });

      questionsListEl.querySelectorAll('.btn-toggle-resolve').forEach(btn => {
        btn.addEventListener('click', async () => {
          const qid = btn.dataset.id;
          const q = currentQuestions.find(x => x.id === qid);
          if (!q) return;
          q.resolved = !q.resolved;
          await saveCurrentQuestions();
          renderQuestionsPanel();
          this.toast(q.resolved ? 'Question resolved' : 'Question reopened');
        });
      });

      questionsListEl.querySelectorAll('.btn-delete-question').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this question?')) return;
          const qid = btn.dataset.id;
          currentQuestions = currentQuestions.filter(x => x.id !== qid);
          await saveCurrentQuestions();
          renderQuestionsPanel();
        });
      });
    };

    const attachQuestionToLine = async (lineNumber, text) => {
      const question = {
        id: 'ques_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        text,
        answer: null,
        resolved: false,
        createdAt: new Date().toISOString(),
        lineNumber,
      };
      currentQuestions.push(question);

      const content = contentInput.value || '';
      const lines = content.split('\n');
      const targetLine = Math.max(0, Math.min(lineNumber - 1, lines.length - 1));
      lines.splice(targetLine + 1, 0, `[Q:${question.id}]`);
      contentInput.value = lines.join('\n');
      await saveCurrentQuestions();
      updatePreview();
      this.toast('Question added to your reflection', 'success');
    };

    // Soft inline chip shown beside a detected candidate line
    const showInlinePrompt = (lineNumber, cleaned) => {
      const existing = document.querySelector(`.sq-prompt[data-line="${lineNumber}"]`);
      if (existing) return;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sq-prompt';
      chip.dataset.line = String(lineNumber);
      chip.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><line x1="12" y1="17" x2="12" y2="17"/></svg>
        Turn this into a question?
      `;

      const menu = document.createElement('div');
      menu.className = 'sq-prompt-menu';
      menu.innerHTML = `
        <div class="sq-prompt-text" title="${escapeHtml(cleaned)}">${escapeHtml(cleaned.length > 80 ? cleaned.slice(0, 80) + '…' : cleaned)}</div>
        <div class="sq-prompt-actions">
          <button type="button" class="btn btn-primary btn-sm sq-add">Add</button>
          <button type="button" class="btn btn-ghost btn-sm sq-dismiss">Dismiss</button>
        </div>
      `;

      chip.addEventListener('click', () => {
        const open = chip.classList.toggle('open');
        if (open) {
          document.querySelectorAll('.sq-prompt.open').forEach((c) => { if (c !== chip) c.classList.remove('open'); });
        }
      });
      menu.querySelector('.sq-add').addEventListener('click', () => {
        attachQuestionToLine(lineNumber, cleaned || `From line ${lineNumber}`);
        chip.remove();
      });
      menu.querySelector('.sq-dismiss').addEventListener('click', () => {
        chip.classList.add('dismissed');
        chip.remove();
      });

      const host = document.getElementById('sqPromptHost') || (() => {
        const el = document.createElement('div');
        el.id = 'sqPromptHost';
        el.className = 'sq-prompt-host';
        document.querySelector('.note-editor')?.appendChild(el);
        return el;
      })();
      chip.appendChild(menu);
      host.appendChild(chip);
    };

    const detectAndPromptQuestions = debounce(async () => {
      if (!contentInput) return;
      const content = contentInput.value || '';
      const candidates = SQ.analyze(content, currentQuestions);

      // Stamp detected line numbers onto questions that lack one (so re-checks skip them)
      let mutated = false;
      for (const q of currentQuestions) {
        if (typeof q.lineNumber !== 'number') {
          const idx = content.split('\n').findIndex((l) => l.includes(`[Q:${q.id}]`));
          if (idx >= 0) { q.lineNumber = idx + 1; mutated = true; }
        }
      }
      if (mutated) await saveCurrentQuestions().catch(() => {});

      candidates.slice(0, 6).forEach((c) => showInlinePrompt(c.lineNumber, c.line));
    }, 500);

    contentInput?.addEventListener('input', detectAndPromptQuestions);

    // ── Patch updatePreview to also sync questions ───────────────────────────
    const updatePreview_original = updatePreview;
    updatePreview = async () => {
      await updatePreview_original();
      renderQuestionsPanel();
    };

    titleInput?.removeEventListener('input', updatePreview_original);
    contentInput?.removeEventListener('input', updatePreview_original);
    document.getElementById('noteSubjectSelect')?.removeEventListener('change', updatePreview_original);
    titleInput?.addEventListener('input', updatePreview);
    contentInput?.addEventListener('input', updatePreview);
    document.getElementById('noteSubjectSelect')?.addEventListener('change', updatePreview);

    // Initial render
    renderQuestionsPanel();

    // ── Preview tooltip + collapse toggle for question markers ───────────────
    const previewTooltip = document.getElementById('previewQuestionTooltip');
    if (previewScroll && previewTooltip) {
      attachQuestionTooltip({
        container: previewScroll,
        tooltipEl: previewTooltip,
        questions: currentQuestions,
      });
    }
    attachQuestionToggle(previewScroll);

    const recordBtn = document.getElementById('noteRecordBtn');
    const stopBtn = document.getElementById('noteStopRecordBtn');
    const statusEl = document.getElementById('noteRecordingStatus');
    const timerEl = document.getElementById('noteRecordingTimer');
    const recordingsList = document.getElementById('noteRecordingsList');

    let mediaRecorder = null;
    let chunks = [];
    let recordingStart = null;
    let timerInterval = null;
    let currentAudio = null;

    const formatRecordingTime = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };

    const renderRecordings = async () => {
      const recordings = await Storage.getRecordingsForNote(note.id);
      if (recordings.length === 0) {
        recordingsList.innerHTML = '<p class="subtle" style="font-size:0.8rem">No recordings yet</p>';
        return;
      }
      recordingsList.innerHTML = recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((r, idx) => {
        const date = new Date(r.createdAt);
        const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const sizeMB = (r.blob.size / (1024 * 1024)).toFixed(1);
        return `
          <div class="note-recording-item" data-recording-id="${r.id}">
            <div class="note-recording-info">
              <span class="note-recording-title">Recording ${recordings.length - idx}</span>
              <span class="subtle" style="font-size:0.72rem">${timeStr} · ${sizeMB} MB</span>
            </div>
            <div class="note-recording-actions">
              <button class="btn btn-ghost btn-sm note-play-btn" data-id="${r.id}" aria-label="Play">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
              <button class="btn btn-ghost btn-sm note-download-btn" data-id="${r.id}" aria-label="Download">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="btn btn-danger btn-sm note-delete-recording-btn" data-id="${r.id}" aria-label="Delete">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');

      recordingsList.querySelectorAll('.note-play-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const rec = await Storage.getRecording(btn.dataset.id);
          if (!rec) return;
          if (currentAudio) { currentAudio.pause(); currentAudio = null; }
          const url = URL.createObjectURL(rec.blob);
          currentAudio = new Audio(url);
          currentAudio.play();
          btn.textContent = 'Playing...';
          currentAudio.onended = () => { btn.textContent = 'Play'; URL.revokeObjectURL(url); };
        });
      });

      recordingsList.querySelectorAll('.note-download-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const rec = await Storage.getRecording(btn.dataset.id);
          if (!rec) return;
          const url = URL.createObjectURL(rec.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `note-${note.id}-recording-${rec.id}.webm`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      });

      recordingsList.querySelectorAll('.note-delete-recording-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this recording?')) return;
          await Storage.deleteRecording(btn.dataset.id);
          this.toast('Recording deleted', 'success');
          renderRecordings();
        });
      });
    };

    recordBtn?.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        chunks = [];
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const recording = {
            id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            noteId: note.id,
            blob,
            mimeType: blob.type,
            size: blob.size,
          };
          await Storage.saveRecording(recording);
          this.toast('Recording saved', 'success');
          renderRecordings();
        };
        mediaRecorder.start();
        recordingStart = Date.now();
        recordBtn.classList.add('hidden');
        statusEl.classList.remove('hidden');
        timerInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - recordingStart) / 1000);
          timerEl.textContent = formatRecordingTime(elapsed);
        }, 1000);
      } catch (err) {
        console.error('Microphone error:', err);
        this.toast('Microphone access denied or unavailable', 'error');
      }
    });

    stopBtn?.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      clearInterval(timerInterval);
      timerEl.textContent = '00:00';
      statusEl.classList.add('hidden');
      recordBtn.classList.remove('hidden');
    });

    renderRecordings();

    if (needsQuestRefresh) {
      this.evaluateDailyQuest().catch(() => {});
    }
  },

  renderBacklinks(currentNote, allNotes) {
    const container = document.getElementById('noteBacklinks');
    if (!container) return;

    const escapedTitle = currentNote.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const backlinks = allNotes.filter(n => {
      if (n.id === currentNote.id) return false;
      const regex = new RegExp('\\[\\[' + escapedTitle + '\\]\\]', 'i');
      return regex.test(n.content || '');
    });

    if (backlinks.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <h3>Linked from</h3>
      ${backlinks.map(n => `
        <div class="note-backlink-item" data-note-id="${n.id}">
          <strong>${escapeHtml(n.title)}</strong>
          <span class="muted text-sm">${formatDate(n.updatedAt || n.createdAt)}</span>
        </div>
      `).join('')}
    `;

    container.querySelectorAll('.note-backlink-item').forEach(item => {
      item.addEventListener('click', () => {
        history.pushState(null, '', `#note/${item.dataset.noteId}`);
        this.handleRoute();
      });
    });
  },

  renderMathInPreview() {
    const targets = [
      document.getElementById('notePreviewScroll'),
      document.getElementById('previewModalContent'),
    ].filter(Boolean);
    if (typeof katex === 'undefined') return;
    targets.forEach(container => {
      container.querySelectorAll('.katex-math').forEach(el => {
        if (el.dataset.katexRendered) return;
        try {
          katex.render(el.textContent, el, { throwOnError: false, displayMode: el.tagName === 'DIV' });
          el.dataset.katexRendered = '1';
        } catch (e) {
          // leave raw LaTeX if KaTeX fails
        }
      });
    });
  },

  async renderStatistics() {
    const el = document.getElementById('pageContent');
    const sessions = await Storage.getAllSessions();
    const subjects = await Storage.getAllSubjects();

    if (sessions.length === 0) {
      el.innerHTML = `
        <div class="page-header"><h1>Statistics</h1></div>
        <div class="empty-state card empty-state-lg">
          <img class="empty-illo" src="assets/illustrations/Business-Charts-Pie-And-Bars--Streamline-Bangalore.png" alt="">
          <h3>No data yet</h3>
          <p>Complete your first study session to start seeing statistics here.</p>
        </div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="page-header"><h1>Statistics</h1></div>
      <div class="grid grid-4 gap" id="statsGrid">
        <div class="card"><div class="stat-value" id="statTotalTime">...</div><div class="stat-label">Total Time</div></div>
        <div class="card"><div class="stat-value" id="statWeekTime">...</div><div class="stat-label">This Week</div></div>
        <div class="card"><div class="stat-value" id="statMonthTime">...</div><div class="stat-label">This Month</div></div>
        <div class="card"><div class="stat-value" id="statLongest">...</div><div class="stat-label">Longest Session</div></div>
        <div class="card"><div class="stat-value" id="statAvg">...</div><div class="stat-label">Avg Session</div></div>
        <div class="card"><div class="stat-value" id="statTotalSessions">...</div><div class="stat-label">Sessions</div></div>
        <div class="card"><div class="stat-value" id="statStreak">...</div><div class="stat-label">Streak</div></div>
      </div>
      <div class="grid grid-2 gap mt stats-charts">
        <div class="card" id="barChartCard">
          <div class="card-header"><h2>Last 7 Days</h2></div>
          <div style="position:relative;height:200px">
            <canvas id="barChart"></canvas>
          </div>
        </div>
        <div class="card" id="doughnutChartCard">
          <div class="card-header"><h2>By Subject</h2></div>
          <div style="position:relative;height:200px">
            <canvas id="doughnutChart"></canvas>
          </div>
        </div>
      </div>

      <div class="card mt" id="forecastCard">
        <div class="card-header flex justify-between items-center">
          <h2>Forecast &amp; Pacing</h2>
          <span class="badge" id="forecastBadge">…</span>
        </div>
        <p class="muted text-sm" id="forecastSummary">Predicting your week…</p>
        <div class="forecast-grid grid grid-3 gap mt">
          <div class="forecast-stat">
            <div class="stat-value" id="forecastPerDay">…</div>
            <div class="stat-label">Min / day to goal</div>
          </div>
          <div class="forecast-stat">
            <div class="stat-value" id="forecastNextWeek">…</div>
            <div class="stat-label">Next week (trend)</div>
          </div>
          <div class="forecast-stat">
            <div class="stat-value" id="forecastStreakRisk">…</div>
            <div class="stat-label">Streak-break risk</div>
          </div>
        </div>
        <div style="position:relative;height:180px" class="mt">
          <canvas id="forecastChart"></canvas>
        </div>
      </div>
    `;

    const total = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const weekDates = getWeekDates();
    const weekSessions = sessions.filter((s) => weekDates.includes(s.date));
    const weekTime = weekSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthSessions = sessions.filter((s) => new Date(s.date) >= monthStart);
    const monthTime = monthSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const longest = sessions.reduce((max, s) => Math.max(max, s.duration || 0), 0);
    const avg = sessions.length > 0 ? Math.round(total / sessions.length) : 0;
    const streak = this.calculateStreak(sessions);

    document.getElementById('statTotalTime').textContent = formatDuration(total);
    document.getElementById('statWeekTime').textContent = formatDuration(weekTime);
    document.getElementById('statMonthTime').textContent = formatDuration(monthTime);
    document.getElementById('statLongest').textContent = formatDuration(longest);
    document.getElementById('statAvg').textContent = formatDuration(avg);
    document.getElementById('statTotalSessions').textContent = sessions.length;
    document.getElementById('statStreak').textContent = streak + ' days';

    if (typeof Chart !== 'undefined') {
      Chart.getChart('barChart')?.destroy();
      Chart.getChart('doughnutChart')?.destroy();
      const last7 = getWeekDates();
      const dailyData = last7.map((d) => {
        const daySessions = sessions.filter((s) => s.date === d);
        return Math.round(daySessions.reduce((sum, s) => sum + (s.duration || 0), 0) / 60);
      });
      const dayLabels = last7.map((d) => {
        const date = new Date(d + 'T12:00:00');
        return date.toLocaleDateString(Settings.locale(), { weekday: 'short', month: 'short', day: 'numeric' });
      });

      new Chart(document.getElementById('barChart'), {
        type: 'bar',
        data: {
          labels: dayLabels,
          datasets: [{
            label: 'Minutes',
            data: dailyData,
            backgroundColor: '#1a7a3c',
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true } },
        },
      });

      const subjectData = subjects.map((s) => {
        const subjSessions = sessions.filter((x) => x.subjectId === s.id);
        return {
          name: s.name,
          total: subjSessions.reduce((sum, x) => sum + (x.duration || 0), 0),
          color: s.color,
        };
      }).filter((s) => s.total > 0);

      if (subjectData.length > 0) {
        new Chart(document.getElementById('doughnutChart'), {
          type: 'doughnut',
          data: {
            labels: subjectData.map((s) => s.name),
            datasets: [{
              data: subjectData.map((s) => Math.round(s.total / 60)),
              backgroundColor: subjectData.map((s) => s.color),
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
          },
        });
      } else {
        document.getElementById('doughnutChartCard').innerHTML = '<p class="muted text-center mt">No subject data available</p>';
      }
    }

    this.renderForecast(sessions, subjects);
  },

  async renderForecast(sessions, subjects) {
    const wk = getWeekDates();
    const daysLeft = wk.slice(wk.indexOf(getToday()) + 1).length + 1; // inclusive of today
    const weeklyTargetSec = subjects.reduce((sum, s) => sum + (Number(s.weeklyGoal) || 0), 0);
    const forecast = buildForecast(sessions, Math.round(weeklyTargetSec / 60), {
      weekStartDay: Settings.weekStartDay(),
      currentStreak: this.calculateStreak(sessions),
      daysLeftThisWeek: daysLeft,
    });

    const badge = document.getElementById('forecastBadge');
    const summary = document.getElementById('forecastSummary');
    const perDay = document.getElementById('forecastPerDay');
    const nextWeek = document.getElementById('forecastNextWeek');
    const riskEl = document.getElementById('forecastStreakRisk');
    if (!badge || !forecast) return;

    const target = forecast.weeklyTargetMinutes;
    if (target <= 0) {
      badge.textContent = 'No goal set';
      badge.className = 'badge badge-muted';
      summary.textContent = 'Set a weekly goal per subject to unlock pacing forecasts.';
      perDay.textContent = '—';
      nextWeek.textContent = formatDuration(forecast.nextWeekForecast * 60);
      riskEl.textContent = Math.round(forecast.streakRisk.risk * 100) + '%';
      return;
    }

    const remainingMin = forecast.pace.remaining;
    const onTrack = remainingMin <= 0;
    badge.textContent = onTrack ? 'On track' : 'Needs focus';
    badge.className = 'badge ' + (onTrack ? 'badge-success' : 'badge-warning');
    summary.innerHTML = onTrack
      ? `You've already hit your weekly goal of <strong>${formatDuration(target * 60)}</strong>. Keep the streak alive!`
      : `You need <strong>${formatDuration(remainingMin * 60)}</strong> more this week — about <strong>${forecast.pace.perDay}m/day</strong> over the next ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`;

    perDay.textContent = onTrack ? '✓' : forecast.pace.perDay + 'm';
    nextWeek.textContent = formatDuration(forecast.nextWeekForecast * 60);
    const riskPct = Math.round(forecast.streakRisk.risk * 100);
    riskEl.textContent = riskPct + '%';
    riskEl.style.color = riskPct > 66 ? 'var(--danger,#ef4444)' : riskPct > 33 ? 'var(--warning,#f59e0b)' : 'var(--success,#10b981)';

    if (typeof Chart !== 'undefined') {
      Chart.getChart('forecastChart')?.destroy();
      const hist = forecast.history;
      // Build a projection line: past weekly minutes + forecast weeks ahead.
      const labels = [...hist.labels];
      const actual = [...hist.minutes];
      const projected = new Array(hist.minutes.length).fill(null);
      const model = holtForecast(hist.currentWeekIndex > 0 ? hist.minutes.slice(0, hist.currentWeekIndex) : hist.minutes);
      for (let k = 1; k <= 3; k++) {
        labels.push('+W' + k);
        actual.push(null);
        projected.push(Math.round(model.forecast(k)));
      }
      // Anchor the projection to the last actual value for visual continuity.
      projected[hist.minutes.length - 1] = hist.minutes[hist.minutes.length - 1] || 0;

      new Chart(document.getElementById('forecastChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Actual (min/week)',
              data: actual,
              borderColor: '#1a7a3c',
              backgroundColor: 'rgba(26,122,60,0.12)',
              spanGaps: false,
              tension: 0.25,
              fill: true,
            },
            {
              label: 'Forecast (Holt trend)',
              data: projected,
              borderColor: '#6366f1',
              borderDash: [6, 4],
              spanGaps: true,
              tension: 0.25,
              fill: false,
              pointStyle: 'rectRot',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom' } },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'Minutes' } } },
        },
      });
    }
  },

  /* ------------------------------------------------------------------ */
  /* Quests & Levels                                                     */
  /* ------------------------------------------------------------------ */

  questRankTitle(level) {
    const ranks = [
      'Novice', 'Apprentice', 'Scholar', 'Adept', 'Keeper', 'Sage',
      'Mentor', 'Luminary', 'Archmage', 'Legend',
    ];
    return ranks[Math.min(ranks.length - 1, Math.floor((level - 1) / 5))];
  },

  questUnitSeconds(goal) {
    if (!goal) return 3600;
    if (goal.unit === 'minutes') return 60;
    if (goal.unit === 'sessions') return 1;
    return 3600; // hours
  },

  // Human-readable current value for a quest given its stored progress (seconds).
  questCurrentValue(goal) {
    if (!goal) return 0;
    const unit = this.questUnitSeconds(goal);
    if (goal.unit === 'sessions') return goal.progress || 0; // one session == one unit
    return (goal.progress || 0) / unit;
  },

  questProgress(goal, sessions, weekSet) {
    if (!goal) return 0;
    const unit = this.questUnitSeconds(goal);
    if (goal.type === 'daily') {
      // Study-time dailies track today's focused seconds; task-type dailies
      // (e.g. "revisit notes") store their progress directly on the goal.
      if (goal.kind === 'task' || goal.metric) {
        return (goal.progress || 0) / unit / (goal.target || 1);
      }
      return sessions.filter((s) => s.date === getToday())
        .reduce((sum, s) => sum + (s.duration || 0), 0) / unit;
    }
    if (goal.type === 'subject-weekly') {
      return sessions.filter((s) => s.subjectId === goal.subjectId && s.date && weekSet.has(s.date))
        .reduce((sum, s) => sum + (s.duration || 0), 0) / unit;
    }
    // generic quest (linked via timer progress field); progress is stored in
    // seconds, so divide by the unit to compare against the target.
    return (goal.progress || 0) / unit / (goal.target || 1);
  },

  // Progress (0..1) for a daily quest on the correct track. Task-type dailies
  // read stored progress; study-type dailies sum today's session duration.
  dailyProgress(daily, sessions) {
    if (!daily) return 0;
    if (daily.kind === 'task' || daily.metric) {
      const unit = this.questUnitSeconds(daily);
      return (daily.progress || 0) / unit / (daily.target || 1);
    }
    const unit = this.questUnitSeconds(daily);
    const secs = (sessions || [])
      .filter((s) => s.date === getToday())
      .reduce((sum, s) => sum + (s.duration || 0), 0);
    return secs / unit;
  },

  async renderGoals() {
    const el = document.getElementById('pageContent');
    const [goals, sessions, subjects] = await Promise.all([
      Storage.getAllGoals(), Storage.getAllSessions(), Storage.getAllSubjects(),
    ]);
    const profile = Settings.questProfile();
    const info = Settings.questLevelInfo(profile.xp);
    const weekSet = new Set(getWeekDates());

    const quests = goals.filter((g) => g.type !== 'daily' && g.active).sort((a, b) => (a.order || 0) - (b.order || 0));
    const daily = goals.find((g) => g.type === 'daily' && g.active);
    const streak = this.calculateStreak(sessions);

    el.innerHTML = `
      <div class="page-header flex justify-between items-center page-header-inline">
        <h1>Quests</h1>
        <button class="btn btn-primary btn-sm" id="addQuestBtn">+ New quest</button>
      </div>

      <div class="quest-hero card">
        <div class="quest-hero-avatar" aria-hidden="true">
          <div class="quest-level-badge">${info.level}</div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="6"/><path d="M8.5 13.5 7 22l5-3 5 3-1.5-8.5"/>
          </svg>
        </div>
        <div class="quest-hero-body">
          <div class="quest-hero-top">
            <div>
              <div class="quest-rank">${this.questRankTitle(info.level)}</div>
              <div class="quest-level">Level ${info.level}</div>
            </div>
            <div class="quest-streak" title="Day streak">🔥 ${streak} day${streak === 1 ? '' : 's'}</div>
          </div>
          <div class="quest-xp">
            <div class="progress-bar quest-xp-bar">
              <div class="progress-fill" style="width:${info.pct}%"></div>
            </div>
            <div class="quest-xp-label">${info.into} / ${info.span} XP · ${info.toNext} to next level</div>
          </div>
          ${this.questHeroTrackedHtml(goals)}
        </div>
      </div>

      ${daily ? this.dailyQuestEditorHtml(daily, sessions) : `
        <div class="card mt">
          <p class="muted">No daily quest set. The app creates one for you each day — or set your own below.</p>
          <button class="btn btn-primary btn-sm mt-sm" id="createDailyBtn">Create daily quest</button>
        </div>`}

      ${quests.length === 0 ? `
        <div class="empty-state card mt empty-state-lg">
          <img class="empty-illo" src="assets/illustrations/Business-Go-To-Market-Strategy-01--Streamline-Bangalore.png" alt="">
          <h3>No quests yet</h3>
          <p>Create a quest — like “Finish Chapter 3” or “30 minutes of Spanish” — and watch your XP grow as you study.</p>
        </div>` : `
        <div class="quests-grid grid grid-2 gap mt">
          ${quests.map((q) => this.questCardHtml(q, this.questProgress(q, sessions, weekSet), { subjects, activeGoalId: (this.engine && this.engine.goalId) || this.pendingGoalId || null })).join('')}
        </div>
      `}
    `;

    document.getElementById('addQuestBtn')?.addEventListener('click', () => this.showQuestForm());

    const saveDaily = async () => {
      const dailyGoal = (await Storage.getAllGoals()).find((g) => g.id === 'daily' && g.active);
      if (!dailyGoal) return;
      const t = parseFloat(document.getElementById('dailyTargetInput')?.value);
      const u = document.getElementById('dailyUnitInput')?.value;
      if (!t || t <= 0) return this.toast('Enter a valid target', 'error');
      dailyGoal.target = t;
      dailyGoal.unit = u;
      dailyGoal.kind = (u === 'hours' || u === 'minutes') ? 'study' : 'task';
      if (dailyGoal.kind === 'task') dailyGoal.metric = dailyGoal.metric || 'notesReviewed';
      dailyGoal.progress = 0;
      dailyGoal.completedDate = undefined;
      dailyGoal.forDate = getToday();
      await Storage.saveGoal(dailyGoal);
      this.toast('Daily quest updated', 'success');
      this.renderGoals();
    };
    document.getElementById('saveDailyBtn')?.addEventListener('click', saveDaily);
    document.getElementById('rerollDailyBtn')?.addEventListener('click', async () => {
      const fresh = buildDailyQuest(getToday());
      fresh.forDate = getToday();
      await Storage.saveGoal(fresh);
      this.toast('New daily quest rolled!', 'success');
      this.renderGoals();
    });
    document.getElementById('createDailyBtn')?.addEventListener('click', async () => {
      const fresh = buildDailyQuest(getToday());
      await Storage.saveGoal(fresh);
      this.renderGoals();
    });

    el.querySelectorAll('[data-quest-edit]').forEach((b) => {
      b.addEventListener('click', () => this.showQuestForm(goals.find((g) => g.id === b.dataset.questEdit)));
    });
    el.querySelectorAll('[data-quest-delete]').forEach((b) => {
      b.addEventListener('click', () => this.deleteQuest(b.dataset.questDelete));
    });
    el.querySelectorAll('[data-quest-link]').forEach((b) => {
      b.addEventListener('click', () => {
        this.pendingGoalId = b.dataset.questLink;
        history.pushState(null, '', '#timer');
        this.handleRoute();
        this.toast('Pick this quest in the Timer to earn progress', 'success');
      });
    });
    el.querySelectorAll('[data-quest-how]').forEach((b) => {
      b.addEventListener('click', () => this.showQuestHowTo(b.dataset.questHow, b.dataset.questLabel));
    });
  },

  dailyQuestEditorHtml(daily, sessions) {
    const isStudy = daily.kind === 'study' || daily.unit === 'hours' || daily.unit === 'minutes';
    const goalHours = isStudy ? (daily.target || 0) : 0;
    const h = Math.floor(goalHours);
    const m = Math.round((goalHours - h) * 60);
    const targetVal = isStudy ? (h > 0 ? h : '') : (daily.target || '');
    const isHours = daily.unit !== 'minutes';
    const unitLabel = daily.unit === 'minutes' ? 'min' : daily.unit === 'sessions' ? 'sessions' : 'h';
    const pct = Math.min(100, Math.round(this.dailyProgress(daily, sessions) * 100));
    const done = pct >= 100;
    return `
      <div class="card mt daily-quest-editor">
        <div class="daily-quest-editor-main">
          <div class="quest-icon daily-quest-editor-ico">🎯</div>
          <div class="daily-quest-editor-body">
            <div class="flex justify-between items-center gap">
              <h2>Daily quest</h2>
              <span class="flex gap-xs items-center">
                ${!isStudy ? `<button class="btn btn-ghost btn-sm" data-quest-how="${daily.metric}" data-quest-label="${escapeHtml(daily.label || '')}" aria-label="How to complete">How?</button>` : ''}
                <span class="badge badge-primary">+${daily.bonusXp || 0} XP bonus</span>
              </span>
            </div>
            <p class="muted text-sm mt-xs">${escapeHtml(daily.description || daily.label || 'Your daily challenge.')}</p>
            <div class="progress-bar mt-sm"><div class="progress-fill ${done ? 'success' : ''}" style="width:${pct}%"></div></div>
            <div class="muted text-xs mt-xs">${done ? '✅ Complete today!' : `${pct}% · ${Math.floor(this.questCurrentValue(daily) * 10) / 10} / ${daily.target || 0} ${unitLabel}`}</div>
          </div>
        </div>
        <div class="daily-quest-editor-controls">
          <div class="form-group daily-quest-field">
            <label class="text-xs muted">Target</label>
            <input type="number" id="dailyTargetInput" min="0.1" step="${isStudy ? (isHours ? 0.5 : 5) : 1}" value="${targetVal}">
          </div>
          ${isStudy ? `
          <div class="form-group daily-quest-field">
            <label class="text-xs muted">Unit</label>
            <select id="dailyUnitInput">
              <option value="hours" ${isHours ? 'selected' : ''}>Hours</option>
              <option value="minutes" ${!isHours ? 'selected' : ''}>Minutes</option>
            </select>
          </div>` : `
          <div class="form-group daily-quest-field">
            <label class="text-xs muted">Unit</label>
            <select id="dailyUnitInput">
              <option value="${escapeHtml(daily.unit)}" selected>${escapeHtml(daily.unit)}</option>
            </select>
          </div>`}
          <div class="daily-quest-actions">
            <button class="btn btn-primary btn-sm" id="saveDailyBtn">Save</button>
            <button class="btn btn-ghost btn-sm" id="rerollDailyBtn" title="Generate a new daily quest">↻ Reroll</button>
          </div>
        </div>
      </div>
    `;
  },

  questCardHtml(goal, progress, opts = {}) {
    const pct = Math.min(100, Math.round(progress * 100));
    const done = pct >= 100;
    const diff = goal.difficulty || 'normal';
    const icon = goal.icon || this.questIconFor(diff);
    const subjectName = opts.subjects
      ? (opts.subjects.find((s) => s.id === goal.subjectId) || {}).name
      : '';
    const isTracking = opts.activeGoalId && opts.activeGoalId === goal.id;
    const unitLabel = goal.unit === 'minutes' ? 'min' : goal.unit === 'sessions' ? 'sessions' : 'h';
    const targetLabel = goal.target != null ? `${goal.target} ${unitLabel}` : '';
    return `
      <div class="card quest-card quest-${diff} ${done ? 'quest-done' : ''}">
        <div class="quest-card-top">
          <div class="quest-icon">${icon}</div>
            <div class="quest-card-title">
              <div class="font-medium flex items-center gap-xs">${escapeHtml(goal.label || 'Quest')} ${isTracking ? '<span class="badge badge-success">Tracking</span>' : ''}</div>
            <div class="muted text-sm">${escapeHtml((goal.type === 'daily' ? 'Daily quest' : (subjectName || this.questDiffLabel(diff)) + (targetLabel ? ' · ' + targetLabel : '')))}</div>
          </div>
          ${goal.type === 'daily' ? '' : `
            <div class="quest-card-actions">
              <button class="btn btn-ghost btn-sm" data-quest-edit="${goal.id}" aria-label="Edit">✎</button>
              <button class="btn btn-ghost btn-sm" data-quest-delete="${goal.id}" aria-label="Delete">🗑</button>
            </div>`}
        </div>
        <div class="quest-progress">
          <div class="progress-bar"><div class="progress-fill ${done ? 'success' : ''}" style="width:${pct}%"></div></div>
          <div class="quest-progress-label">${done ? '✅ Complete!' : `${Math.floor(this.questCurrentValue(goal) * 10) / 10} / ${goal.target || 0} ${unitLabel}`}</div>
        </div>
        ${goal.type === 'daily' ? '' : `
          <div class="flex gap-xs mt-sm">
            ${goal.metric ? `<button class="btn btn-ghost btn-sm" data-quest-how="${goal.metric}" data-quest-label="${escapeHtml(goal.label || '')}">How to complete</button>` : ''}
            <button class="btn btn-ghost btn-sm btn-block" data-quest-link="${goal.id}">Earn in Timer →</button>
          </div>`}
      </div>
    `;
  },

  questDiffLabel(d) {
    return { easy: 'Easy quest', normal: 'Normal quest', hard: 'Hard quest', epic: 'Epic quest' }[d] || 'Quest';
  },

  questIconFor(d) {
    return {
      easy: '⭐', normal: '🎯', hard: '⚔️', epic: '🐉',
    }[d] || '🎯';
  },

  async showQuestForm(quest) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!quest;
    const data = quest || { id: generateId(), type: 'quest', label: '', target: 1, unit: 'hours', difficulty: 'normal', active: true, progress: 0, order: 0 };
    this.openModal(`
      <div class="modal-overlay">
        <div class="modal">
          <div class="modal-header"><h2>${isEdit ? 'Edit' : 'New'} Quest</h2></div>
          <form id="questForm" class="p">
            <input type="hidden" id="questId" value="${data.id}">
            <div class="form-group">
              <label>Quest name</label>
              <input type="text" id="questLabel" required value="${escapeHtml(data.label || '')}" placeholder="e.g. Conquer Calculus">
            </div>
            <div class="form-group">
              <label>Subject (optional)</label>
              <select id="questSubject">
                <option value="">No subject</option>
                ${subjects.map((s) => `<option value="${s.id}" ${data.subjectId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
              </select>
            </div>
            <div class="goal-inputs">
              <div class="form-group">
                <label class="text-xs muted">Target</label>
                <input type="number" id="questTarget" min="0.1" step="0.5" value="${data.target || 1}" required>
              </div>
            <div class="form-group">
              <label class="text-xs muted">Unit</label>
              <select id="questUnit">
                <option value="hours" ${data.unit === 'hours' ? 'selected' : ''}>Hours</option>
                <option value="minutes" ${data.unit === 'minutes' ? 'selected' : ''}>Minutes</option>
                <option value="sessions" ${data.unit === 'sessions' ? 'selected' : ''}>Sessions</option>
              </select>
            </div>
            </div>
            <div class="form-group">
              <label class="text-xs muted">Track over</label>
              <select id="questScope">
                <option value="" ${!data.scope ? 'selected' : ''}>Lifetime</option>
                <option value="weekly" ${data.scope === 'weekly' ? 'selected' : ''}>This week</option>
                <option value="subject" ${data.scope === 'subject' ? 'selected' : ''}>This subject only</option>
              </select>
            </div>
            <div class="form-group">
              <label>Difficulty</label>
              <div class="quest-diff-pick">
                ${['easy', 'normal', 'hard', 'epic'].map((d) => `
                  <button type="button" class="quest-diff-opt quest-${d} ${data.difficulty === d ? 'selected' : ''}" data-diff="${d}">
                    <span class="quest-diff-ico">${this.questIconFor(d)}</span>${this.questDiffLabel(d)}
                  </button>`).join('')}
              </div>
              <input type="hidden" id="questDiff" value="${data.difficulty || 'normal'}">
            </div>
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save quest</button>
            </div>
          </form>
        </div>
      </div>
    `);

    document.querySelectorAll('.quest-diff-opt').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.quest-diff-opt').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        document.getElementById('questDiff').value = b.dataset.diff;
      });
    });
    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('questForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = document.getElementById('questLabel').value.trim();
      if (!label) return this.toast('Name your quest', 'error');
      const existing = isEdit ? quest : null;
      const saved = {
        id: data.id,
        type: 'quest',
        label,
        subjectId: document.getElementById('questSubject').value || undefined,
        target: Math.max(0.1, parseFloat(document.getElementById('questTarget').value) || 1),
        unit: document.getElementById('questUnit').value,
        scope: document.getElementById('questScope').value || undefined,
        difficulty: document.getElementById('questDiff').value,
        active: true,
        progress: existing ? (existing.progress || 0) : 0,
        order: existing ? (existing.order || 0) : (Date.now()),
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
      };
      await Storage.saveGoal(saved);
      this.closeModals();
      this.toast('Quest saved', 'success');
      this.renderGoals();
    });
  },

  async deleteQuest(id) {
    if (!confirm('Abandon this quest?')) return;
    await Storage.deleteGoal(id);
    this.toast('Quest removed', 'success');
    this.renderGoals();
  },

  async renderSettings() {
    const el = document.getElementById('pageContent');
    const [goals, subjects] = await Promise.all([Storage.getAllGoals(), Storage.getAllSubjects()]);
    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);

    const sections = [
      {
        id: 'appearance', icon: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
        title: 'Appearance',
        keys: ['theme', 'accentColor', 'fontSize', 'density', 'reduceMotion'],
      },
      {
        id: 'locale', icon: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        title: 'Language & Format',
        keys: ['language', 'clock', 'weekStart'],
      },
      {
        id: 'timer', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        title: 'Focus Timer',
        keys: ['focusLength', 'breakLength', 'rounds', 'longBreakLength', 'longBreakEvery', 'autoStartBreaks', 'autoStartFocus', 'timerSound', 'timerVolume', 'timerVibrate', 'timerPresets'],
      },
      {
        id: 'notifications', icon: '<path d="M18 8A6 6 0 0 0 6 8c0 7 3 9 3 9h6s3-2 3-9z"/><path d="M12 18v-4"/><path d="M8 18v-1"/><path d="M16 18v-3"/>',
        title: 'Notifications',
        keys: ['notificationsEnabled', 'notifySessionReminders', 'notifyPhaseEnd', 'notifyGoalReached', 'notifyLeadTime', 'notifyQuietStart', 'notifyQuietEnd', 'testNotification'],
      },
      {
        id: 'notes', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
        title: 'Notes & Editor',
        keys: ['noteDefaultSubject', 'noteAutosave', 'noteSpellcheck', 'noteOfflineMath', 'noteDefaultLens', 'affinityTightness', 'affinityMaxGroup'],
      },
      {
        id: 'goals', icon: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        title: 'Quests',
        keys: ['goalUnit', 'streakMinMinutes', 'streakFreeze', 'goalCelebrations', 'goalCelebrationsReset'],
      },
      {
        id: 'data', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
        title: 'Data & Backup',
        keys: ['dataExportFormat', 'dataImportMode', 'dataAutoBackup', 'exportData', 'importData', 'storageUsage', 'backupNow'],
      },
      {
        id: 'about', icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        title: 'About & Maintenance',
        keys: ['aboutVersion', 'aboutUpdate', 'aboutClearCache', 'resetSettings'],
      },
      {
        id: 'danger', icon: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        title: 'Danger Zone', danger: true,
        keys: ['clearAll', 'resetDb'],
      },
    ];

    const activeTab = this.activeSettingsTab || sections[0].id;

    const html = [];
    html.push(`
      <div class="settings-header">
        <h1>Settings</h1>
        <p class="muted">Your preferences adapt instantly across the app.</p>
      </div>
      <div class="settings-nav" id="settingsNav">
        ${sections.map((s) => `<button class="settings-nav-btn ${s.id === activeTab ? 'active' : ''}" data-section="${s.id}">${s.title}</button>`).join('')}
      </div>
    `);

    for (const sec of sections) {
      const hidden = sec.id !== activeTab ? 'hidden' : '';
      html.push(`
        <section class="settings-section card ${sec.danger ? 'settings-danger-zone' : ''}" id="section-${sec.id}" ${hidden}>
          <div class="settings-section-title ${sec.danger ? 'danger' : ''}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${sec.icon}</svg>
            ${sec.title}
          </div>
          ${sec.keys.map((k) => this.settingsRowFor(k, { goals, dailyGoal, subjects })).join('')}
        </section>
      `);
    }
    el.innerHTML = html.join('');

    // Wire every control.
    this.bindSettingsControls({ goals, dailyGoal, subjects });
  },

  settingsRowFor(key, ctx = {}) {
    const def = Settings.SCHEMA[key];
    if (!def) return '';
    const val = Settings.get(key);
    const label = def.label || key;
    const help = def.help ? `<span class="subtle">${escapeHtml(def.help)}</span>` : '';
    let control = '';
    let extraClass = '';

    if (def.type === 'theme') {
      const opts = def.options;
      const icons = { light: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>', dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>', system: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' };
      const labels = { light: 'Light', dark: 'Dark', system: 'System' };
      control = `<div class="settings-theme-btns" data-control="${key}">` + opts.map((o) => `
        <button class="settings-theme-btn ${val === o ? 'active' : ''}" data-value="${o}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[o]}</svg>
          ${labels[o]}
        </button>`).join('') + `</div>`;
    } else if (def.type === 'colors') {
      control = `<div class="settings-colors" data-control="${key}">` + Object.entries(def.options).map(([k, o]) => `
        <button class="color-swatch ${val === k ? 'selected' : ''}" data-value="${k}" title="${escapeHtml(o.label)}" aria-label="${escapeHtml(o.label)}" style="background:${o.value}">
          ${val === k ? '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </button>`).join('') + `</div>`;
    } else if (def.type === 'select') {
      let opts = def.options;
      if (def.dynamic === 'subjects') {
        opts = { '': 'No subject' };
        (ctx.subjects || []).forEach((s) => { opts[s.id] = s.name; });
      }
      const entries = Object.entries(opts);
      control = `<select class="form-control" data-control="${key}" style="max-width:260px">` +
        entries.map(([v, t]) => `<option value="${v}" ${String(val) === String(v) ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('') +
        `</select>`;
    } else if (def.type === 'switch') {
      control = `<button class="switch ${val ? 'on' : ''}" data-control="${key}" role="switch" aria-checked="${val}" aria-label="${escapeHtml(label)}"><span class="switch-knob"></span></button>`;
    } else if (def.type === 'number' || def.type === 'range') {
      const unit = def.unit ? `<span class="unit">${def.unit}</span>` : '';
      const attrs = def.type === 'range'
        ? `type="range" min="${def.min}" max="${def.max}" step="${def.step}"`
        : `type="number" min="${def.min}" max="${def.max}" step="${def.step}"`;
      control = `<div class="settings-num-wrap"><input ${attrs} class="form-control" data-control="${key}" value="${val}" style="max-width:160px">${unit}<span class="settings-num-val" data-numval="${key}">${def.unit === '%' ? val + '%' : val}</span></div>`;
    } else if (def.type === 'text') {
      control = `<input type="text" class="form-control" data-control="${key}" value="${escapeHtml(val)}" style="max-width:120px" inputmode="numeric" pattern="[0-9]{1,2}:[0-9]{2}">`;
    } else if (def.type === 'button') {
      const text = {
        testNotification: 'Send test', aboutVersion: 'v' + APP_VERSION, aboutUpdate: 'Check now',
        aboutClearCache: 'Clear cache', goalCelebrationsReset: 'Reset', resetSettings: 'Reset all',
        clearAll: 'Clear All', resetDb: 'Reset DB', backupNow: 'Back up now', exportData: 'Export',
        importData: 'Import', storageUsage: 'Refresh',
      }[key] || 'Action';
      const cls = key === 'clearAll' || key === 'resetDb' ? 'btn-danger' : (def.group === 'about' ? 'btn-ghost' : 'btn-primary');
      control = `<button class="btn btn-sm ${cls}" data-action="${key}">${text}</button>`;
    } else if (def.type === 'custom') {
      if (key === 'timerPresets') {
        const presets = val || [];
        control = `<div class="settings-presets" data-control="timerPresets">` +
          (presets.length ? presets.map((p, i) => `<button class="btn btn-ghost btn-sm" data-preset-apply="${i}">${escapeHtml(p.name)}</button>`).join('') : '<span class="subtle text-sm">No saved presets</span>') +
          `</div>`;
      } else if (key === 'dailyGoalInline') {
        const dg = ctx.dailyGoal;
        control = `<div class="settings-row-control"><input type="number" id="dailyGoalInput" min="0.5" step="0.5" value="${dg ? dg.target : ''}" placeholder="e.g. 2" style="width:90px;text-align:center"><button class="btn btn-primary btn-sm" id="saveGoalBtn">Save</button></div>`;
      } else {
        control = '';
      }
    }

    if (key === 'dailyGoalInline') {
      return `<div class="settings-row"><div class="settings-row-info"><span>Daily study goal</span><span class="subtle">Target hours of study per day</span></div>${control}</div>`;
    }
    if (key === 'timerPresets') {
      return `<div class="settings-row"><div class="settings-row-info"><span>Saved presets</span><span class="subtle">Tap to apply · saved from the Timer</span></div>${control}</div>`;
    }
    if (key === 'testNotification') {
      return `<div class="settings-row"><div class="settings-row-info"><span>Test notification</span><span class="subtle">Send a sample alert now</span></div>${control}</div>`;
    }
    if (key === 'storageUsage') {
      return `<div class="settings-row"><div class="settings-row-info"><span>Storage used</span><span class="subtle">Local browser storage estimate</span></div><span class="muted" id="storageUsageVal">—</span></div>`;
    }

    return `
      <div class="settings-row">
        <div class="settings-row-info">
          <span>${escapeHtml(label)}</span>
          ${help}
        </div>
        <div class="settings-row-control">${control}</div>
      </div>`;
  },

  bindSettingsControls(ctx) {
    // Theme / selects / numbers / ranges / switches
    document.querySelectorAll('#pageContent [data-control]').forEach((node) => {
      const key = node.dataset.control;
      const def = Settings.SCHEMA[key];
      if (!def) return;
      if (def.type === 'theme') {
        node.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          Settings.set(key, b.dataset.value);
          this.renderSettings();
        }));
      } else if (def.type === 'colors') {
        node.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          Settings.set(key, b.dataset.value);
          this.renderSettings();
        }));
      } else if (def.type === 'select') {
        node.addEventListener('change', () => Settings.set(key, node.value));
      } else if (def.type === 'switch') {
        node.addEventListener('click', () => {
          Settings.set(key, !Settings.get(key));
          node.classList.toggle('on', Settings.get(key));
          node.setAttribute('aria-checked', String(Settings.get(key)));
        });
      } else if (def.type === 'number' || def.type === 'range') {
        node.addEventListener('input', () => {
          const v = def.type === 'range' ? Number(node.value) : Number(node.value);
          Settings.set(key, v);
          const out = document.querySelector(`[data-numval="${key}"]`);
          if (out) out.textContent = def.unit === '%' ? node.value + '%' : node.value;
        });
        node.addEventListener('change', () => Settings.set(key, Number(node.value)));
      } else if (def.type === 'text') {
        node.addEventListener('change', () => Settings.set(key, node.value));
      }
    });

    // Daily goal inline save
    document.getElementById('saveGoalBtn')?.addEventListener('click', async () => {
      const target = parseFloat(document.getElementById('dailyGoalInput').value);
      if (!target || target <= 0) return this.toast('Please enter a valid number', 'error');
      await Storage.saveGoal({ id: 'daily', type: 'daily', target, unit: Settings.get('goalUnit') || 'hours', active: true });
      this.toast('Daily goal saved', 'success');
    });

    // Timer presets apply
    document.querySelectorAll('[data-preset-apply]').forEach((b) => b.addEventListener('click', async () => {
      const p = (Settings.get('timerPresets') || [])[parseInt(b.dataset.presetApply, 10)];
      if (!p) return;
      await Settings.setMany({ focusLength: p.focusLength, breakLength: p.breakLength, rounds: p.rounds, longBreakLength: p.longBreakLength, longBreakEvery: p.longBreakEvery });
      if (this.engine) this.engine.configure(await this.loadFocusConfig());
      this.toast('Preset applied: ' + p.name, 'success');
    }));

    // Action buttons — selected by [data-action], since they render without an id.
    const onAction = (action, fn) => document.querySelector(`[data-action="${action}"]`)?.addEventListener('click', fn);
    onAction('testNotification', () => this.sendTestNotification());
    onAction('exportData', () => this.exportData());
    onAction('importData', () => this.importDataFile());
    onAction('backupNow', () => this.backupNow());
    onAction('storageUsage', () => this.refreshStorageUsage());
    onAction('aboutVersion', () => this.toast('StudyFlow v' + APP_VERSION, 'success'));
    onAction('aboutUpdate', () => this.checkForUpdates());
    onAction('aboutClearCache', () => this.clearAppCache());
    onAction('goalCelebrationsReset', () => { localStorage.removeItem('goalCelebrations'); this.toast('Celebration flags reset', 'success'); });
    onAction('resetSettings', () => this.confirmDestructive('Reset all settings to defaults?', async () => { await Settings.resetAll(); this.toast('Settings reset', 'success'); this.renderSettings(); }));
    onAction('clearAll', () => this.confirmDestructive('Type DELETE to confirm clearing ALL data. This cannot be undone.', async () => {
      await Storage.clearAll(); this.toast('All data cleared', 'success'); this.handleRoute();
    }, 'DELETE'));
    onAction('resetDb', () => this.confirmDestructive('Type RESET to confirm database reset.', async () => {
      try { await Storage.resetDatabase(); this.toast('Database reset complete', 'success'); this.handleRoute(); }
      catch { this.toast('Reset failed. Close other tabs and retry.', 'error'); }
    }, 'RESET'));

    this.refreshStorageUsage();
    this.renderSettingsNav();
  },

  renderSettingsNav() {
    const allSections = document.querySelectorAll('[id^="section-"]');
    document.querySelectorAll('.settings-nav-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.dataset.section;
        this.activeSettingsTab = id;
        document.querySelectorAll('.settings-nav-btn').forEach((x) => x.classList.toggle('active', x === b));
        allSections.forEach((sec) => {
          sec.hidden = sec.id !== 'section-' + id;
        });
      });
    });
  },

  refreshStorageUsage() {
    const out = document.getElementById('storageUsageVal');
    if (!out || !navigator.storage || !navigator.storage.estimate) { if (out) out.textContent = 'n/a'; return; }
    navigator.storage.estimate().then((e) => {
      const mb = e.usage ? (e.usage / (1024 * 1024)).toFixed(2) : '0';
      out.textContent = `${mb} MB used`;
    }).catch(() => { out.textContent = 'n/a'; });
  },

  confirmDestructive(message, onConfirm, match) {
    if (match) {
      const input = prompt(message);
      if (input === match) onConfirm();
    } else {
      if (confirm(message)) onConfirm();
    }
  },

  calculateStreak(sessions) {
    if (sessions.length === 0) return 0;
    const minSec = (Settings.get('streakMinMinutes') || 1) * 60;
    const byDay = {};
    for (const s of sessions) {
      if (!s.date) continue;
      byDay[s.date] = (byDay[s.date] || 0) + (s.duration || 0);
    }
    const days = new Set(Object.keys(byDay).filter((d) => byDay[d] >= minSec));
    const dsOf = (date) => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    let streak = 0;
    const today = new Date();
    let checkDate = new Date(today);
    // If today doesn't qualify, start counting from yesterday.
    if (!days.has(dsOf(today))) checkDate.setDate(checkDate.getDate() - 1);
    let freezeUsed = false;
    while (true) {
      const ds = dsOf(checkDate);
      if (days.has(ds)) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (Settings.get('streakFreeze') && !freezeUsed) {
        freezeUsed = true; // forgive one missed day
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
    return streak;
  },

  installPWA() {
    if (window.deferredPrompt) {
      window.deferredPrompt.prompt();
      window.deferredPrompt.userChoice.then(() => {
        document.getElementById('installPrompt').classList.add('hidden');
        window.deferredPrompt = null;
      });
    }
  },

  initNotifications() {
    if (!('Notification' in window)) return;
    // Reflect current setting + browser permission into the stored flag.
    if (Settings.get('notificationsEnabled') && Notification.permission === 'granted') {
      this.registerPeriodicSync();
    } else if (Notification.permission === 'denied') {
      Settings.set('notificationsEnabled', false);
    } else if (Settings.get('notificationsEnabled') && Notification.permission === 'default') {
      this.requestNotificationPermission();
    }
    setInterval(() => {
      this.checkUpcomingSessions();
      this.pingSW();
    }, 60000);
    this.checkUpcomingSessions();
  },

  async requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'denied') {
      this.toast('Notifications blocked in browser. Please enable in site settings.', 'error');
      await Settings.set('notificationsEnabled', false);
      return;
    }
    if (Notification.permission === 'default') {
      const res = await Notification.requestPermission();
      if (res === 'granted') {
        await Settings.set('notificationsEnabled', true);
        this.toast('Notifications enabled', 'success');
      } else {
        await Settings.set('notificationsEnabled', false);
      }
    }
    await this.registerPeriodicSync();
  },

  async registerPeriodicSync() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) {
        const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
        if (status.state === 'granted') {
          await reg.periodicSync.register('studyflow-check', { minInterval: 15 * 60 * 1000 });
        }
      }
    } catch { /* not supported */ }
  },

  async pingSW() {
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    if (!Settings.get('notificationsEnabled')) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      reg.active?.postMessage('CHECK_SESSIONS');
    } catch { /* ignore */ }
  },

  inQuietHours() {
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const parse = (str) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
      if (!m) return null;
      return Math.min(1439, parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
    };
    const start = parse(Settings.get('notifyQuietStart'));
    const end = parse(Settings.get('notifyQuietEnd'));
    if (start == null || end == null) return false;
    if (start <= end) return cur >= start && cur < end;
    return cur >= start || cur < end; // wraps midnight
  },

  async checkUpcomingSessions() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!Settings.get('notificationsEnabled') || !Settings.get('notifySessionReminders')) return;
    if (this.inQuietHours()) return;
    const sessions = await Storage.getAllSessions();
    const now = new Date();
    const today = getToday();
    const lead = Settings.get('notifyLeadTime') || 15;
    const upcoming = sessions.filter((s) => {
      if (s.date !== today || !s.startTime || s.endTime || s.notified) return false;
      const start = new Date(s.startTime);
      const diffMin = (start.getTime() - now.getTime()) / 60000;
      return diffMin > 0 && diffMin <= lead;
    });
    for (const s of upcoming) {
      const subjects = await Storage.getAllSubjects();
      const subj = subjects.find((x) => x.id === s.subjectId);
      const start = Settings.fmtTime(s.startTime);
      this.showNotification(
        'Study session starting soon',
        `${subj ? subj.name : 'Study'} at ${start}`
      );
      s.notified = true;
      await Storage.saveSession(s);
    }
  },

  showNotification(title, body) {
    try {
      new Notification(title, { body, icon: 'assets/icons/favicon-32x32.png' });
    } catch {
      // Notification API not available
    }
  },

  async sendTestNotification() {
    if (!('Notification' in window)) { this.toast('Notifications unsupported', 'error'); return; }
    if (Notification.permission !== 'granted') {
      await this.requestNotificationPermission();
      if (Notification.permission !== 'granted') return;
    }
    if (this.inQuietHours()) { this.toast('In quiet hours — would not alert now', 'success'); return; }
    this.showNotification('StudyFlow test', 'Notifications are working. 🎉');
    playPhaseSound('phase');
    this.toast('Test notification sent', 'success');
  },

  /* ---------- Data: export / import / backup ---------- */
  async exportData() {
    const format = Settings.get('dataExportFormat');
    const data = await Storage.exportAll();
    if (format === 'csv') {
      const rows = [['date', 'subject', 'start', 'end', 'duration_min', 'source']];
      const subjects = await Storage.getAllSubjects();
      const nameById = new Map(subjects.map((s) => [s.id, s.name]));
      (data.sessions || []).forEach((s) => rows.push([
        s.date, nameById.get(s.subjectId) || '', s.startTime || '', s.endTime || '',
        Math.round((s.duration || 0) / 60), s.source || '',
      ]));
      this.downloadFile(this.toCsv(rows), `studyflow-sessions-${getToday()}.csv`, 'text/csv');
    } else if (format === 'markdown') {
      const md = (data.notes || []).map((n) => `# ${n.title}\n\n${n.content || ''}\n`).join('\n---\n\n');
      this.downloadFile(md, `studyflow-notes-${getToday()}.md`, 'text/markdown');
    } else {
      this.downloadFile(JSON.stringify(data, null, 2), `studyflow-export-${getToday()}.json`, 'application/json');
    }
    this.toast('Data exported', 'success');
  },

  toCsv(rows) {
    return rows.map((r) => r.map((c) => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  },

  downloadFile(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  importDataFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (Settings.get('dataImportMode') === 'merge') {
          await this.mergeImport(data);
        } else {
          await Storage.importAll(data);
        }
        this.toast('Data imported successfully', 'success');
        this.handleRoute();
      } catch {
        this.toast('Invalid import file', 'error');
      }
    });
    input.click();
  },

  async mergeImport(data) {
    const existing = await Storage.exportAll();
    const merge = (a, b) => {
      const map = new Map((a || []).map((x) => [x.id, x]));
      (b || []).forEach((x) => map.set(x.id, x));
      return [...map.values()];
    };
    const merged = {
      subjects: merge(existing.subjects, data.subjects),
      sessions: merge(existing.sessions, data.sessions),
      notes: merge(existing.notes, data.notes),
      goals: merge(existing.goals, data.goals),
      recordings: merge(existing.recordings, data.recordings),
    };
    await Storage.importAll(merged);
  },

  async backupNow() {
    try {
      const data = await Storage.exportAll();
      localStorage.setItem('studyflow.backup', JSON.stringify({ at: new Date().toISOString(), data }));
      this.toast('Backup saved locally', 'success');
    } catch (e) {
      this.toast('Backup failed', 'error');
    }
  },

  async checkForUpdates() {
    if (!('serviceWorker' in navigator)) { this.toast('No service worker', 'error'); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.update();
      if (reg.waiting) {
        reg.waiting.postMessage('SKIP_WAITING');
        this.toast('Updating to the latest version…', 'success');
        setTimeout(() => location.reload(), 800);
      } else {
        this.toast('You are on the latest version', 'success');
      }
    } catch {
      this.toast('Update check failed', 'error');
    }
  },

  async clearAppCache() {
    if (!('caches' in window)) { this.toast('Cache API unavailable', 'error'); return; }
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    this.toast('App cache cleared', 'success');
  },
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
});

document.addEventListener('DOMContentLoaded', () => app.init());

export default app;
