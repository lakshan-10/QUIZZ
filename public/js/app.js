// ----------------------------------------------------
// LIVE QUIZ COMPETITION — PARTICIPANT APPLICATION LOGIC
// ----------------------------------------------------

let participantId = localStorage.getItem('quiz_p_id') || '';
let participantName = localStorage.getItem('quiz_p_name') || '';
let sessionId = localStorage.getItem('quiz_p_session') || '';

let currentQuestion = 1;
let answersMap = {}; // { 1: "Firstcry", 2: "Maggie", ... }
let isSubmitted = false;
let quizStatus = 'Live'; // Not Started | Live | Paused | Ended
let resultsReleased = false;

let saveTimeout = null;
let socket = null;

// Offline Sync Queue stored in localStorage
let unsentQueue = JSON.parse(localStorage.getItem('quiz_unsent_queue') || '[]');

// Question Category Map
const CATEGORIES = [
  { round: 1, name: 'Guess the Brand', start: 1, end: 20 },
  { round: 2, name: 'Guess the Person', start: 21, end: 40 },
  { round: 3, name: 'Identify the Logo', start: 41, end: 60 },
  { round: 4, name: 'Identify the Tagline', start: 61, end: 80 }
];

function getCategoryForQuestion(qNum) {
  for (const cat of CATEGORIES) {
    if (qNum >= cat.start && qNum <= cat.end) return cat;
  }
  return CATEGORIES[0];
}

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  renderQuestionGrid();
  attachInputListeners();
  initOnlineListeners();

  if (participantId && sessionId) {
    restoreSession();
  } else {
    showScreen('screen-register');
  }
});

// Screen Switcher
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');
}

// ----------------------------------------------------
// 1. REGISTRATION & SESSION MANAGEMENT
// ----------------------------------------------------

async function handleRegister() {
  const nameInput = document.getElementById('reg-name');
  const idInput = document.getElementById('reg-id');
  const errDiv = document.getElementById('reg-error');

  const name = nameInput.value.trim();
  const pId = idInput.value.trim();

  errDiv.style.display = 'none';

  if (!name || !pId) {
    errDiv.textContent = 'Please enter both your Name and Participant ID.';
    errDiv.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participant_name: name, participant_id: pId })
    });

    const data = await res.json();

    if (!res.ok) {
      errDiv.textContent = data.error || 'This Participant ID is already in use.';
      errDiv.style.display = 'block';
      return;
    }

    participantId = data.participant_id;
    participantName = data.participant_name;
    sessionId = data.session_id;

    localStorage.setItem('quiz_p_id', participantId);
    localStorage.setItem('quiz_p_name', participantName);
    localStorage.setItem('quiz_p_session', sessionId);

    startParticipantSession();
  } catch (err) {
    errDiv.textContent = 'Network error. Could not connect to server.';
    errDiv.style.display = 'block';
  }
}

async function restoreSession() {
  try {
    const res = await fetch(`/api/my-progress?participant_id=${encodeURIComponent(participantId)}&session_id=${encodeURIComponent(sessionId)}`);
    if (res.ok) {
      const data = await res.json();
      participantName = data.participant_name;
      answersMap = data.answers || {};
      isSubmitted = (data.status === 'Submitted');
      quizStatus = data.quiz_status;
      resultsReleased = data.results_released;

      startParticipantSession();
    } else {
      localStorage.clear();
      showScreen('screen-register');
    }
  } catch (e) {
    startParticipantSession();
  }
}

function startParticipantSession() {
  document.getElementById('user-display-name').textContent = participantName;
  document.getElementById('user-display-id').textContent = `ID: ${participantId}`;

  document.getElementById('sub-display-name').textContent = participantName;
  document.getElementById('sub-display-id').textContent = participantId;

  connectWebSocket();

  if (isSubmitted) {
    if (resultsReleased) {
      fetchResults();
    } else {
      showScreen('screen-submitted');
    }
  } else {
    showScreen('screen-quiz');
    loadQuestion(currentQuestion);
    updateProgressUI();
  }

  flushUnsentQueue();
}

// ----------------------------------------------------
// 2. WEBSOCKET REAL-TIME SYNC
// ----------------------------------------------------

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: 'INIT_PARTICIPANT',
      participant_id: participantId
    }));
    updateSyncBadge('saved');
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'QUIZ_STATE_CHANGE') {
        quizStatus = data.quiz_status;
        resultsReleased = data.results_released;
        updateQuizNoticeBar();

        if (isSubmitted) {
          if (resultsReleased) {
            fetchResults();
          } else {
            showScreen('screen-submitted');
          }
        }
      }
    } catch (e) {}
  };

  socket.onclose = () => {
    updateSyncBadge('offline');
    setTimeout(connectWebSocket, 3000);
  };
}

// ----------------------------------------------------
// 3. QUESTION NAVIGATION & UI
// ----------------------------------------------------

