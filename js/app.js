// @ts-nocheck
import { generateId, getToday, formatDate, formatTime, formatDuration, formatDurationClock, getWeekDates, getStartOfWeek, escapeHtml, debounce, parseMarkdown } from './utils.js';
import Storage from './storage.js';
import SQ from './smart_questioning.js';

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
  timerRunning: false,
  timerElapsed: 0,
  timerStartTime: null,
  timerInterval: null,
  timerSession: null,

  async init() {
    this.initTheme();
    this.setupListeners();
    await this.restoreTimerState();
    this.initNotifications();
    this.handleRoute();
  },

  initTheme() {
    const stored = localStorage.getItem('theme');
    if (stored) {
      document.documentElement.setAttribute('data-theme', stored);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  },

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  },

  setupListeners() {
    window.addEventListener('hashchange', () => this.handleRoute());
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

  handleRoute() {
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
    const pages = {
      dashboard: () => this.renderDashboard(),
      subjects: () => this.renderSubjects(),
      planner: () => this.renderPlanner(),
      timer: () => this.renderTimer(),
      notes: () => this.renderNotes(),
      statistics: () => this.renderStatistics(),
      settings: () => this.renderSettings(),
    };
    const render = pages[hash] || pages.dashboard;
    document.getElementById('pageContent').innerHTML = '';
    render();
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

  toast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  },

  async renderDashboard() {
    const [subjects, sessions, goals] = await Promise.all([
      Storage.getAllSubjects(), Storage.getAllSessions(), Storage.getAllGoals(),
    ]);
    const today = getToday();
    const todaySessions = sessions.filter((s) => s.date === today);
    const todayTime = todaySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const weekDates = getWeekDates();
    const weekSessions = sessions.filter((s) => weekDates.includes(s.date));
    const weekTime = weekSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const streak = this.calculateStreak(sessions);
    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);
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
              const status = s.paused ? 'Paused' : (s.endTime ? formatDuration(s.duration || 0) : 'Running');
              return `
                <div class="flex justify-between items-center mb-sm">
                  <div>
                    <div class="font-medium">${subj ? escapeHtml(subj.name) : 'Unknown'}</div>
                    <div class="muted text-sm">${s.description ? escapeHtml(s.description) : ''}</div>
                  </div>
                  <span class="badge badge-success">${status}</span>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
      </div>

      ${dailyGoal ? `
      <div class="card mt">
        <div class="card-header"><h2>Daily Goal</h2></div>
        <div class="progress-bar mt">
          <div class="progress-fill" style="width: ${Math.min(100, (todayTime / (dailyGoal.target * 3600)) * 100)}%"></div>
        </div>
        <p class="muted text-center mt-sm">${formatDuration(todayTime)} / ${dailyGoal.target}h</p>
      </div>
      ` : ''}
    `;
    document.getElementById('dashAddSubjectBtn')?.addEventListener('click', () => this.showSubjectForm());
    document.getElementById('dashAddPlanBtn')?.addEventListener('click', () => this.showSessionForm({ date: getToday() }));
  },

  async renderSubjects() {
    const subjects = await Storage.getAllSubjects();
    const sessions = await Storage.getAllSessions();
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="page-header flex justify-between items-center page-header-inline">
        <h1>Subjects</h1>
        <button class="btn btn-primary btn-sm" id="addSubjectBtn" aria-label="Add subject">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add subject
        </button>
      </div>
      ${subjects.length === 0 ? `
        <div class="empty-state card mt empty-state-lg">
          <img class="empty-illo" src="assets/illustrations/Education-Online-Learning-02--Streamline-Bangalore.png" alt="">
          <h3>No subjects yet</h3>
          <p>Add your first subject to start organising your study sessions.</p>
        </div>` : `
        <div class="grid grid-2 gap mt">
          ${subjects.map((s) => {
            const count = sessions.filter((x) => x.subjectId === s.id).length;
            const total = sessions.filter((x) => x.subjectId === s.id).reduce((sum, x) => sum + (x.duration || 0), 0);
            return `
          <div class="card subject-card" style="--subj: ${escapeHtml(s.color)}">
            <div class="subject-card-top">
              <div class="subject-avatar"><img src="assets/illustrations/Laptop-Workspace-3--Streamline-Ux.png" alt="${escapeHtml(s.name || 'Subject')}"></div>
              <div class="flex gap-xs">
                <button class="btn btn-ghost btn-sm" data-action="edit-subject" data-id="${s.id}" aria-label="Edit">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 4 21l.5-3.5L17 3z"/></svg>
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
          </div>
            `;
          }).join('')}
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
  },

  async showSubjectForm(subject) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!subject;
    const data = subject || { id: generateId(), name: '', description: '', color: PRESET_COLORS[0] };

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
            <div class="form-group">
              <label>Color</label>
              <div class="flex gap-sm mt">
                ${PRESET_COLORS.map((c) => `
                  <div class="color-swatch ${data.color === c ? 'selected' : ''}" data-color="${c}" style="background: ${c}"></div>
                `).join('')}
              </div>
              <input type="hidden" id="subjectColor" value="${data.color}">
            </div>
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    let selectedColor = data.color;
    const colorInput = document.getElementById('subjectColor');

    document.querySelectorAll('.color-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
        swatch.classList.add('selected');
        selectedColor = swatch.dataset.color;
        colorInput.value = selectedColor;
      });
    });

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('subjectForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('subjectId').value;
      const name = document.getElementById('subjectName').value.trim();
      const desc = document.getElementById('subjectDesc').value.trim();
      const color = colorInput.value;
      if (!name) return this.toast('Name is required', 'error');
      const existing = id ? subjects.find((s) => s.id === id) : null;
      const subj = { ...existing, id, name, description: desc, color };
      if (!subj.createdAt && existing) subj.createdAt = existing.createdAt;
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

    el.innerHTML = `
      <div class="page-header">
        <h1>Planner</h1>
        <p class="muted">Week of ${formatDate(getStartOfWeek(refDate).toISOString())}</p>
      </div>
      <div class="grid grid-7 gap-sm mt">
        ${weekDates.map((date) => {
          const daySessions = sessions.filter((s) => s.date === date && s.source !== 'timer').sort((a, b) => {
            if (!a.startTime) return 1;
            if (!b.startTime) return -1;
            return a.startTime.localeCompare(b.startTime);
          });
          const isToday = date === getToday();
          const d = new Date(date + 'T12:00:00');
          const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
          const dayNum = d.getDate();
          return `
            <div class="planner-day ${isToday ? 'today' : ''}">
              <div class="planner-day-header">
                <div class="planner-day-date">${dayNum}</div>
                <div>${dayName}</div>
              </div>
              <div class="flex flex-col gap-xs mt-sm">
                ${daySessions.length === 0 ? '<p class="muted text-sm">No sessions</p>' : daySessions.map((s) => {
                  const subj = subjects.find((x) => x.id === s.subjectId);
                  const start = s.startTime ? formatTime(s.startTime) : '';
                  const end = s.endTime ? formatTime(s.endTime) : '';
                  return `
                    <div class="planner-session">
                      <div class="planner-session-name">${subj ? escapeHtml(subj.name) : 'Unknown'}</div>
                      <div class="planner-session-time">${start}${start && end ? ' - ' : ''}${end}</div>
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
    `;

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

  async showSessionForm(session) {
    const subjects = await Storage.getAllSubjects();
    const isEdit = !!(session && session.id);
    const data = (session && session.id) ? session : { id: generateId(), subjectId: '', date: session?.date || getToday(), startTime: '', endTime: '', description: '', source: 'planner' };

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
            <div class="flex justify-end gap mt">
              <button type="button" class="btn btn-ghost" id="cancelModal">Cancel</button>
              <button type="submit" class="btn btn-primary">Save</button>
            </div>
          </form>
        </div>
      </div>
    `);

    document.getElementById('cancelModal').addEventListener('click', () => this.closeModals());
    document.getElementById('sessionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('sessionId').value;
      const subjectId = document.getElementById('sessionSubject').value;
      const date = document.getElementById('sessionDate').value;
      const startVal = document.getElementById('sessionStart').value;
      const endVal = document.getElementById('sessionEnd').value;
      const desc = document.getElementById('sessionDesc').value.trim();

      if (!subjectId || !date || !startVal) return this.toast('Please fill required fields', 'error');
      if (endVal && endVal <= startVal) return this.toast('End time must be after start time', 'error');

      const startTime = `${date}T${startVal}:00`;
      const endTime = endVal ? `${date}T${endVal}:00` : null;
      const duration = endTime ? Math.floor((new Date(endTime) - new Date(startTime)) / 1000) : null;

      const existing = id ? (await Storage.getSession(id)) : null;
      const sess = { ...existing, id, subjectId, date, startTime, endTime, duration, description: desc, paused: false, source: existing?.source || 'planner' };
      await Storage.saveSession(sess);
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
    const el = document.getElementById('pageContent');

    el.innerHTML = `
      <div class="flex flex-col items-center justify-center" style="min-height: 60vh;">
        <div class="timer-display ${this.timerRunning ? 'timer-running' : ''}" id="timerDisplay">${formatDurationClock(this.timerElapsed)}</div>
        <select class="mb" id="timerSubject" style="max-width:260px;" ${subjects.length === 0 ? 'disabled' : ''}>
          <option value="">Select subject</option>
          ${subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <div class="flex gap mt">
          ${!this.timerRunning && this.timerElapsed === 0 ? `<button class="btn btn-primary btn-lg" id="startTimerBtn">Start</button>` : ''}
          ${this.timerRunning ? `<button class="btn btn-ghost btn-lg" id="pauseTimerBtn">Pause</button>` : ''}
          ${!this.timerRunning && this.timerElapsed > 0 ? `<button class="btn btn-primary btn-lg" id="resumeTimerBtn">Resume</button><button class="btn btn-danger btn-lg" id="stopTimerBtn">Stop</button>` : ''}
        </div>
      </div>
    `;

    document.getElementById('startTimerBtn')?.addEventListener('click', () => this.startTimer());
    document.getElementById('pauseTimerBtn')?.addEventListener('click', () => this.pauseTimer());
    document.getElementById('resumeTimerBtn')?.addEventListener('click', () => this.resumeTimer());
    document.getElementById('stopTimerBtn')?.addEventListener('click', () => this.stopTimer());
  },

  async startTimer() {
    const subjectId = document.getElementById('timerSubject').value;
    if (!subjectId) return this.toast('Please select a subject', 'error');
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
      createdAt: new Date().toISOString(),
    };
    await Storage.saveSession(session);
    this.timerSession = session;
    this.timerRunning = true;
    this.timerElapsed = 0;
    this.timerStartTime = new Date();
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
    this.renderTimer();
  },

  async pauseTimer() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.timerRunning = false;
    this.timerSession.duration = this.timerElapsed;
    this.timerSession.paused = true;
    await Storage.saveSession(this.timerSession);
    this.renderTimer();
  },

  async resumeTimer() {
    if (!this.timerSession) return;
    this.timerSession.paused = false;
    this.timerSession.startTime = new Date(Date.now() - this.timerElapsed * 1000).toISOString();
    await Storage.saveSession(this.timerSession);
    this.timerRunning = true;
    this.timerStartTime = new Date(Date.now() - this.timerElapsed * 1000);
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
    this.renderTimer();
  },

  async stopTimer() {
    clearInterval(this.timerInterval);
    const endTime = new Date().toISOString();
    const duration = this.timerElapsed;
    if (this.timerSession && duration > 0) {
      this.timerSession.endTime = endTime;
      this.timerSession.duration = duration;
      this.timerSession.paused = false;
      await Storage.saveSession(this.timerSession);
      this.toast('Session saved', 'success');
    } else {
      this.toast('Timer reset', 'success');
    }
    this.timerRunning = false;
    this.timerElapsed = 0;
    this.timerStartTime = null;
    this.timerInterval = null;
    this.timerSession = null;
    this.renderTimer();
  },

  tickTimer() {
    if (this.timerStartTime) {
      this.timerElapsed = Math.floor((Date.now() - this.timerStartTime.getTime()) / 1000);
    } else {
      this.timerElapsed++;
    }
    const display = document.getElementById('timerDisplay');
    if (display) display.textContent = formatDurationClock(this.timerElapsed);
  },

  async restoreTimerState() {
    const sessions = await Storage.getAllSessions();
    const inProgress = sessions.find((s) => s.endTime === null && s.source === 'timer');
    if (!inProgress) return;
    this.timerSession = inProgress;
    this.timerElapsed = inProgress.duration || 0;
    if (!inProgress.paused) {
      const start = new Date(inProgress.startTime).getTime();
      this.timerElapsed += Math.max(0, Math.floor((Date.now() - start) / 1000));
      this.timerRunning = true;
      this.timerStartTime = new Date();
      this.timerInterval = setInterval(() => this.tickTimer(), 1000);
    } else {
      this.timerRunning = false;
      this.timerStartTime = null;
    }
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
      </div>
      <div class="grid grid-2 gap" id="notesGrid">
        ${notes.length === 0 ? `
          <div class="empty-state empty-state-lg" style="grid-column:1/-1">
            <img class="empty-illo" src="assets/illustrations/Communication-Contact-Post-It-To-Do-Notes-01--Streamline-Bangalore.png" alt="">
            <h3>No notes yet</h3>
            <p>Capture ideas, summaries, and key points from your study sessions.</p>
          </div>` : notes.map((n) => this.noteCardHTML(n, subjects)).join('')}
      </div>
    `;

    const search = document.getElementById('noteSearch');
    const filter = document.getElementById('noteSubjectFilter');

    const applyFilter = () => {
      const query = search.value.toLowerCase();
      const subjectFilter = filter.value;
      const filtered = notes.filter((n) => {
        const matchText = (n.title + ' ' + (n.content || '')).toLowerCase().includes(query);
        const matchSubject = !subjectFilter || n.subjectId === subjectFilter;
        return matchText && matchSubject;
      });

      const grid = document.getElementById('notesGrid');
      grid.innerHTML = filtered.length === 0 ? '<p class="muted">No notes match your search.</p>' : filtered.map((n) => this.noteCardHTML(n, subjects)).join('');

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
             <div class="note-preview-content" id="previewModalContent">${parseMarkdown(note.content || '', note.questions || [])}</div>
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
    const data = note || { id: generateId(), title: '', subjectId: '', content: '' };

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
              <textarea id="noteContentInput" placeholder="Start writing...">${escapeHtml(note.content || '')}</textarea>
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
      if (!title) return;

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
        return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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

      const subjects = await Storage.getAllSubjects();
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
  },

  async renderSettings() {
    const el = document.getElementById('pageContent');
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const goals = await Storage.getAllGoals();
    const dailyGoal = goals.find((g) => g.type === 'daily' && g.active);

    el.innerHTML = `
      <div class="settings-header">
        <h1>Settings</h1>
        <p class="muted">Manage your preferences and data.</p>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          Appearance
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Theme</span>
            <span class="subtle">Choose between light and dark mode</span>
          </div>
          <div class="settings-theme-btns">
            <button class="settings-theme-btn ${currentTheme === 'light' ? 'active' : ''}" id="themeLight">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              Light
            </button>
            <button class="settings-theme-btn ${currentTheme === 'dark' ? 'active' : ''}" id="themeDark">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              Dark
            </button>
          </div>
        </div>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Goals
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Daily study goal</span>
            <span class="subtle">How many hours you aim to study each day</span>
          </div>
          <div class="settings-row-control">
            <input type="number" id="dailyGoalInput" min="0.5" step="0.5" value="${dailyGoal ? dailyGoal.target : ''}" placeholder="e.g. 2" style="width:90px;text-align:center">
            <button class="btn btn-primary btn-sm" id="saveGoalBtn">Save</button>
          </div>
        </div>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7 3 9 3 9h6s3-2 3-9z"/><path d="M12 18v-4"/><path d="M8 18v-1"/><path d="M16 18v-3"/></svg>
          Notifications
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Study reminders</span>
            <span class="subtle">Get notified 15 minutes before a planned session</span>
          </div>
          <button class="btn btn-ghost btn-sm" id="notificationsToggle">Enable</button>
        </div>
      </div>

      <div class="settings-section card">
        <div class="settings-section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Data
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Export data</span>
            <span class="subtle">Download all your data as a JSON file</span>
          </div>
          <button class="btn btn-ghost btn-sm" id="exportBtn">Export JSON</button>
        </div>
        <div class="divider"></div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Import data</span>
            <span class="subtle">Restore from a previously exported file</span>
          </div>
          <label class="btn btn-ghost btn-sm" style="cursor:pointer">
            Import JSON
            <input type="file" id="importFile" accept="application/json" class="hidden">
          </label>
        </div>
      </div>

      <div class="settings-section card settings-danger-zone">
        <div class="settings-section-title danger">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Danger Zone
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Reset database</span>
            <span class="subtle">Delete everything including schema. Useful if you want the latest DB version to recreate from scratch.</span>
          </div>
          <button class="btn btn-danger btn-sm" id="resetDbBtn">Reset DB</button>
        </div>
        <div class="settings-row">
          <div class="settings-row-info">
            <span>Clear all data</span>
            <span class="subtle">Permanently delete all subjects, sessions, notes and goals</span>
          </div>
          <button class="btn btn-danger btn-sm" id="clearAllBtn">Clear All</button>
        </div>
      </div>
    `;

    document.getElementById('themeLight')?.addEventListener('click', () => { this.setTheme('light'); this.renderSettings(); });
    document.getElementById('themeDark')?.addEventListener('click', () => { this.setTheme('dark'); this.renderSettings(); });
    document.getElementById('saveGoalBtn')?.addEventListener('click', async () => {
      const target = parseFloat(document.getElementById('dailyGoalInput').value);
      if (!target || target <= 0) return this.toast('Please enter a valid number', 'error');
      await Storage.saveGoal({ id: 'daily', type: 'daily', target, unit: 'hours', active: true });
      this.toast('Daily goal saved', 'success');
    });
    document.getElementById('exportBtn')?.addEventListener('click', async () => {
      const data = await Storage.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `studyflow-export-${getToday()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('Data exported', 'success');
    });
    document.getElementById('importFile')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await Storage.importAll(data);
        this.toast('Data imported successfully', 'success');
        this.handleRoute();
      } catch {
        this.toast('Invalid import file', 'error');
      }
    });
    document.getElementById('clearAllBtn')?.addEventListener('click', () => {
      const input = prompt('Type DELETE to confirm clearing all data:');
      if (input === 'DELETE') {
        Storage.clearAll().then(() => {
          this.toast('All data cleared', 'success');
          this.handleRoute();
        });
      }
    });
    document.getElementById('resetDbBtn')?.addEventListener('click', async () => {
      const input = prompt('Type RESET to confirm database reset:');
      if (input === 'RESET') {
        try {
          await Storage.resetDatabase();
          this.toast('Database reset complete', 'success');
          this.handleRoute();
        } catch {
          this.toast('Reset failed. Please close all tabs and try again.', 'error');
        }
      }
    });
    const notifToggle = document.getElementById('notificationsToggle');
    if (notifToggle) {
      const updateNotifToggle = () => {
        if (!('Notification' in window)) {
          notifToggle.textContent = 'Unavailable';
          notifToggle.disabled = true;
          return;
        }
        const stored = localStorage.getItem('notificationsEnabled') !== 'false';
        const granted = Notification.permission === 'granted';
        const denied = Notification.permission === 'denied';
        const enabled = stored && granted;
        notifToggle.textContent = denied ? 'Blocked' : enabled ? 'Disable' : 'Enable';
        notifToggle.disabled = denied;
        notifToggle.classList.toggle('btn-ghost', !enabled && !denied);
        notifToggle.classList.toggle('btn-primary', enabled);
        notifToggle.classList.toggle('btn-danger', denied);
      };
      updateNotifToggle();
      notifToggle.addEventListener('click', async () => {
        const current = localStorage.getItem('notificationsEnabled') !== 'false';
        if (current) {
          localStorage.setItem('notificationsEnabled', 'false');
          await Storage.setSetting('notificationsEnabled', 'false');
          this.toast('Notifications disabled. Browser permission remains granted — revoke in site settings if needed.', 'success');
        } else {
          if (Notification.permission === 'denied') {
            this.toast('Notifications blocked in browser. Please enable in site settings.', 'error');
            return;
          }
          localStorage.setItem('notificationsEnabled', 'true');
          await Storage.setSetting('notificationsEnabled', 'true');
          await this.requestNotificationPermission();
          if (Notification.permission === 'granted') {
            this.toast('Notifications enabled', 'success');
          }
        }
        updateNotifToggle();
      });
      if ('permissions' in navigator && 'query' in navigator.permissions) {
        navigator.permissions.query({ name: 'notifications' }).then((status) => {
          status.onchange = () => {
            if (Notification.permission === 'granted') {
              localStorage.setItem('notificationsEnabled', 'true');
            } else if (Notification.permission === 'denied') {
              localStorage.setItem('notificationsEnabled', 'false');
            }
            updateNotifToggle();
          };
        }).catch(() => {});
      }
    }
  },

  calculateStreak(sessions) {
    if (sessions.length === 0) return 0;
    const days = new Set(sessions.map((s) => s.date));
    const dayList = Array.from(days).sort().reverse();
    let streak = 0;
    const today = new Date();
    let checkDate = new Date(today);
    if (!days.has(getToday())) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    while (true) {
      const ds = checkDate.getFullYear() + '-' + String(checkDate.getMonth() + 1).padStart(2, '0') + '-' + String(checkDate.getDate()).padStart(2, '0');
      if (days.has(ds)) {
        streak++;
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
    const stored = localStorage.getItem('notificationsEnabled');
    if (stored === 'true' || stored === null) {
      if (Notification.permission === 'granted') {
        this.registerPeriodicSync();
        Storage.setSetting('notificationsEnabled', 'true');
      } else if (Notification.permission === 'denied') {
        localStorage.setItem('notificationsEnabled', 'false');
        Storage.setSetting('notificationsEnabled', 'false');
      } else if (Notification.permission === 'default') {
        this.requestNotificationPermission();
      }
    } else {
      Storage.setSetting('notificationsEnabled', 'false');
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
      return;
    }
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
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
    if (localStorage.getItem('notificationsEnabled') === 'false') return;
    try {
      const reg = await navigator.serviceWorker.ready;
      reg.active?.postMessage('CHECK_SESSIONS');
    } catch { /* ignore */ }
  },

  async checkUpcomingSessions() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (localStorage.getItem('notificationsEnabled') === 'false') return;
    const sessions = await Storage.getAllSessions();
    const now = new Date();
    const today = getToday();
    const upcoming = sessions.filter((s) => {
      if (s.date !== today || !s.startTime || s.endTime || s.notified) return false;
      const start = new Date(s.startTime);
      const diffMin = (start.getTime() - now.getTime()) / 60000;
      return diffMin > 0 && diffMin <= 15;
    });
    for (const s of upcoming) {
      const subjects = await Storage.getAllSubjects();
      const subj = subjects.find((x) => x.id === s.subjectId);
      const start = formatTime(s.startTime);
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
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.deferredPrompt = e;
});

document.addEventListener('DOMContentLoaded', () => app.init());

export default app;
