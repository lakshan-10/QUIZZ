// ----------------------------------------------------
// LIVE QUIZ COMPETITION — ADMIN DASHBOARD LOGIC
// ----------------------------------------------------

let adminToken = sessionStorage.getItem('admin_token') || '';
let adminSocket = null;
let currentLeaderboardData = [];
let currentQuestionsData = [];
let activeParticipantIdModal = null;

document.addEventListener('DOMContentLoaded', () => {
  if (adminToken) {
    initAdminDashboard();
  } else {
    document.getElementById('admin-login-overlay').style.display = 'flex';
  }
});

// ----------------------------------------------------
// 1. AUTHENTICATION & INITIALIZATION
// ----------------------------------------------------

async function handleAdminLogin() {
  const user = document.getElementById('admin-user').value.trim();
  const pass = document.getElementById('admin-pass').value.trim();
  const errDiv = document.getElementById('admin-login-error');

  errDiv.style.display = 'none';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });

    const data = await res.json();

    if (!res.ok) {
      errDiv.textContent = data.error || 'Login failed.';
      errDiv.style.display = 'block';
      return;
    }

    adminToken = data.token;
    sessionStorage.setItem('admin_token', adminToken);
    initAdminDashboard();
  } catch (err) {
    errDiv.textContent = 'Network error while logging in.';
    errDiv.style.display = 'block';
  }
}

function handleAdminLogout() {
  sessionStorage.removeItem('admin_token');
  adminToken = '';
  location.reload();
}

function initAdminDashboard() {
  document.getElementById('admin-login-overlay').style.display = 'none';
  document.getElementById('admin-dashboard').style.display = 'block';

  // Instant HTTP load for immediate data rendering
  fetchDashboardData();
  fetchServerInfo();

  // WebSockets for real-time live updates
  connectAdminWebSocket();
  loadAnswerKey();
  loadLogs();
}