function renderQuestionGrid() {
  const grid = document.getElementById('question-grid');
  grid.innerHTML = '';

  for (let q = 1; q <= 80; q++) {
    const badge = document.createElement('div');
    badge.className = 'grid-badge';
    badge.id = `grid-badge-${q}`;
    badge.textContent = q;
    badge.onclick = () => {
      saveCurrentAnswerImmediate();
      loadQuestion(q);
    };
    grid.appendChild(badge);
  }
}

function updateQuestionGridUI() {
  for (let q = 1; q <= 80; q++) {
    const badge = document.getElementById(`grid-badge-${q}`);
    if (!badge) continue;

    const hasAns = answersMap[q] && answersMap[q].trim() !== '';

    badge.className = 'grid-badge';
    if (hasAns) badge.classList.add('answered');
    if (q === currentQuestion) badge.classList.add('current');
  }
}

function loadQuestion(qNum) {
  if (qNum < 1 || qNum > 80) return;

  currentQuestion = qNum;

  const cat = getCategoryForQuestion(currentQuestion);

  document.getElementById('current-round-title').textContent = `ROUND ${cat.round} — ${cat.name.toUpperCase()}`;
  document.getElementById('current-q-title').textContent = `QUESTION ${currentQuestion}`;

  document.querySelectorAll('.cat-tab').forEach(tab => {
    tab.classList.toggle('active', parseInt(tab.dataset.round, 10) === cat.round);
  });

  const input = document.getElementById('answer-input');
  input.value = answersMap[currentQuestion] || '';

  document.getElementById('btn-prev').disabled = (currentQuestion === 1);
  document.getElementById('btn-next').disabled = (currentQuestion === 80);

  updateQuestionGridUI();
  updateQuizNoticeBar();
}

function navigateQuestion(delta) {
  saveCurrentAnswerImmediate();
  const nextQ = currentQuestion + delta;
  if (nextQ >= 1 && nextQ <= 80) {
    loadQuestion(nextQ);
  }
}

function jumpToCategory(startQ) {
  saveCurrentAnswerImmediate();
  loadQuestion(startQ);
}

function updateProgressUI() {
  let count = 0;
  for (let q = 1; q <= 80; q++) {
    if (answersMap[q] && answersMap[q].trim() !== '') {
      count++;
    }
  }
  document.getElementById('answered-count').textContent = count;
  updateQuestionGridUI();
}

function updateQuizNoticeBar() {
  const notice = document.getElementById('quiz-notice-bar');
  const input = document.getElementById('answer-input');

  if (quizStatus === 'Paused') {
    notice.className = 'notice-bar warning';
    notice.textContent = '⏸️ Quiz is currently PAUSED by the organizer. Answer submissions are locked.';
    notice.style.display = 'block';
    input.disabled = true;
  } else if (quizStatus === 'Not Started') {
    notice.className = 'notice-bar warning';
    notice.textContent = '⏳ Quiz has NOT started yet. Answers will save automatically once quiz starts.';
    notice.style.display = 'block';
    input.disabled = false;
  } else if (quizStatus === 'Ended') {
    notice.className = 'notice-bar warning';
    notice.textContent = '🏁 Quiz has ENDED by the organizer.';
    notice.style.display = 'block';
    input.disabled = true;
  } else {
    const hasAns = answersMap[currentQuestion] && answersMap[currentQuestion].trim() !== '';
    if (hasAns) {
      notice.className = 'notice-bar locked';
      notice.textContent = `🔒 Answer submitted for Question ${currentQuestion}. Answers cannot be re-entered or modified.`;
      notice.style.display = 'block';
      input.disabled = true;
    } else {
      notice.style.display = 'none';
      input.disabled = false;
    }
  }
}

// ----------------------------------------------------
// 4. REAL-TIME ANSWER AUTO-SAVING & OFFLINE QUEUE
// ----------------------------------------------------

function attachInputListeners() {
  const input = document.getElementById('answer-input');

  input.addEventListener('input', () => {
    const val = input.value;
    answersMap[currentQuestion] = val;
    updateProgressUI();

    updateSyncBadge('saving');

    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveAnswerToServer(currentQuestion, val);
    }, 300);
  });

  input.addEventListener('blur', () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveCurrentAnswerImmediate();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (saveTimeout) clearTimeout(saveTimeout);
      saveCurrentAnswerImmediate();
      if (currentQuestion < 80) {
        loadQuestion(currentQuestion + 1);
      }
    }
  });
}

function saveCurrentAnswerImmediate() {
  const input = document.getElementById('answer-input');
  if (input) {
    const val = input.value;
    answersMap[currentQuestion] = val;
    saveAnswerToServer(currentQuestion, val);
  }
}

