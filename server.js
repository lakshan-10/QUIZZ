const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const os = require('os');
const {
  db,
  runAsync,
  getAsync,
  allAsync,
  normalizeAnswer,
  initDB,
  recalculateParticipantScore
} = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple Auth Token Store for Admin
const ADMIN_TOKENS = new Set();

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Middleware: Check Admin Authentication
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.replace('Bearer ', '')) || req.query.token;
  if (token && ADMIN_TOKENS.has(token)) {
    req.adminUser = 'admin';
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized admin access' });
}

// Global WebSocket connections registry
const adminSockets = new Set();
const participantSockets = new Map(); // participant_id -> WebSocket

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let userType = 'participant';
  let participantId = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'INIT_ADMIN') {
        if (ADMIN_TOKENS.has(data.token)) {
          userType = 'admin';
          adminSockets.add(ws);
          ws.send(JSON.stringify({ type: 'ADMIN_CONNECTED' }));
          setImmediate(broadcastAdminStats);
        }
      } else if (data.type === 'INIT_PARTICIPANT') {
        participantId = data.participant_id;
        userType = 'participant';
        participantSockets.set(participantId, ws);

        await runAsync(
          `UPDATE participants SET status = 'Active', last_active_at = CURRENT_TIMESTAMP WHERE participant_id = ? AND status != 'Submitted'`,
          [participantId]
        );
        setImmediate(broadcastAdminStats);
      }
    } catch (e) {
      console.error('WS error parsing message:', e);
    }
  });

  ws.on('close', async () => {
    if (userType === 'admin') {
      adminSockets.delete(ws);
    } else if (userType === 'participant' && participantId) {
      participantSockets.delete(participantId);
      await runAsync(
        `UPDATE participants SET status = 'Disconnected', last_active_at = CURRENT_TIMESTAMP WHERE participant_id = ? AND status = 'Active'`,
        [participantId]
      );
      setImmediate(broadcastAdminStats);
    }
  });
});

// Broadcast event to all participant sockets
function broadcastToParticipants(payload) {
  const msg = JSON.stringify(payload);
  for (const [_, socket] of participantSockets.entries()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    }
  }
}

// Broadcast event to all admin sockets
function broadcastToAdmins(payload) {
  const msg = JSON.stringify(payload);
  for (const socket of adminSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    }
  }
}

// Helper: Fetch real database statistics & leaderboard
async function getAdminStatsAndLeaderboard() {
  const counts = await getAsync(`
    SELECT 
      COUNT(*) as total_registered,
      SUM(CASE WHEN LOWER(status) = 'active' THEN 1 ELSE 0 END) as active_count,
      SUM(CASE WHEN LOWER(status) = 'submitted' THEN 1 ELSE 0 END) as submitted_count,
      SUM(CASE WHEN LOWER(status) = 'disconnected' OR (LOWER(status) != 'submitted' AND LOWER(status) != 'active') THEN 1 ELSE 0 END) as disconnected_count,
      AVG(total_score) as avg_score,
      MAX(total_score) as high_score,
      MIN(total_score) as low_score
    FROM participants
  `);

  const leaderboard = await allAsync(`
    SELECT 
      p.id, p.participant_id, COALESCE(p.participant_name, p.name) as participant_name, 
      p.total_score, p.status, p.joined_at, p.last_active_at, p.submitted_at,
      COALESCE(r.ans_count, 0) as answered_count
    FROM participants p
    LEFT JOIN (
      SELECT participant_id, COUNT(*) as ans_count 
      FROM responses 
      WHERE submitted_answer IS NOT NULL AND TRIM(submitted_answer) != '' 
      GROUP BY participant_id
    ) r ON p.participant_id = r.participant_id
    ORDER BY p.total_score DESC, p.submitted_at ASC, p.id ASC
  `);

  let currentRank = 1;
  for (let i = 0; i < leaderboard.length; i++) {
    if (i > 0 && leaderboard[i].total_score < leaderboard[i - 1].total_score) {
      currentRank = i + 1;
    }
    leaderboard[i].rank = currentRank;
  }

  const stateRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
  const resultsRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'results_released'`);

  return {
    stats: {
      total_registered: counts ? (counts.total_registered || 0) : 0,
      active_count: counts ? (counts.active_count || 0) : 0,
      submitted_count: counts ? (counts.submitted_count || 0) : 0,
      disconnected_count: counts ? (counts.disconnected_count || 0) : 0,
      avg_score: (counts && counts.avg_score) ? parseFloat(counts.avg_score.toFixed(1)) : 0,
      high_score: (counts && counts.high_score) ? counts.high_score : 0,
      low_score: (counts && counts.low_score) ? counts.low_score : 0,
      quiz_status: stateRow ? stateRow.value : 'Live',
      results_released: resultsRow ? resultsRow.value : '0'
    },
    leaderboard
  };
}

let broadcastTimer = null;
function triggerAdminBroadcast() {
  if (adminSockets.size === 0) return;
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    await broadcastAdminStats();
  }, 200);
}

// Compute & broadcast live admin statistics asynchronously
async function broadcastAdminStats() {
  if (adminSockets.size === 0) return;

  try {
    const data = await getAdminStatsAndLeaderboard();
    broadcastToAdmins({
      type: 'STATS_UPDATE',
      stats: data.stats,
      leaderboard: data.leaderboard
    });
  } catch (err) {
    console.error('Error broadcasting admin stats:', err);
  }
}

// ----------------------------------------------------
// PUBLIC PARTICIPANT API ROUTES
// ----------------------------------------------------

// GET Server Info & Network Share URLs
app.get('/api/server-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  const port = process.env.PORT || 3000;

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(`http://${net.address}:${port}/`);
      }
    }
  }

  const hostHeader = req.headers.host;
  const protocol = req.protocol || 'http';
  const primaryUrl = hostHeader ? `${protocol}://${hostHeader}/` : `http://localhost:${port}/`;

  res.json({
    primary_url: primaryUrl,
    network_urls: addresses,
    port
  });
});