async function fetchAdmin(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${adminToken}`;

  const res = await fetch(url, options);
  if (res.status === 401) {
    sessionStorage.removeItem('admin_token');
    adminToken = '';
    document.getElementById('admin-dashboard').style.display = 'none';
    document.getElementById('admin-login-overlay').style.display = 'flex';
    const errDiv = document.getElementById('admin-login-error');
    if (errDiv) {
      errDiv.textContent = 'Admin session expired or server restarted. Please log in again.';
      errDiv.style.display = 'block';
    }
    throw new Error('Unauthorized');
  }
  return res;
}

// Instant HTTP Fetch for Admin Dashboard Data
async function fetchDashboardData() {
  try {
    const res = await fetchAdmin('/api/admin/dashboard-data');
    if (res.ok) {
      const data = await res.json();
      updateStatsUI(data.stats);
      currentLeaderboardData = data.leaderboard || [];
      renderLeaderboard(currentLeaderboardData);
    }
  } catch (e) {}
}

// ----------------------------------------------------
// 2. WEBSOCKET REAL-TIME STATS & LEADERBOARD
// ----------------------------------------------------

function connectAdminWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  adminSocket = new WebSocket(wsUrl);

  adminSocket.onopen = () => {
    adminSocket.send(JSON.stringify({
      type: 'INIT_ADMIN',
      token: adminToken
    }));
  };

  adminSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'STATS_UPDATE') {
        updateStatsUI(data.stats);
        currentLeaderboardData = data.leaderboard || [];
        renderLeaderboard(currentLeaderboardData);

        if (activeParticipantIdModal) {
          refreshParticipantModal(activeParticipantIdModal);
        }
      }
    } catch (e) {
      console.error('Error handling WS message:', e);
    }
  };

  adminSocket.onclose = () => {
    setTimeout(connectAdminWebSocket, 3000);
  };
}

function updateStatsUI(stats) {
  document.getElementById('stat-registered').textContent = stats.total_registered || 0;
  document.getElementById('stat-active').textContent = stats.active_count || 0;
  document.getElementById('stat-submitted').textContent = stats.submitted_count || 0;
  document.getElementById('stat-disconnected').textContent = stats.disconnected_count || 0;
  document.getElementById('stat-avg').textContent = stats.avg_score || 0;
  document.getElementById('stat-high').textContent = stats.high_score || 0;

  const statusBadge = document.getElementById('quiz-status-badge');
  const qStatus = stats.quiz_status || 'Live';
  statusBadge.textContent = qStatus.toUpperCase();
  statusBadge.className = `status-badge status-${qStatus.toLowerCase().replace(/\s+/g, '-')}`;

  document.getElementById('btn-show-results').style.opacity = (stats.results_released === '1') ? '0.6' : '1';
  document.getElementById('btn-hide-results').style.opacity = (stats.results_released === '1') ? '1' : '0.6';
}

function renderLeaderboard(list) {
  const tbody = document.getElementById('leaderboard-tbody');
  tbody.innerHTML = '';

  const filter = (document.getElementById('leaderboard-search').value || '').toLowerCase();

  const filtered = list.filter(item => {
    const name = item.participant_name || item.name || '';
    const pId = item.participant_id || '';
    return name.toLowerCase().includes(filter) || pId.toLowerCase().includes(filter);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:20px; color:#64748b;">No participants found in database.</td></tr>`;
    return;
  }

  for (const item of filtered) {
    const tr = document.createElement('tr');

    const rankClass = item.rank <= 3 ? `rank-${item.rank}` : '';
    const statusClass = `badge-${(item.status || 'Active').toLowerCase()}`;

    tr.innerHTML = `
      <td><span class="rank-pill ${rankClass}">${item.rank}</span></td>
      <td><strong>${escapeHtml(item.participant_name || item.name)}</strong></td>
      <td><code>${escapeHtml(item.participant_id)}</code></td>
      <td>${item.answered_count || 0} / 80</td>
      <td><strong style="font-size:16px; color:#2563eb;">${item.total_score}</strong> / 80</td>
      <td><span class="badge-status ${statusClass}">${(item.status || 'Active').toUpperCase()}</span></td>
      <td>${item.submitted_at ? new Date(item.submitted_at).toLocaleTimeString() : 'In Progress'}</td>
      <td>
        <button class="btn btn-sm btn-primary" onclick="openParticipantReview('${escapeHtml(item.participant_id)}')">
          Inspect Review
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function filterLeaderboard() {
  renderLeaderboard(currentLeaderboardData);
}

// ----------------------------------------------------
// 3. QUIZ CONTROLS
// ----------------------------------------------------

let currentPublicUrl = window.location.origin + '/';

async function fetchServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    if (res.ok) {
      const data = await res.json();
      currentPublicUrl = data.primary_url || (window.location.origin + '/');
      
      const input = document.getElementById('public-quiz-url');
      const modalInput = document.getElementById('modal-public-url');
      if (input) input.value = currentPublicUrl;
      if (modalInput) modalInput.value = currentPublicUrl;

      const ipsContainer = document.getElementById('network-ips-container');
      if (ipsContainer && Array.isArray(data.network_urls) && data.network_urls.length > 0) {
        let html = '<span style="font-weight:700;">🌐 Network IPs (For devices on same Wi-Fi):</span> ';
        for (const netUrl of data.network_urls) {
          html += `<span class="network-ip-tag" onclick="selectPublicUrl('${escapeHtml(netUrl)}')">${escapeHtml(netUrl)}</span> `;
        }
        ipsContainer.innerHTML = html;
        ipsContainer.style.display = 'flex';
      }
    }
  } catch (e) {
    currentPublicUrl = window.location.origin + '/';
    const input = document.getElementById('public-quiz-url');
    if (input) input.value = currentPublicUrl;
  }
}

function selectPublicUrl(url) {
  currentPublicUrl = url;
  const input = document.getElementById('public-quiz-url');
  const modalInput = document.getElementById('modal-public-url');
  if (input) input.value = url;
  if (modalInput) modalInput.value = url;
  updateQrCodeImg(url);
}

function copyPublicLink() {
  const urlInput = document.getElementById('public-quiz-url');
  const targetUrl = urlInput ? urlInput.value : currentPublicUrl;
  navigator.clipboard.writeText(targetUrl).then(() => {
    const btn = document.getElementById('btn-copy-url');
    if (btn) {
      const origText = btn.textContent;
      btn.textContent = '✓ Copied to Clipboard!';
      btn.style.background = '#16a34a';
      setTimeout(() => {
        btn.textContent = origText;
        btn.style.background = '';
      }, 2500);
    }
  }).catch(() => {
    alert('Public Link: ' + targetUrl);
  });
}

function copyPublicLinkFromModal() {
  const urlInput = document.getElementById('modal-public-url');
  const targetUrl = urlInput ? urlInput.value : currentPublicUrl;
  navigator.clipboard.writeText(targetUrl).then(() => {
    const btn = document.getElementById('btn-modal-copy-url');
    if (btn) {
      const origText = btn.textContent;
      btn.textContent = '✓ Copied to Clipboard!';
      btn.style.background = '#16a34a';
      setTimeout(() => {
        btn.textContent = origText;
        btn.style.background = '';
      }, 2500);
    }
  }).catch(() => {
    alert('Public Link: ' + targetUrl);
  });
}

function openShareModal() {
  const urlInput = document.getElementById('public-quiz-url');
  const targetUrl = urlInput ? urlInput.value : currentPublicUrl;
  
  const modalInput = document.getElementById('modal-public-url');
  if (modalInput) modalInput.value = targetUrl;

  updateQrCodeImg(targetUrl);

  const modal = document.getElementById('modal-share-quiz');
  if (modal) modal.style.display = 'flex';
}

function closeShareModal() {
  const modal = document.getElementById('modal-share-quiz');
  if (modal) modal.style.display = 'none';
}

function updateQrCodeImg(url) {
  const img = document.getElementById('qr-code-img');
  if (img) {
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
    img.src = qrApiUrl;
  }
}

function shareWhatsApp() {
  const urlInput = document.getElementById('public-quiz-url');
  const targetUrl = urlInput ? urlInput.value : currentPublicUrl;
  const msg = `Join the Live Quiz Competition now: ${targetUrl}`;
  const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}

async function triggerQuizControl(action) {
  try {
    const res = await fetchAdmin('/api/admin/quiz-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Control action failed.');
      return;
    }

    if (action === 'START') {
      openShareModal();
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      alert('Network error executing control action.');
    }
  }
}

async function handleResetDatabase() {
  if (!confirm('⚠️ WARNING: Are you sure you want to clear all participant records and reset the database for a new quiz competition?')) {
    return;
  }

  try {
    const res = await fetchAdmin('/api/admin/reset-database', {
      method: 'POST'
    });

    if (res.ok) {
      alert('Database reset successfully!');
      fetchDashboardData();
    } else {
      alert('Failed to reset database.');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      alert('Network error resetting database.');
    }
  }
}

// ----------------------------------------------------
// 4. ANSWER KEY MANAGEMENT
// ----------------------------------------------------

async function loadAnswerKey() {
  try {
    const res = await fetchAdmin('/api/admin/questions');
    if (!res.ok) return;

    const data = await res.json();
    currentQuestionsData = data.questions;

    const lockTag = document.getElementById('answer-key-lock-status');
    if (data.is_locked) {
      lockTag.textContent = 'Status: LOCKED (Quiz Started/Ended)';
      lockTag.style.background = '#fee2e2';
      lockTag.style.color = '#dc2626';
    } else {
      lockTag.textContent = 'Status: Unlocked (Pre-Quiz Edit Allowed)';
      lockTag.style.background = '#fef3c7';
      lockTag.style.color = '#d97706';
    }

    const tbody = document.getElementById('answer-key-tbody');
    tbody.innerHTML = '';

    for (const q of currentQuestionsData) {
      const tr = document.createElement('tr');
      const accStr = (q.accepted_answers || []).join(', ');

      tr.innerHTML = `
        <td><strong>Q${q.question_number}</strong></td>
        <td>${q.category}</td>
        <td>
          <input type="text" id="ans-input-${q.question_number}" value="${escapeHtml(accStr)}" ${data.is_locked ? 'disabled' : ''} style="width:100%; padding:6px; border:1px solid #cbd5e1; border-radius:4px;">
        </td>
        <td>${q.marks}</td>
        <td>
          ${!data.is_locked ? `<button class="btn btn-sm btn-secondary" onclick="updateQuestionKey(${q.question_number})">Save</button>` : `<span style="font-size:12px; color:#94a3b8;">Locked</span>`}
        </td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error('Error loading answer key:', err);
    }
  }
}