async function saveAnswerToServer(qNum, val) {
  if (isSubmitted || quizStatus === 'Paused' || quizStatus === 'Ended') return;

  const payload = {
    participant_id: participantId,
    session_id: sessionId,
    question_number: qNum,
    submitted_answer: val
  };

  try {
    updateSyncBadge('saving');

    const res = await fetch('/api/save-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      updateSyncBadge('saved');
    } else {
      queueUnsentAnswer(qNum, val);
      updateSyncBadge('offline');
    }
  } catch (err) {
    queueUnsentAnswer(qNum, val);
    updateSyncBadge('offline');
  }
}

function queueUnsentAnswer(qNum, val) {
  unsentQueue = unsentQueue.filter(item => item.question_number !== qNum);
  unsentQueue.push({ question_number: qNum, submitted_answer: val });
  localStorage.setItem('quiz_unsent_queue', JSON.stringify(unsentQueue));
}

async function flushUnsentQueue() {
  if (unsentQueue.length === 0 || !navigator.onLine) return;

  try {
    const res = await fetch('/api/batch-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participant_id: participantId,
        session_id: sessionId,
        answers: unsentQueue
      })
    });

    if (res.ok) {
      unsentQueue = [];
      localStorage.removeItem('quiz_unsent_queue');
      updateSyncBadge('saved');
    }
  } catch (e) {}
}

function initOnlineListeners() {
  window.addEventListener('online', () => {
    updateSyncBadge('saving');
    flushUnsentQueue();
  });

  window.addEventListener('offline', () => {
    updateSyncBadge('offline');
  });
}

function updateSyncBadge(status) {
  const badge = document.getElementById('sync-status');
  if (!badge) return;

  if (status === 'saved') {
    badge.className = 'sync-badge sync-saved';
    badge.textContent = '✓ Saved';
  } else if (status === 'saving') {
    badge.className = 'sync-badge sync-saving';
    badge.textContent = 'Saving...';
  } else if (status === 'offline') {
    badge.className = 'sync-badge sync-offline';
    badge.textContent = 'Connection lost — reconnecting...';
  }
}

// ----------------------------------------------------
// 5. INSTANT ZERO-LAG SUBMISSION & RESULT VIEWING
// ----------------------------------------------------

function openSubmitModal() {
  const input = document.getElementById('answer-input');
  if (input) {
    answersMap[currentQuestion] = input.value;
  }

  let answered = 0;
  for (let q = 1; q <= 80; q++) {
    if (answersMap[q] && answersMap[q].trim() !== '') answered++;
  }
  const unanswered = 80 - answered;

  document.getElementById('modal-answered-count').textContent = answered;
  document.getElementById('modal-unanswered-count').textContent = unanswered;

  document.getElementById('modal-submit').style.display = 'flex';
}

function closeSubmitModal() {
  document.getElementById('modal-submit').style.display = 'none';
}

function confirmFinalSubmission() {
  closeSubmitModal();
  isSubmitted = true;

  if (saveTimeout) clearTimeout(saveTimeout);
  const currentVal = document.getElementById('answer-input')?.value || '';
  answersMap[currentQuestion] = currentVal;

  // INSTANT SCREEN TRANSITION (0ms UI lag)
  if (resultsReleased) {
    fetchResults();
  } else {
    showScreen('screen-submitted');
  }

  // Send submission to backend asynchronously with full answers payload
  fetch('/api/submit-quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      participant_id: participantId,
      session_id: sessionId,
      current_question: currentQuestion,
      current_answer: currentVal,
      answers: answersMap
    })
  }).catch(() => {});
}

async function fetchResults() {
  try {
    const res = await fetch(`/api/results?participant_id=${encodeURIComponent(participantId)}&session_id=${encodeURIComponent(sessionId)}`);
    const data = await res.json();

    if (!res.ok) {
      showScreen('screen-submitted');
      return;
    }

    document.getElementById('res-user-name').textContent = data.participant_name;
    document.getElementById('res-user-id').textContent = data.participant_id;
    document.getElementById('res-total-score').textContent = data.total_score;

    const pct = ((data.total_score / 80) * 100).toFixed(1);
    document.getElementById('res-score-percent').textContent = `${pct}% Correct`;

    const tbody = document.getElementById('results-tbody');
    tbody.innerHTML = '';

    for (const row of data.breakdown) {
      const tr = document.createElement('tr');
      tr.className = row.marks === 1 ? 'correct-row' : 'wrong-row';

      tr.innerHTML = `
        <td><strong>Q${row.question_number}</strong> (${row.category})</td>
        <td>${escapeHtml(row.submitted_answer) || '<em style="color:#94a3b8;">Blank</em>'}</td>
        <td><strong>${escapeHtml(row.correct_answer)}</strong></td>
        <td><span class="badge-mark badge-${row.marks}">${row.marks}</span></td>
      `;
      tbody.appendChild(tr);
    }

    showScreen('screen-results');
  } catch (err) {
    showScreen('screen-submitted');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
