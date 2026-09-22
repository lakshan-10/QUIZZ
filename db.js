const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'quiz.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to persistent SQLite database at', DB_PATH);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }
});

// Helper wrapper for async database operations
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Levenshtein Distance for fuzzy typo-tolerant evaluation
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

// Enhanced Answer Normalization Helper (removes spaces, hyphens, apostrophes, punctuation)
function normalizeAnswer(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Smart Evaluation Engine (Exact + Normalized + Fuzzy Edit Distance <= 1 or 2)
function evaluateAnswer(submittedAnswer, acceptedAnswersList, questionMarks = 1) {
  if (!submittedAnswer || typeof submittedAnswer !== 'string') {
    return { isCorrect: 0, marks: 0 };
  }

  const rawInput = submittedAnswer.trim();
  if (!rawInput) return { isCorrect: 0, marks: 0 };

  const normInput = normalizeAnswer(rawInput);
  if (!normInput) return { isCorrect: 0, marks: 0 };

  let list = acceptedAnswersList;
  if (!Array.isArray(list)) {
    try {
      list = JSON.parse(list || '[]');
    } catch (e) {
      list = [String(list)];
    }
  }

  for (const target of list) {
    if (!target) continue;
    const rawTarget = String(target).trim();
    const normTarget = normalizeAnswer(rawTarget);

    if (!normTarget) continue;

    // 1. Exact normalized match (e.g. "maggi" vs "maggi", "coca cola" vs "cocacola")
    if (normInput === normTarget) {
      return { isCorrect: 1, marks: questionMarks };
    }

    // 2. Fuzzy Levenshtein Match for typos (e.g. "maggi" vs "maggie" dist=1)
    const dist = levenshteinDistance(normInput, normTarget);
    const maxAllowedDist = normTarget.length <= 4 ? 0 : (normTarget.length <= 7 ? 1 : 2);

    if (dist <= maxAllowedDist) {
      return { isCorrect: 1, marks: questionMarks };
    }

    // 3. Substring match for long brand/person names (e.g. "Hindustan Unilever Limited" vs "Hindustan Unilever")
    if (normTarget.length >= 8 && (normInput.includes(normTarget) || normTarget.includes(normInput))) {
      const lenDiff = Math.abs(normInput.length - normTarget.length);
      if (lenDiff <= 5) {
        return { isCorrect: 1, marks: questionMarks };
      }
    }
  }

  return { isCorrect: 0, marks: 0 };
}

// Initial 80 Official Questions with comprehensive alternate spellings & aliases
const INITIAL_QUESTIONS = [
  // Round 1 — GUESS THE BRAND (Q1-Q20)
  { q: 1, c: 'Guess the Brand', a: ['Firstcry', 'First Cry'] },
  { q: 2, c: 'Guess the Brand', a: ['Maggie', 'Maggi', 'Maggy'] },
  { q: 3, c: 'Guess the Brand', a: ['Booking.com', 'Booking', 'Booking com'] },
  { q: 4, c: 'Guess the Brand', a: ['Wildcraft', 'Wild craft'] },
  { q: 5, c: 'Guess the Brand', a: ['Paisabazzar', 'Paisa bazaar', 'Paisabazaar', 'Paisa bazzar'] },
  { q: 6, c: 'Guess the Brand', a: ['Cadbury'] },
  { q: 7, c: 'Guess the Brand', a: ['Shadowfox', 'Shadow fox'] },
  { q: 8, c: 'Guess the Brand', a: ['Microsoft'] },
  { q: 9, c: 'Guess the Brand', a: ['Lamborgini', 'Lamborghini'] },
  { q: 10, c: 'Guess the Brand', a: ['Fastrack', 'Fast track'] },
  { q: 11, c: 'Guess the Brand', a: ['Ibacco', 'Ibacoo'] },
  { q: 12, c: 'Guess the Brand', a: ['Starbucks', 'Star bucks'] },
  { q: 13, c: 'Guess the Brand', a: ['Paragon'] },
  { q: 14, c: 'Guess the Brand', a: ['Subway', 'Sub way'] },
  { q: 15, c: 'Guess the Brand', a: ['Hindustan Unilever', 'HUL', 'Hindustan Unilever Limited'] },
  { q: 16, c: 'Guess the Brand', a: ['Baskin Robbins', 'Baskin-Robbins'] },
  { q: 17, c: 'Guess the Brand', a: ['Bank of America', 'BOA'] },
  { q: 18, c: 'Guess the Brand', a: ['Ubisoft'] },
  { q: 19, c: 'Guess the Brand', a: ['Snapdeal', 'Snap deal'] },
  { q: 20, c: 'Guess the Brand', a: ['Maxfashion', 'Max fashion', 'Max'] },

  // Round 2 — GUESS THE PERSON (Q21-Q40)
  { q: 21, c: 'Guess the Person', a: ['Warren Buffett', 'Warren Buffet'] },
  { q: 22, c: 'Guess the Person', a: ['Jensen Huang'] },
  { q: 23, c: 'Guess the Person', a: ['Michael Jordan'] },
  { q: 24, c: 'Guess the Person', a: ['Anand Mahindra'] },
  { q: 25, c: 'Guess the Person', a: ['Jeff Bezos'] },
  { q: 26, c: 'Guess the Person', a: ['Bill gates', 'Bill Gates', 'Bill Gate'] },
  { q: 27, c: 'Guess the Person', a: ['Sam Altman'] },
  { q: 28, c: 'Guess the Person', a: ['Reed Hastings'] },
  { q: 29, c: 'Guess the Person', a: ['Gautam Adani', 'Adani'] },
  { q: 30, c: 'Guess the Person', a: ['Leonardo dicaprio', 'Leonardo DiCaprio', 'DiCaprio', 'Leonardo Di Caprio'] },
  { q: 31, c: 'Guess the Person', a: ['N. R. Narayana Murthy', 'Narayana Murthy', 'Narayanamurthy'] },
  { q: 32, c: 'Guess the Person', a: ['Ghazal Alagh'] },
  { q: 33, c: 'Guess the Person', a: ['Sridhar Vembu'] },
  { q: 34, c: 'Guess the Person', a: ['Azim Premji'] },
  { q: 35, c: 'Guess the Person', a: ['Droupadi Murmu', 'Draupadi Murmu'] },
  { q: 36, c: 'Guess the Person', a: ['Anne Hathaway'] },
  { q: 37, c: 'Guess the Person', a: ['Morgan Freeman'] },
  { q: 38, c: 'Guess the Person', a: ['Pankaj Tripathi'] },
  { q: 39, c: 'Guess the Person', a: ['Al Pacino'] },
  { q: 40, c: 'Guess the Person', a: ['Quentin Tarantino'] },

  // Round 3 — IDENTIFY THE LOGO (Q41-Q60)
  { q: 41, c: 'Identify the Logo', a: ['Apple'] },
  { q: 42, c: 'Identify the Logo', a: ['Starbucks'] },
  { q: 43, c: 'Identify the Logo', a: ['Volvo'] },
  { q: 44, c: 'Identify the Logo', a: ['Nintendo'] },
  { q: 45, c: 'Identify the Logo', a: ['Shell'] },
  { q: 46, c: 'Identify the Logo', a: ['Indian overseas bank', 'IOB'] },
  { q: 47, c: 'Identify the Logo', a: ['Huawei'] },
  { q: 48, c: 'Identify the Logo', a: ['Amazon'] },
  { q: 49, c: 'Identify the Logo', a: ['Lexus'] },
  { q: 50, c: 'Identify the Logo', a: ['Nvidia'] },
  { q: 51, c: 'Identify the Logo', a: ['Converse'] },
  { q: 52, c: 'Identify the Logo', a: ['Goldstar', 'LG'] },
  { q: 53, c: 'Identify the Logo', a: ['Adhitiya birla', 'Aditya birla', 'Aditiya birla'] },
  { q: 54, c: 'Identify the Logo', a: ['Times of india', 'TOI'] },
  { q: 55, c: 'Identify the Logo', a: ['Snapdragon'] },
  { q: 56, c: 'Identify the Logo', a: ['Accenture'] },
  { q: 57, c: 'Identify the Logo', a: ['Acura'] },
  { q: 58, c: 'Identify the Logo', a: ['Bing'] },
  { q: 59, c: 'Identify the Logo', a: ['Ralph Lauren'] },
  { q: 60, c: 'Identify the Logo', a: ['YouTube'] },

  // Round 4 — IDENTIFY THE TAGLINE (Q61-Q80)
  { q: 61, c: 'Identify the Tagline', a: ["McDonald's", 'McDonalds', 'Mc Donalds'] },
  { q: 62, c: 'Identify the Tagline', a: ['Nike'] },
  { q: 63, c: 'Identify the Tagline', a: ['Apple'] },
  { q: 64, c: 'Identify the Tagline', a: ['Disney'] },
  { q: 65, c: 'Identify the Tagline', a: ['Coco cola', 'Coca cola', 'Coca-cola', 'Coke', 'Cocacola'] },
  { q: 66, c: 'Identify the Tagline', a: ['Adidas'] },
  { q: 67, c: 'Identify the Tagline', a: ['Subway'] },
  { q: 68, c: 'Identify the Tagline', a: ["L'Oréal Paris", 'Loreal', 'Loreal Paris', "L'Oreal"] },
  { q: 69, c: 'Identify the Tagline', a: ["M&M's", 'M&M', 'M and M'] },
  { q: 70, c: 'Identify the Tagline', a: ['Raymond'] },
  { q: 71, c: 'Identify the Tagline', a: ['Thumbs up', 'Thums Up', 'Thumbs Up'] },
  { q: 72, c: 'Identify the Tagline', a: ['Airtel'] },
  { q: 73, c: 'Identify the Tagline', a: ['BMW'] },
  { q: 74, c: 'Identify the Tagline', a: ['Burger King'] },
  { q: 75, c: 'Identify the Tagline', a: ['Nokia'] },
  { q: 76, c: 'Identify the Tagline', a: ['Kingfisher'] },
  { q: 77, c: 'Identify the Tagline', a: ['Pinterest'] },
  { q: 78, c: 'Identify the Tagline', a: ['KTM'] },
  { q: 79, c: 'Identify the Tagline', a: ['IMAX'] },
  { q: 80, c: 'Identify the Tagline', a: ['Google'] }
];

async function initDB() {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        // PARTICIPANTS Table (Exact requirements)
        await runAsync(`
          CREATE TABLE IF NOT EXISTS participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id TEXT UNIQUE NOT NULL,
            participant_name TEXT,
            session_id TEXT,
            status TEXT DEFAULT 'Active',
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            submitted_at DATETIME,
            total_score INTEGER DEFAULT 0
          )
        `);

        // Safe column migrations for backwards compatibility
        try { await runAsync(`ALTER TABLE participants ADD COLUMN participant_name TEXT`); } catch (e) {}
        try { await runAsync(`ALTER TABLE participants ADD COLUMN session_id TEXT`); } catch (e) {}
        try { await runAsync(`ALTER TABLE participants ADD COLUMN last_active_at DATETIME`); } catch (e) {}
        try { await runAsync(`ALTER TABLE responses ADD COLUMN normalized_answer TEXT`); } catch (e) {}
        try { await runAsync(`UPDATE participants SET participant_name = name WHERE participant_name IS NULL AND name IS NOT NULL`); } catch (e) {}
        try { await runAsync(`UPDATE participants SET session_id = session_token WHERE session_id IS NULL AND session_token IS NOT NULL`); } catch (e) {}

        // QUESTIONS Table (Exact requirements)
        await runAsync(`
          CREATE TABLE IF NOT EXISTS questions (
            question_number INTEGER PRIMARY KEY,
            category TEXT NOT NULL,
            accepted_answers TEXT NOT NULL,
            marks INTEGER DEFAULT 1
          )
        `);

        // RESPONSES Table (Exact requirements: includes normalized_answer)
        await runAsync(`
          CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_id TEXT NOT NULL,
            question_number INTEGER NOT NULL,
            submitted_answer TEXT,
            normalized_answer TEXT,
            is_correct INTEGER DEFAULT 0,
            marks INTEGER DEFAULT 0,
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (participant_id, question_number)
          )
        `);

        // Performance Indexes for instant response time
        try { await runAsync(`CREATE INDEX IF NOT EXISTS idx_responses_pid ON responses (participant_id)`); } catch (e) {}
        try { await runAsync(`CREATE INDEX IF NOT EXISTS idx_responses_pid_ans ON responses (participant_id, submitted_answer)`); } catch (e) {}
        try { await runAsync(`CREATE INDEX IF NOT EXISTS idx_participants_status ON participants (status)`); } catch (e) {}

        // ADMIN Table
        await runAsync(`
          CREATE TABLE IF NOT EXISTS admin (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL
          )
        `);

        // ACTIVITY_LOGS Table
        await runAsync(`
          CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin TEXT,
            action TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            details TEXT
          )
        `);

        // MANUAL_OVERRIDES Table
        await runAsync(`
          CREATE TABLE IF NOT EXISTS manual_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin TEXT,
            participant_id TEXT,
            question_number INTEGER,
            old_result INTEGER,
            new_result INTEGER,
            reason TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // QUIZ SETTINGS / QUIZ STATE Table
        await runAsync(`
          CREATE TABLE IF NOT EXISTS quiz_settings (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);

        // TIE BREAKERS Table
        await runAsync(`
          CREATE TABLE IF NOT EXISTS tie_breakers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            participant_ids TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Default Quiz Settings initialization
        const statusRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'quiz_status'`);
        if (!statusRow) {
          await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('quiz_status', 'Live')`);
        }

        const resultRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'results_released'`);
        if (!resultRow) {
          await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('results_released', '0')`);
        }

        const leaderboardRow = await getAsync(`SELECT value FROM quiz_settings WHERE key = 'leaderboard_enabled'`);
        if (!leaderboardRow) {
          await runAsync(`INSERT INTO quiz_settings (key, value) VALUES ('leaderboard_enabled', '0')`);
        }

        // Admin Default Account
        const adminUser = await getAsync(`SELECT username FROM admin WHERE username = 'admin'`);
        if (!adminUser) {
          await runAsync(`INSERT INTO admin (username, password) VALUES ('admin', 'admin123')`);
        }

        // Seed 80 Questions if table is empty
        const qCountRow = await getAsync(`SELECT COUNT(*) as count FROM questions`);
        if (!qCountRow || qCountRow.count === 0) {
          console.log('Seeding initial 80 questions and official answer key...');
          for (const item of INITIAL_QUESTIONS) {
            await runAsync(
              `INSERT INTO questions (question_number, category, accepted_answers, marks) VALUES (?, ?, ?, 1)`,
              [item.q, item.c, JSON.stringify(item.a)]
            );
          }
          console.log('80 Questions seeded successfully.');
        }

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Function to calculate participant total score from real DB responses
async function recalculateParticipantScore(participantId) {
  const row = await getAsync(
    `SELECT SUM(marks) as score FROM responses WHERE participant_id = ?`,
    [participantId]
  );
  const totalScore = (row && row.score) ? row.score : 0;
  await runAsync(
    `UPDATE participants SET total_score = ? WHERE participant_id = ?`,
    [totalScore, participantId]
  );
  return totalScore;
}

module.exports = {
  db,
  runAsync,
  getAsync,
  allAsync,
  normalizeAnswer,
  evaluateAnswer,
  levenshteinDistance,
  initDB,
  recalculateParticipantScore
};