async function updateQuestionKey(qNum) {
  const input = document.getElementById(`ans-input-${qNum}`);
  if (!input) return;

  const raw = input.value;
  const answersArr = raw.split(',').map(s => s.trim()).filter(Boolean);

  if (answersArr.length === 0) {
    alert('Must specify at least one accepted answer.');
    return;
  }

  try {
    const res = await fetchAdmin('/api/admin/questions/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_number: qNum,
        accepted_answers: answersArr
      })
    });

    if (res.ok) {
      alert(`Q${qNum} accepted answers updated!`);
      loadAnswerKey();
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to update answer.');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      alert('Network error updating answer key.');
    }
  }
}

// ----------------------------------------------------
// 5. DETAILED PARTICIPANT REVIEW & OVERRIDE
// ----------------------------------------------------

async function openParticipantReview(participantId) {
  activeParticipantIdModal = participantId;
  await refreshParticipantModal(participantId);
  document.getElementById('modal-participant').style.display = 'flex';
}

function closeParticipantModal() {
  activeParticipantIdModal = null;
  document.getElementById('modal-participant').style.display = 'none';
}

async function refreshParticipantModal(participantId) {
  try {
    const res = await fetchAdmin(`/api/admin/participant/${encodeURIComponent(participantId)}`);
    if (!res.ok) return;

    const data = await res.json();
    const p = data.participant;

    document.getElementById('modal-part-name').textContent = p.participant_name || p.name;
    document.getElementById('modal-part-id').textContent = p.participant_id;
    document.getElementById('modal-part-score').textContent = `${p.total_score} / 80`;
    document.getElementById('modal-part-status').textContent = p.status.toUpperCase();

    const tbody = document.getElementById('modal-part-tbody');
    tbody.innerHTML = '';

    for (const item of data.breakdown) {
      const tr = document.createElement('tr');
      const isCorrect = item.marks === 1;

      tr.style.background = isCorrect ? '#f0fdf4' : '#fff';

      tr.innerHTML = `
        <td><strong>Q${item.question_number}</strong></td>
        <td>${item.category}</td>
        <td>${escapeHtml(item.submitted_answer) || '<em style="color:#94a3b8;">Blank</em>'}</td>
        <td><strong>${escapeHtml((item.accepted_answers || []).join(' / '))}</strong></td>
        <td><strong style="color:${isCorrect ? '#16a34a' : '#dc2626'}">${item.marks}</strong></td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="promptManualOverride('${p.participant_id}', ${item.question_number}, ${item.marks})">
            Override
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    const logDiv = document.getElementById('modal-override-log');
    if (data.overrides && data.overrides.length > 0) {
      logDiv.innerHTML = data.overrides.map(o => `
        <div style="font-size:12px; background:#fff; border:1px solid #e2e8f0; padding:8px; border-radius:6px; margin-bottom:6px;">
          📅 ${new Date(o.timestamp).toLocaleString()} | <strong>Q${o.question_number}</strong>: Changed from ${o.old_result} to ${o.new_result} mark(s) by ${o.admin}.<br>
          <em>Reason: ${escapeHtml(o.reason)}</em>
        </div>
      `).join('');
    } else {
      logDiv.innerHTML = `<p style="font-size:12px; color:#94a3b8;">No manual overrides recorded for this participant.</p>`;
    }

  } catch (err) {
    if (err.message !== 'Unauthorized') {
      console.error('Error loading participant modal:', err);
    }
  }
}

async function promptManualOverride(participantId, qNum, currentMarks) {
  const newMarksStr = prompt(`Enter new marks for Question ${qNum} (0 or 1):`, currentMarks === 1 ? '0' : '1');
  if (newMarksStr === null) return;

  const newMarks = parseInt(newMarksStr, 10);
  if (newMarks !== 0 && newMarks !== 1) {
    alert('Marks must be either 0 or 1.');
    return;
  }

  const reason = prompt(`Enter mandatory reason for overriding Q${qNum} score:`);
  if (!reason || !reason.trim()) {
    alert('Override reason is required!');
    return;
  }

  try {
    const res = await fetchAdmin('/api/admin/override-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participant_id: participantId,
        question_number: qNum,
        new_marks: newMarks,
        reason: reason.trim()
      })
    });

    const data = await res.json();
    if (res.ok) {
      alert(`Score override applied! New Total Score: ${data.new_total_score}/80`);
      refreshParticipantModal(participantId);
    } else {
      alert(data.error || 'Failed to apply score override.');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      alert('Network error executing score override.');
    }
  }
}

// ----------------------------------------------------
// 6. TIE-BREAKER & LOGS
// ----------------------------------------------------

async function handleCreateTieBreaker() {
  const title = document.getElementById('tb-title').value.trim();
  const rawIds = document.getElementById('tb-participants').value.trim();

  const pIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);

  if (pIds.length === 0) {
    alert('Please enter at least one participant ID.');
    return;
  }

  try {
    const res = await fetchAdmin('/api/admin/tie-breaker/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, participant_ids: pIds })
    });

    if (res.ok) {
      alert('Tie-Breaker session created successfully!');
      loadLogs();
    } else {
      const data = await res.json();
      alert(data.error || 'Failed to create tie breaker.');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      alert('Network error creating tie breaker.');
    }
  }
}

async function loadLogs() {
  try {
    const res = await fetchAdmin('/api/admin/logs');
    if (!res.ok) return;

    const data = await res.json();
    const tbody = document.getElementById('logs-tbody');
    tbody.innerHTML = '';

    for (const log of data.logs) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${log.id}</td>
        <td>${log.admin}</td>
        <td><strong>${log.action}</strong></td>
        <td>${escapeHtml(log.details)}</td>
        <td>${new Date(log.timestamp).toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e) {}
}

// ----------------------------------------------------
// 7. EXPORT REAL DATABASE DATA
// ----------------------------------------------------

function exportData(type) {
  fetchAdmin(`/api/admin/export/${type}`)
  .then(res => {
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  })
  .then(blob => {
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `quiz_real_db_results.${type === 'csv' ? 'csv' : 'xls'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  })
  .catch(err => {
    if (err.message !== 'Unauthorized') {
      alert('Failed to export data from database.');
    }
  });
}

function switchAdminTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  event.currentTarget.classList.add('active');
  document.getElementById(tabId).classList.add('active');

  if (tabId === 'tab-logs') loadLogs();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