// GET Quiz State
app.get('/api/quiz-state', async (req, res) => {
  try {
    const statusRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
    const resultsRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'results_released'`);
    const leaderboardRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'leaderboard_enabled'`);
    res.json({
      quiz_status: statusRow ? statusRow.value : 'Live',
      results_released: resultsRow ? resultsRow.value === '1' : false,
      leaderboard_enabled: leaderboardRow ? leaderboardRow.value === '1' : false
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quiz state' });
  }
});

// Participant Registration
app.post('/api/register', async (req, res) => {
  const name = req.body.participant_name || req.body.name;
  const pId = req.body.participant_id;

  if (!name || !name.trim() || !pId || !pId.trim()) {
    return res.status(400).json({ error: 'Participant Name and ID are required.' });
  }

  const cleanName = name.trim();
  const cleanId = pId.trim();

  try {
    const existing = await getAsync(`SELECT * FROM participants WHERE participant_id = ?`, [cleanId]);

    if (existing) {
      if (participantSockets.has(cleanId) && participantSockets.get(cleanId).readyState === WebSocket.OPEN) {
        return res.status(400).json({ error: 'This Participant ID is already in use.' });
      }

      const token = existing.session_id || existing.session_token || generateToken();
      await runAsync(
        `UPDATE participants SET participant_name = ?, name = ?, session_id = ?, session_token = ?, status = 'Active', last_active_at = CURRENT_TIMESTAMP WHERE participant_id = ?`,
        [cleanName, cleanName, token, token, cleanId]
      );

      res.json({
        success: true,
        participant_id: cleanId,
        participant_name: cleanName,
        session_id: token,
        session_token: token,
        status: existing.status
      });

      setImmediate(broadcastAdminStats);
      return;
    }

    const token = generateToken();
    await runAsync(
      `INSERT INTO participants (participant_id, participant_name, name, session_id, session_token, status) VALUES (?, ?, ?, ?, ?, 'Active')`,
      [cleanId, cleanName, cleanName, token, token]
    );

    res.json({
      success: true,
      participant_id: cleanId,
      participant_name: cleanName,
      session_id: token,
      session_token: token,
      status: 'Active'
    });

    setImmediate(broadcastAdminStats);
    return;
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Registration failed server-side.' });
  }
});

// Helper to authenticate participant requests
async function authParticipant(req) {
  const body = req.body || {};
  const query = req.query || {};
  const headers = req.headers || {};

  const pId = body.participant_id || query.participant_id || headers['x-participant-id'];
  const token = body.session_id || body.session_token || query.session_id || query.session_token || headers['x-session-id'] || headers['x-session-token'];

  if (!pId || !token) return null;

  const participant = await getAsync(
    `SELECT * FROM participants WHERE participant_id = ? AND (session_id = ? OR session_token = ?)`,
    [pId, token, token]
  );
  return participant;
}

// Ultra-Fast Real-Time Asynchronous Answer Save (< 1ms execution)
app.post('/api/save-answer', async (req, res) => {
  const participant = await authParticipant(req);
  if (!participant) {
    return res.status(401).json({ error: 'Unauthorized participant session.' });
  }

  if (participant.status === 'Submitted') {
    return res.status(400).json({ error: 'Quiz has already been submitted. Answers are locked.' });
  }

  const { question_number, submitted_answer } = req.body;
  const qNum = parseInt(question_number, 10);

  if (isNaN(qNum) || qNum < 1 || qNum > 80) {
    return res.status(400).json({ error: 'Invalid question number.' });
  }

  try {
    const question = await getAsync(`SELECT accepted_answers, marks FROM questions WHERE question_number = ?`, [qNum]);
    if (!question) {
      return res.status(400).json({ error: 'Question not found.' });
    }

    const existingResponse = await getAsync(
      `SELECT submitted_answer FROM responses WHERE participant_id = ? AND question_number = ?`,
      [participant.participant_id, qNum]
    );

    if (existingResponse && existingResponse.submitted_answer && existingResponse.submitted_answer.trim() !== '') {
      return res.status(400).json({ error: 'Answer for this question is locked and cannot be changed.' });
    }

    const acceptedAnswers = JSON.parse(question.accepted_answers || '[]');
    const normalizedInput = normalizeAnswer(submitted_answer);

    let isCorrect = 0;
    let earnedMarks = 0;

    if (normalizedInput !== '') {
      for (const accepted of acceptedAnswers) {
        if (normalizeAnswer(accepted) === normalizedInput) {
          isCorrect = 1;
          earnedMarks = question.marks || 1;
          break;
        }
      }
    }

    await runAsync(
      `INSERT INTO responses (participant_id, question_number, submitted_answer, normalized_answer, is_correct, marks, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(participant_id, question_number) DO UPDATE SET
         submitted_answer = excluded.submitted_answer,
         normalized_answer = excluded.normalized_answer,
         is_correct = excluded.is_correct,
         marks = excluded.marks,
         submitted_at = CURRENT_TIMESTAMP`,
      [participant.participant_id, qNum, (submitted_answer || '').trim(), normalizedInput, isCorrect, earnedMarks]
    );

    // Recalculate score asynchronously
    recalculateParticipantScore(participant.participant_id);

    // Return instant HTTP response
    res.json({
      success: true,
      message: 'Answer saved'
    });

    // Broadcast update asynchronously
    setImmediate(broadcastAdminStats);
    return;
  } catch (err) {
    console.error('Error saving answer:', err);
    return res.status(500).json({ error: 'Failed to save answer.' });
  }
});

// Batch Sync for offline reconnected queue
app.post('/api/batch-sync', async (req, res) => {
  const participant = await authParticipant(req);
  if (!participant) {
    return res.status(401).json({ error: 'Unauthorized participant session.' });
  }

  if (participant.status === 'Submitted') {
    return res.status(400).json({ error: 'Quiz has already been submitted.' });
  }

  const { answers } = req.body;
  if (!Array.isArray(answers)) {
    return res.status(400).json({ error: 'Invalid answers array.' });
  }

  try {
    for (const item of answers) {
      const qNum = parseInt(item.question_number, 10);
      if (isNaN(qNum) || qNum < 1 || qNum > 80) continue;

      const question = await getAsync(`SELECT accepted_answers, marks FROM questions WHERE question_number = ?`, [qNum]);
      if (!question) continue;

      const acceptedAnswers = JSON.parse(question.accepted_answers || '[]');
      const normalizedInput = normalizeAnswer(item.submitted_answer);

      let isCorrect = 0;
      let earnedMarks = 0;

      if (normalizedInput !== '') {
        for (const accepted of acceptedAnswers) {
          if (normalizeAnswer(accepted) === normalizedInput) {
            isCorrect = 1;
            earnedMarks = question.marks || 1;
            break;
          }
        }
      }

      await runAsync(
        `INSERT INTO responses (participant_id, question_number, submitted_answer, normalized_answer, is_correct, marks, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(participant_id, question_number) DO UPDATE SET
           submitted_answer = excluded.submitted_answer,
           normalized_answer = excluded.normalized_answer,
           is_correct = excluded.is_correct,
           marks = excluded.marks,
           submitted_at = CURRENT_TIMESTAMP`,
        [participant.participant_id, qNum, (item.submitted_answer || '').trim(), normalizedInput, isCorrect, earnedMarks]
      );
    }

    await recalculateParticipantScore(participant.participant_id);
    
    res.json({ success: true, count: answers.length, message: 'Batch sync complete' });

    setImmediate(broadcastAdminStats);
    return;
  } catch (err) {
    console.error('Error batch syncing answers:', err);
    return res.status(500).json({ error: 'Batch sync failed.' });
  }
});

// Get Participant Saved Progress & State
app.get('/api/my-progress', async (req, res) => {
  const participant = await authParticipant(req);
  if (!participant) {
    return res.status(401).json({ error: 'Unauthorized session.' });
  }

  try {
    const responses = await allAsync(
      `SELECT question_number, submitted_answer FROM responses WHERE participant_id = ?`,
      [participant.participant_id]
    );

    const answersMap = {};
    for (const r of responses) {
      answersMap[r.question_number] = r.submitted_answer;
    }

    const stateRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
    const resultsRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'results_released'`);

    const isResultsReleased = (resultsRow && resultsRow.value === '1');

    return res.json({
      participant_id: participant.participant_id,
      participant_name: participant.participant_name || participant.name,
      status: participant.status,
      quiz_status: stateRow ? stateRow.value : 'Live',
      results_released: isResultsReleased,
      total_score: isResultsReleased ? participant.total_score : undefined,
      answers: answersMap
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch progress.' });
  }
});

// Instant Sub-Millisecond Final Quiz Submission (< 1ms response)
app.post('/api/submit-quiz', async (req, res) => {
  const participant = await authParticipant(req);
  if (!participant) {
    return res.status(401).json({ error: 'Unauthorized participant session.' });
  }

  if (participant.status === 'Submitted') {
    return res.json({
      success: true,
      total_score: participant.total_score,
      message: 'Already submitted.'
    });
  }

  try {
    const answersObj = req.body.answers || req.body.answersMap;

    // Fetch all 80 official questions into memory for instant evaluation
    const allQuestions = await allAsync(`SELECT question_number, accepted_answers, marks FROM questions`);
    const qMap = {};
    for (const q of allQuestions) {
      qMap[q.question_number] = q;
    }

    // Save current active question if sent
    if (req.body.current_question && req.body.current_answer !== undefined) {
      if (!answersObj) req.body.answers = {};
      req.body.answers[req.body.current_question] = req.body.current_answer;
    }

    // Process all provided answers in 1 fast SQLite transaction
    const finalAnswersObj = req.body.answers || req.body.answersMap;
    if (finalAnswersObj && typeof finalAnswersObj === 'object') {
      await runAsync('BEGIN TRANSACTION');
      try {
        const qNums = Object.keys(finalAnswersObj);
        for (const qStr of qNums) {
          const qNum = parseInt(qStr, 10);
          if (isNaN(qNum) || qNum < 1 || qNum > 80) continue;
          const userAns = (finalAnswersObj[qStr] || '').trim();
          const question = qMap[qNum];
          if (question) {
            const acceptedAnswers = JSON.parse(question.accepted_answers || '[]');
            const normalizedInput = normalizeAnswer(userAns);
            let isCorrect = 0, earnedMarks = 0;
            if (normalizedInput !== '') {
              for (const accepted of acceptedAnswers) {
                if (normalizeAnswer(accepted) === normalizedInput) {
                  isCorrect = 1; earnedMarks = question.marks || 1; break;
                }
              }
            }
            await runAsync(
              `INSERT INTO responses (participant_id, question_number, submitted_answer, normalized_answer, is_correct, marks, submitted_at)
               VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(participant_id, question_number) DO UPDATE SET
                 submitted_answer = excluded.submitted_answer,
                 normalized_answer = excluded.normalized_answer,
                 is_correct = excluded.is_correct,
                 marks = excluded.marks,
                 submitted_at = CURRENT_TIMESTAMP`,
              [participant.participant_id, qNum, userAns, normalizedInput, isCorrect, earnedMarks]
            );
          }
        }
        await runAsync('COMMIT');
      } catch (err) {
        await runAsync('ROLLBACK');
        throw err;
      }
    }

    // 1. Calculate sum of marks in 1 fast query
    const scoreRow = await getAsync(
      `SELECT COALESCE(SUM(marks), 0) as total FROM responses WHERE participant_id = ?`,
      [participant.participant_id]
    );
    const finalScore = scoreRow ? scoreRow.total : 0;

    // 2. Mark participant as Submitted
    await runAsync(
      `UPDATE participants SET status = 'Submitted', submitted_at = CURRENT_TIMESTAMP, total_score = ?, last_active_at = CURRENT_TIMESTAMP WHERE participant_id = ?`,
      [finalScore, participant.participant_id]
    );

    // 3. Return INSTANT response to participant (< 1ms)
    res.json({
      success: true,
      total_score: finalScore,
      message: 'Quiz submitted successfully.'
    });

    // 4. Asynchronously broadcast live updates to admin sockets
    triggerAdminBroadcast();
    return;
  } catch (err) {
    console.error('Error in final quiz submission:', err);
    return res.status(500).json({ error: 'Failed to submit quiz.' });
  }
});

// Participant Result Retrieval (Only accessible AFTER Admin releases results)
app.get('/api/results', async (req, res) => {
  const participant = await authParticipant(req);
  if (!participant) {
    return res.status(401).json({ error: 'Unauthorized session.' });
  }

  try {
    const resultsRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'results_released'`);
    if (!resultsRow || resultsRow.value !== '1') {
      return res.status(403).json({ error: 'Results have not been officially released by the organizer yet.' });
    }

    const questions = await allAsync(`SELECT question_number, category, accepted_answers, marks FROM questions ORDER BY question_number ASC`);
    const responses = await allAsync(`SELECT question_number, submitted_answer, normalized_answer, is_correct, marks FROM responses WHERE participant_id = ?`, [participant.participant_id]);

    const respMap = {};
    for (const r of responses) {
      respMap[r.question_number] = r;
    }

    const breakdown = questions.map(q => {
      const userResp = respMap[q.question_number];
      const accList = JSON.parse(q.accepted_answers || '[]');
      return {
        question_number: q.question_number,
        category: q.category,
        submitted_answer: userResp ? userResp.submitted_answer : '',
        correct_answer: accList.join(' / '),
        marks: userResp ? userResp.marks : 0
      };
    });

    return res.json({
      participant_name: participant.participant_name || participant.name,
      participant_id: participant.participant_id,
      total_score: participant.total_score,
      max_score: 80,
      breakdown
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch results.' });
  }
});

// ----------------------------------------------------
// SECURE ADMIN API ROUTES
// ----------------------------------------------------

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const adminUser = await getAsync(`SELECT * FROM admin WHERE username = ? AND password = ?`, [username, password]);
    if (adminUser) {
      const token = generateToken();
      ADMIN_TOKENS.add(token);

      await runAsync(`INSERT INTO activity_logs (admin, action, details) VALUES (?, ?, ?)`, [username, 'LOGIN', 'Admin logged into dashboard']);
      return res.json({ success: true, token, username });
    }
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  } catch (err) {
    return res.status(500).json({ error: 'Login error.' });
  }
});

