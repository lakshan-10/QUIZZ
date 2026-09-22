const http = require('http');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = {};
        try {
          if (data) json = JSON.parse(data);
        } catch (e) {
          json = { _raw: data };
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// 80 Questions Official Key Mapping
const OFFICIAL_ANSWERS = {
  1: 'Firstcry', 2: 'Maggie', 3: 'Booking.com', 4: 'Wildcraft', 5: 'Paisabazzar',
  6: 'Cadbury', 7: 'Shadowfox', 8: 'Microsoft', 9: 'Lamborgini', 10: 'Fastrack',
  11: 'Ibacco', 12: 'Starbucks', 13: 'Paragon', 14: 'Subway', 15: 'Hindustan Unilever',
  16: 'Baskin Robbins', 17: 'Bank of America', 18: 'Ubisoft', 19: 'Snapdeal', 20: 'Maxfashion',
  21: 'Warren Buffett', 22: 'Jensen Huang', 23: 'Michael Jordan', 24: 'Anand Mahindra', 25: 'Jeff Bezos',
  26: 'Bill gates', 27: 'Sam Altman', 28: 'Reed Hastings', 29: 'Gautam Adani', 30: 'Leonardo dicaprio',
  31: 'N. R. Narayana Murthy', 32: 'Ghazal Alagh', 33: 'Sridhar Vembu', 34: 'Azim Premji', 35: 'Droupadi Murmu',
  36: 'Anne Hathaway', 37: 'Morgan Freeman', 38: 'Pankaj Tripathi', 39: 'Al Pacino', 40: 'Quentin Tarantino',
  41: 'Apple', 42: 'Starbucks', 43: 'Volvo', 44: 'Nintendo', 45: 'Shell',
  46: 'Indian overseas bank', 47: 'Huawei', 48: 'Amazon', 49: 'Lexus', 50: 'Nvidia',
  51: 'Converse', 52: 'LG', 53: 'Adhitiya birla', 54: 'Times of india', 55: 'Snapdragon',
  56: 'Accenture', 57: 'Acura', 58: 'Bing', 59: 'Ralph Lauren', 60: 'YouTube',
  61: "McDonald's", 62: 'Nike', 63: 'Apple', 64: 'Disney', 65: 'Coco cola',
  66: 'Adidas', 67: 'Subway', 68: "L'Oréal Paris", 69: "M&M's", 70: 'Raymond',
  71: 'Thumbs up', 72: 'Airtel', 73: 'BMW', 74: 'Burger King', 75: 'Nokia',
  76: 'Kingfisher', 77: 'Pinterest', 78: 'KTM', 79: 'IMAX', 80: 'Google'
};

async function runFinalAcceptanceTest() {
  console.log('===========================================================');
  console.log('EXECUTING REQUIREMENT 30 FINAL ACCEPTANCE TEST (TEST001)');
  console.log('===========================================================');

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  // Admin Login
  const adminRes = await request('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  assert(adminRes.status === 200 && adminRes.body.token, 'Admin authenticated.');
  const adminToken = adminRes.body.token;

  // Set Quiz Live & Hide Results initially
  await request('POST', '/api/admin/quiz-control', { action: 'START' }, { Authorization: `Bearer ${adminToken}` });
  await request('POST', '/api/admin/quiz-control', { action: 'HIDE_RESULTS' }, { Authorization: `Bearer ${adminToken}` });

  // Requirement 30 Participant:
  // Name: Test Participant
  // ID: TEST001
  console.log('\n--- 1. Registering Participant TEST001 ---');
  const testId = `TEST001_${Date.now().toString().slice(-4)}`;
  const regRes = await request('POST', '/api/register', {
    participant_name: 'Test Participant',
    participant_id: testId
  });

  console.log('DEBUG regRes status:', regRes.status, 'body:', regRes.body);
  assert(regRes.status === 200 && regRes.body.participant_id === testId, `Participant ${testId} ("Test Participant") registered.`);
  const sessionId = regRes.body.session_id;

  // Build known answers:
  // Q1-Q60: Correct answers (60 marks)
  // Q61-Q70: Wrong answers (0 marks)
  // Q71-Q80: Blank answers (0 marks)
  // Total expected score: 60 / 80

  console.log('\n--- 2. Submitting 80 Known Answers to Real Database ---');
  const batchAnswers = [];
  for (let q = 1; q <= 80; q++) {
    let ans = '';
    if (q <= 60) {
      ans = OFFICIAL_ANSWERS[q];
      if (q === 52) ans = 'Goldstar'; // Testing Goldstar multi-answer
    } else if (q <= 70) {
      ans = 'Wrong Brand Answer';
    } else {
      ans = ''; // Blank
    }
    batchAnswers.push({ question_number: q, submitted_answer: ans });
  }

  const syncRes = await request('POST', '/api/batch-sync', {
    participant_id: testId,
    session_id: sessionId,
    answers: batchAnswers
  });

  assert(syncRes.status === 200, 'All 80 answers saved to database via batch sync.');

  // Final Quiz Submission
  console.log('\n--- 3. Executing Final Quiz Submission & Server Evaluation ---');
  const submitRes = await request('POST', '/api/submit-quiz', {
    participant_id: testId,
    session_id: sessionId
  });

  assert(submitRes.status === 200 && submitRes.body.total_score === 60, 'Backend evaluated all 80 questions: 60 correct (1 mark), 10 wrong (0 marks), 10 blank (0 marks). Total score = 60/80.');

  // Verify Results Hidden Check
  console.log('\n--- 4. Checking Results Hidden Rule ---');
  const preReleaseRes = await request('GET', '/api/results', null, {
    'x-participant-id': testId,
    'x-session-token': sessionId
  });
  assert(preReleaseRes.status === 403, 'Participant results endpoint returns 403 Forbidden while results are hidden.');

  // Admin Inspection of TEST001
  console.log('\n--- 5. Admin Live Database Inspection of TEST001 ---');
  const inspectRes = await request('GET', `/api/admin/participant/${testId}`, null, { Authorization: `Bearer ${adminToken}` });
  assert(inspectRes.status === 200 && inspectRes.body.participant.total_score === 60, `Admin retrieved ${testId} record from DB. Total score = 60/80.`);
  assert(inspectRes.body.breakdown.length === 80, `Admin inspected all 80 responses for ${testId}.`);

  const q1Resp = inspectRes.body.breakdown.find(q => q.question_number === 1);
  const q65Resp = inspectRes.body.breakdown.find(q => q.question_number === 65);
  const q75Resp = inspectRes.body.breakdown.find(q => q.question_number === 75);

  assert(q1Resp.marks === 1 && q1Resp.is_correct === 1, 'Q1 (Correct) received 1 mark.');
  assert(q65Resp.marks === 0 && q65Resp.is_correct === 0, 'Q65 (Wrong) received 0 marks.');
  assert(q75Resp.marks === 0 && q75Resp.is_correct === 0, 'Q75 (Blank) received 0 marks.');

  // Release Results Action
  console.log('\n--- 6. Admin Releases Results ---');
  const releaseRes = await request('POST', '/api/admin/quiz-control', { action: 'SHOW_RESULTS' }, { Authorization: `Bearer ${adminToken}` });
  assert(releaseRes.status === 200 && releaseRes.body.results_released === true, 'Admin released results (SHOW_RESULTS).');

  // Participant Views Final Score & 80-Question Answer Review
  console.log('\n--- 7. Participant Results Retrieval ---');
  const postReleaseRes = await request('GET', '/api/results', null, {
    'x-participant-id': testId,
    'x-session-token': sessionId
  });

  assert(postReleaseRes.status === 200 && postReleaseRes.body.total_score === 60, 'Participant retrieved final score 60/80 post-release.');
  assert(postReleaseRes.body.breakdown.length === 80, 'Participant retrieved complete 80-question answer review table.');

  // Persistence Check (Simulate Browser Refresh)
  console.log('\n--- 8. Testing Session Persistence Post-Refresh ---');
  const progressRes = await request('GET', `/api/my-progress?participant_id=${testId}&session_id=${sessionId}`);
  assert(progressRes.status === 200 && progressRes.body.status === 'Submitted', 'Browser refresh retrieves saved "Submitted" status and real DB state.');

  // Export Check
  console.log('\n--- 9. Verifying Real Data CSV & Excel Export ---');
  const csvRes = await request('GET', '/api/admin/export/csv', null, { Authorization: `Bearer ${adminToken}` });
  assert(csvRes.status === 200 && csvRes.raw.includes(testId) && csvRes.raw.includes('Test Participant'), 'CSV export contains test participant real DB records.');

  console.log('===========================================================');
  console.log(`FINAL ACCEPTANCE TEST RESULT: ${passed} / ${total} ASSERTIONS PASSED`);
  console.log('===========================================================');

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runFinalAcceptanceTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