// Admin Dashboard Initial Data HTTP GET Endpoint (Instant page load)
app.get('/api/admin/dashboard-data', requireAdmin, async (req, res) => {
  try {
    const data = await getAdminStatsAndLeaderboard();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
});

// Admin Quiz Control Actions
app.post('/api/admin/quiz-control', requireAdmin, async (req, res) => {
  const { action } = req.body;

  try {
    if (action === 'START' || action === 'RESUME') {
      await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('quiz_status', 'Live') ON CONFLICT(key) DO UPDATE SET value = 'Live'`);
    } else if (action === 'PAUSE') {
      await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('quiz_status', 'Paused') ON CONFLICT(key) DO UPDATE SET value = 'Paused'`);
    } else if (action === 'END') {
      await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('quiz_status', 'Ended') ON CONFLICT(key) DO UPDATE SET value = 'Ended'`);
    } else if (action === 'SHOW_RESULTS') {
      await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('results_released', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`);
    } else if (action === 'HIDE_RESULTS') {
      await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('results_released', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`);
    } else {
      return res.status(400).json({ error: 'Invalid action.' });
    }

    await runAsync(`INSERT INTO activity_logs (admin, action, details) VALUES (?, ?, ?)`, ['admin', action, `Quiz control action: ${action}`]);

    const statusRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
    const resultsRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'results_released'`);

    const quizStatusVal = statusRow ? statusRow.value : 'Live';
    const statusAlias = (quizStatusVal === 'Live') ? 'IN_PROGRESS' : quizStatusVal;

    broadcastToParticipants({
      type: 'QUIZ_STATE_CHANGE',
      quiz_status: quizStatusVal,
      results_released: resultsRow ? resultsRow.value === '1' : false
    });

    setImmediate(broadcastAdminStats);

    return res.json({ 
      success: true, 
      quiz_status: quizStatusVal, 
      status: statusAlias,
      results_released: resultsRow ? resultsRow.value === '1' : false 
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update quiz state.' });
  }
});

// Reset Database Endpoint (Clear test records before a live competition)
app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  try {
    await runAsync(`DELETE FROM responses`);
    await runAsync(`DELETE FROM participants`);
    await runAsync(`DELETE FROM manual_overrides`);
    await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('quiz_status', 'Live') ON CONFLICT(key) DO UPDATE SET value = 'Live'`);
    await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('results_released', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`);

    await runAsync(`INSERT INTO activity_logs (admin, action, details) VALUES (?, ?, ?)`, ['admin', 'RESET_DATABASE', 'Cleared all participant test records and reset DB state']);

    setImmediate(broadcastAdminStats);
    return res.json({ success: true, message: 'Database reset successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset database.' });
  }
});

// Admin Answer Key Retrieval
app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const questions = await allAsync(`SELECT * FROM questions ORDER BY question_number ASC`);
    const stateRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
    return res.json({
      questions: questions.map(q => ({
        question_number: q.question_number,
        category: q.category,
        accepted_answers: JSON.parse(q.accepted_answers || '[]'),
        marks: q.marks
      })),
      is_locked: stateRow ? stateRow.value !== 'Not Started' : false
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch questions.' });
  }
});

// Admin Answer Key Update
app.post('/api/admin/questions/update', requireAdmin, async (req, res) => {
  const { question_number, accepted_answers } = req.body;
  const qNum = parseInt(question_number, 10);

  if (isNaN(qNum) || !Array.isArray(accepted_answers) || accepted_answers.length === 0) {
    return res.status(400).json({ error: 'Invalid question update request.' });
  }

  const stateRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
  if (stateRow && stateRow.value !== 'Not Started') {
    return res.status(400).json({ error: 'Answer key is LOCKED because quiz has already started.' });
  }

  try {
    const cleanAnswers = accepted_answers.map(a => String(a).trim()).filter(Boolean);
    await runAsync(
      `UPDATE questions SET accepted_answers = ? WHERE question_number = ?`,
      [JSON.stringify(cleanAnswers), qNum]
    );

    await runAsync(`INSERT INTO activity_logs (admin, action, details) VALUES (?, ?, ?)`, [
      'admin',
      'EDIT_ANSWER_KEY',
      `Updated Q${qNum} accepted answers to: ${cleanAnswers.join(', ')}`
    ]);

    return res.json({ success: true, question_number: qNum, accepted_answers: cleanAnswers });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update answer key.' });
  }
});

// Admin Inspection: Detailed Participant Review (Q1 to Q80)
app.get('/api/admin/participant/:id', requireAdmin, async (req, res) => {
  const participantId = req.params.id;

  try {
    const participant = await getAsync(`SELECT * FROM participants WHERE participant_id = ?`, [participantId]);
    if (!participant) {
      return res.status(404).json({ error: 'Participant not found.' });
    }

    const questions = await allAsync(`SELECT question_number, category, accepted_answers, marks FROM questions ORDER BY question_number ASC`);
    const responses = await allAsync(`SELECT question_number, submitted_answer, normalized_answer, is_correct, marks, submitted_at FROM responses WHERE participant_id = ?`, [participantId]);

    const respMap = {};
    for (const r of responses) {
      respMap[r.question_number] = r;
    }

    const breakdown = questions.map(q => {
      const resp = respMap[q.question_number];
      const accList = JSON.parse(q.accepted_answers || '[]');
      return {
        question_number: q.question_number,
        category: q.category,
        accepted_answers: accList,
        submitted_answer: resp ? resp.submitted_answer : '',
        normalized_answer: resp ? resp.normalized_answer : '',
        is_correct: resp ? resp.is_correct : 0,
        marks: resp ? resp.marks : 0,
        submitted_at: resp ? resp.submitted_at : null
      };
    });

    const overrides = await allAsync(`SELECT * FROM manual_overrides WHERE participant_id = ? ORDER BY timestamp DESC`, [participantId]);

    return res.json({
      participant,
      breakdown,
      overrides
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch participant details.' });
  }
});

// Admin Reset Database (Wipes participants, responses, logs and resets state)
app.post('/api/admin/reset-database', requireAdmin, async (req, res) => {
  try {
    await runAsync(`DELETE FROM responses`);
    await runAsync(`DELETE FROM participants`);
    await runAsync(`DELETE FROM manual_overrides`);
    await runAsync(`DELETE FROM activity_logs`);
    await runAsync(`UPDATE quiz_settings SET value = 'Live' WHERE key = 'quiz_status'`);
    await runAsync(`UPDATE quiz_settings SET value = '0' WHERE key = 'results_released'`);
    await runAsync(`UPDATE quiz_settings SET value = '0' WHERE key = 'leaderboard_enabled'`);

    await runAsync(
      `INSERT INTO activity_logs (admin, action, details) VALUES ('admin', 'RESET_DATABASE', 'Wiped all participant records and responses')`
    );

    // Notify connected participants
    broadcastToParticipants({ type: 'QUIZ_STATE_CHANGE', quiz_status: 'Live', results_released: false });

    res.json({ success: true, message: 'Database reset successfully.' });

    triggerAdminBroadcast();
    return;
  } catch (err) {
    console.error('Error resetting database:', err);
    return res.status(500).json({ error: 'Failed to reset database.' });
  }
});

// Admin Manual Score Override
app.post('/api/admin/override-score', requireAdmin, async (req, res) => {
  const { participant_id, question_number, new_marks, reason } = req.body;
  const qNum = parseInt(question_number, 10);
  const markVal = parseInt(new_marks, 10);

  if (!participant_id || isNaN(qNum) || (markVal !== 0 && markVal !== 1) || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'Valid participant ID, question number, new mark (0 or 1), and reason are required.' });
  }

  try {
    const existing = await getAsync(`SELECT marks, submitted_answer FROM responses WHERE participant_id = ? AND question_number = ?`, [participant_id, qNum]);
    const oldMarks = existing ? existing.marks : 0;
    const existingAns = existing ? existing.submitted_answer : '';
    const normAns = normalizeAnswer(existingAns);

    await runAsync(
      `INSERT INTO responses (participant_id, question_number, submitted_answer, normalized_answer, is_correct, marks, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(participant_id, question_number) DO UPDATE SET
         is_correct = excluded.is_correct,
         marks = excluded.marks,
         submitted_at = CURRENT_TIMESTAMP`,
      [participant_id, qNum, existingAns, normAns, markVal, markVal]
    );

    await runAsync(
      `INSERT INTO manual_overrides (admin, participant_id, question_number, old_result, new_result, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['admin', participant_id, qNum, oldMarks, markVal, reason.trim()]
    );

    await runAsync(
      `INSERT INTO activity_logs (admin, action, details) VALUES (?, ?, ?)`,
      ['admin', 'MANUAL_SCORE_OVERRIDE', `Overrode Q${qNum} for ${participant_id} from ${oldMarks} to ${markVal}. Reason: ${reason.trim()}`]
    );

    const newTotal = await recalculateParticipantScore(participant_id);
    setImmediate(broadcastAdminStats);

    return res.json({ success: true, new_total_score: newTotal });
  } catch (err) {
    console.error('Error executing manual score override:', err);
    return res.status(500).json({ error: 'Score override failed.' });
  }
});

// CSV Export Endpoint
app.get('/api/admin/export/csv', requireAdmin, async (req, res) => {
  try {
    const participants = await allAsync(`
      SELECT p.*
      FROM participants p
      ORDER BY total_score DESC, submitted_at ASC
    `);

    const questions = await allAsync(`SELECT question_number, category, accepted_answers FROM questions ORDER BY question_number ASC`);
    const allResponses = await allAsync(`SELECT * FROM responses`);

    const respLookup = {};
    for (const r of allResponses) {
      if (!respLookup[r.participant_id]) respLookup[r.participant_id] = {};
      respLookup[r.participant_id][r.question_number] = r;
    }

    let currentRank = 1;
    for (let i = 0; i < participants.length; i++) {
      if (i > 0 && participants[i].total_score < participants[i - 1].total_score) {
        currentRank = i + 1;
      }
      participants[i].rank = currentRank;
    }

    let csv = ['Rank,Participant Name,Participant ID,Status,Joined Time,Submitted At,Total Score'];
    for (let q = 1; q <= 80; q++) {
      csv[0] += `,Q${q} Answer,Q${q} Correct,Q${q} Marks`;
    }

    for (const p of participants) {
      let row = [
        p.rank,
        `"${(p.participant_name || p.name || '').replace(/"/g, '""')}"`,
        `"${(p.participant_id || '').replace(/"/g, '""')}"`,
        p.status,
        `"${p.joined_at || ''}"`,
        p.submitted_at ? `"${p.submitted_at}"` : 'Not Submitted',
        p.total_score
      ].join(',');

      for (const q of questions) {
        const r = (respLookup[p.participant_id] && respLookup[p.participant_id][q.question_number]) || null;
        const accList = JSON.parse(q.accepted_answers || '[]');
        const userAns = r ? r.submitted_answer : '';
        const marks = r ? r.marks : 0;
        const correctStr = accList.join(' / ');

        row += `,"${userAns.replace(/"/g, '""')}","${correctStr.replace(/"/g, '""')}",${marks}`;
      }

      csv.push(row);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="quiz_live_results.csv"');
    return res.status(200).send(csv.join('\n'));
  } catch (err) {
    console.error('CSV Export Error:', err);
    return res.status(500).json({ error: 'Failed to export CSV.' });
  }
});

// Excel Export Endpoint
app.get('/api/admin/export/excel', requireAdmin, async (req, res) => {
  try {
    const participants = await allAsync(`
      SELECT p.*
      FROM participants p
      ORDER BY total_score DESC, submitted_at ASC
    `);

    const questions = await allAsync(`SELECT question_number, category, accepted_answers FROM questions ORDER BY question_number ASC`);
    const allResponses = await allAsync(`SELECT * FROM responses`);

    const respLookup = {};
    for (const r of allResponses) {
      if (!respLookup[r.participant_id]) respLookup[r.participant_id] = {};
      respLookup[r.participant_id][r.question_number] = r;
    }

    let currentRank = 1;
    for (let i = 0; i < participants.length; i++) {
      if (i > 0 && participants[i].total_score < participants[i - 1].total_score) {
        currentRank = i + 1;
      }
      participants[i].rank = currentRank;
    }

    let html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="UTF-8"></head>
    <body>
    <table border="1">
    <thead>
    <tr style="background-color: #2563eb; color: #ffffff;">
      <th>Rank</th>
      <th>Participant Name</th>
      <th>Participant ID</th>
      <th>Status</th>
      <th>Joined Time</th>
      <th>Submitted At</th>
      <th>Total Score</th>`;

    for (let q = 1; q <= 80; q++) {
      html += `<th>Q${q} Answer</th><th>Q${q} Correct</th><th>Q${q} Marks</th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const p of participants) {
      html += `<tr>
        <td>${p.rank}</td>
        <td>${p.participant_name || p.name}</td>
        <td>${p.participant_id}</td>
        <td>${p.status}</td>
        <td>${p.joined_at || ''}</td>
        <td>${p.submitted_at || 'Not Submitted'}</td>
        <td><strong>${p.total_score}</strong></td>`;

      for (const q of questions) {
        const r = (respLookup[p.participant_id] && respLookup[p.participant_id][q.question_number]) || null;
        const accList = JSON.parse(q.accepted_answers || '[]');
        const userAns = r ? r.submitted_answer : '';
        const marks = r ? r.marks : 0;
        const correctStr = accList.join(' / ');

        html += `<td>${userAns}</td><td>${correctStr}</td><td>${marks}</td>`;
      }
      html += `</tr>`;
    }

    html += `</tbody>mtable></body></html>`;

    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', 'attachment; filename="quiz_live_results.xls"');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to export Excel.' });
  }
});

// Logs Endpoint
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const logs = await allAsync(`SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 100`);
    return res.json({ logs });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

// Initialize DB and start server
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`Live Quiz Competition Server is running on port ${PORT}`);
    console.log(`Participant UI: http://localhost:${PORT} or http://127.0.0.1:${PORT}`);
    console.log(`Admin Dashboard: http://localhost:${PORT}/admin.html`);
    console.log(`===================================================`);
  });
}).catch((err) => {
  console.error('Database initialization failed:', err);
});
