const http = require('http');

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_ID = Date.now().toString().slice(-5);

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

const TEST_ANSWERS = {
  1: 'Firstcry',
  2: 'maggie',
  3: '   Booking.com   ',
  4: 'WILDCRAFT',
  5: 'Paisabazzar',
  6: 'Cadbury',
  7: 'Shadowfox',
  8: 'Microsoft',
  9: 'Lamborgini',
  10: 'Fastrack',
  11: 'Ibacco',
  12: 'Starbucks',
  13: 'Paragon',
  14: 'Subway',
  15: 'Hindustan Unilever',
  16: 'Baskin Robbins',
  17: 'Bank of America',
  18: 'Ubisoft',
  19: 'Snapdeal',
  20: 'Maxfashion',

  21: 'Warren Buffett',
  22: 'Jensen Huang',
  23: 'Michael Jordan',
  24: 'Anand Mahindra',
  25: 'Jeff Bezos',
  26: 'Bill gates',
  27: 'Sam Altman',
  28: 'Reed Hastings',
  29: 'Gautam Adani',
  30: 'Leonardo dicaprio',
  31: 'N. R. Narayana Murthy',
  32: 'Ghazal Alagh',
  33: 'Sridhar Vembu',
  34: 'Azim Premji',
  35: 'Droupadi Murmu',
  36: 'Anne Hathaway',
  37: 'Morgan Freeman',
  38: 'Pankaj Tripathi',
  39: 'Al Pacino',
  40: 'Quentin Tarantino',

  41: 'Apple',
  42: 'Starbucks',
  43: 'Volvo',
  44: 'Nintendo',
  45: 'Shell',
  46: 'Indian overseas bank',
  47: 'Huawei',
  48: 'Amazon',
  49: 'Lexus',
  50: 'Nvidia',
  51: 'Converse',
  52: 'Goldstar',
  53: 'Adhitiya birla',
  54: 'Times of india',
  55: 'Snapdragon',
  56: 'Accenture',
  57: 'Acura',
  58: 'Bing',
  59: 'Ralph Lauren',
  60: 'YouTube',

  61: "McDonald's",
  62: 'Nike',
  63: 'Apple',
  64: 'Disney',
  65: 'Coco cola',
  66: 'Adidas',
  67: 'Subway',
  68: "L'Oréal Paris",
  69: "M&M's",
  70: 'Raymond',
  71: 'Thumbs up',
  72: 'Airtel',
  73: 'BMW',
  74: 'Burger King',
  75: 'Nokia',
  76: 'Kingfisher',
  77: 'Pinterest',
  78: 'KTM',
  79: 'IMAX',
  80: 'Google'
};

async function runTestSuite() {
  console.log('===================================================');
  console.log(`BEGINNING LIVE QUIZ SYSTEM VERIFICATION TEST SUITE [RUN: ${RUN_ID}]`);
  console.log('===================================================');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`[PASS] ${message}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  // 1. Admin Login Test
  console.log('\n--- 1. Testing Admin Authentication ---');
  const adminRes = await request('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  assert(adminRes.status === 200 && adminRes.body.token, 'Admin login successful and returned authorization token.');
  const adminToken = adminRes.body.token;

  // 2. Start Quiz Action & Lock Reset
  console.log('\n--- 2. Testing Admin Start Quiz Control ---');
  await request('POST', '/api/admin/quiz-control', { action: 'HIDE_RESULTS' }, { Authorization: `Bearer ${adminToken}` });
  const startRes = await request('POST', '/api/admin/quiz-control', { action: 'START' }, { Authorization: `Bearer ${adminToken}` });
  assert(startRes.status === 200 && startRes.body.status === 'IN_PROGRESS', 'Admin started quiz. Quiz status is IN_PROGRESS.');

  // 3. Security Assertions (Answer Key Confidentiality)
  console.log('\n--- 3. Testing Answer Key Security & Confidentiality ---');
  const secId = `SEC_${RUN_ID}`;
  const regSecTest = await request('POST', '/api/register', { name: 'Security Check', participant_id: secId });
  assert(regSecTest.status === 200, 'Registration succeeded for fresh security check ID.');
  const secToken = regSecTest.body.session_token;

  assert(!('accepted_answers' in regSecTest.body), 'Registration response does NOT expose answer key.');
  assert(!('answers' in regSecTest.body), 'Registration response does NOT expose answers.');

  const saveSecTest = await request('POST', '/api/save-answer', {
    participant_id: secId,
    session_token: secToken,
    question_number: 1,
    submitted_answer: 'Firstcry'
  });

  assert(saveSecTest.status === 200, 'Answer save returned HTTP 200 OK.');
  assert(!('is_correct' in saveSecTest.body), 'Save answer endpoint does NOT leak is_correct evaluation.');
  assert(!('marks' in saveSecTest.body), 'Save answer endpoint does NOT leak earned marks.');
  assert(!('correct_answer' in saveSecTest.body), 'Save answer endpoint does NOT leak correct answer string.');

  const progressSecTest = await request('GET', `/api/my-progress?participant_id=${secId}&session_token=${secToken}`);
  assert(!('marks' in progressSecTest.body), 'My progress endpoint does NOT leak marks.');
  assert(!('scores' in progressSecTest.body), 'My progress endpoint does NOT leak scores.');

  const resultsPreReleaseTest = await request('GET', '/api/results', null, {
    'x-participant-id': secId,
    'x-session-token': secToken
  });
  console.log(`DEBUG resultsPreReleaseTest status: ${resultsPreReleaseTest.status}, body:`, resultsPreReleaseTest.body);
  assert(resultsPreReleaseTest.status === 403, 'Participant results endpoint returns 403 Forbidden before admin releases results.');

  // 4. Q52 Multi-Answer Verification (Goldstar vs LG)
  console.log('\n--- 4. Testing Q52 Dual-Accepted Answer Logic (Goldstar OR LG) ---');
  
  const idGold = `P_GOLD_${RUN_ID}`;
  const idLG = `P_LG_${RUN_ID}`;

  const partA = await request('POST', '/api/register', { name: 'Goldstar User', participant_id: idGold });
  const partB = await request('POST', '/api/register', { name: 'LG User', participant_id: idLG });

  await request('POST', '/api/save-answer', {
    participant_id: partA.body.participant_id,
    session_token: partA.body.session_token,
    question_number: 52,
    submitted_answer: 'Goldstar'
  });

  await request('POST', '/api/save-answer', {
    participant_id: partB.body.participant_id,
    session_token: partB.body.session_token,
    question_number: 52,
    submitted_answer: 'LG'
  });

  const inspectA = await request('GET', `/api/admin/participant/${idGold}`, null, { Authorization: `Bearer ${adminToken}` });
  const inspectB = await request('GET', `/api/admin/participant/${idLG}`, null, { Authorization: `Bearer ${adminToken}` });

  const q52_A = inspectA.body.breakdown.find(q => q.question_number === 52);
  const q52_B = inspectB.body.breakdown.find(q => q.question_number === 52);

  assert(q52_A.marks === 1, 'Q52 answer "Goldstar" received 1 mark.');
  assert(q52_B.marks === 1, 'Q52 answer "LG" received 1 mark.');

  // 5. Concurrent Participants Load Test (100 simultaneous participants)
  console.log('\n--- 5. Testing 100 Simultaneous Participants Load & Answer Evaluation ---');

  const TARGET_PARTICIPANTS = 100;
  const participantSessions = [];

  console.log(`Registering ${TARGET_PARTICIPANTS} simultaneous participants...`);
  const regStartTime = Date.now();

  const regPromises = [];
  for (let i = 1; i <= TARGET_PARTICIPANTS; i++) {
    const pId = `P_${RUN_ID}_${String(i).padStart(3, '0')}`;
    const pName = `Participant ${i}`;
    regPromises.push(request('POST', '/api/register', { name: pName, participant_id: pId }));
  }

  const regResults = await Promise.all(regPromises);
  const regDuration = Date.now() - regStartTime;

  assert(regResults.every(r => r.status === 200), `All ${TARGET_PARTICIPANTS} participants registered successfully in ${regDuration}ms.`);

  for (const r of regResults) {
    participantSessions.push(r.body);
  }

  console.log(`Submitting answers via batch-sync for all ${TARGET_PARTICIPANTS} participants concurrently...`);
  const saveStartTime = Date.now();

  const batchSyncPromises = [];

  for (let i = 0; i < participantSessions.length; i++) {
    const p = participantSessions[i];
    const pIndex = i + 1;

    const pAnswers = [];
    for (let q = 1; q <= 80; q++) {
      let ans = '';
      if (pIndex <= 50) {
        ans = TEST_ANSWERS[q] || 'Firstcry';
        if (q === 52) ans = (pIndex % 2 === 0) ? 'LG' : 'Goldstar';
      } else if (pIndex <= 80) {
        ans = (q <= 40) ? TEST_ANSWERS[q] : 'Wrong Answer';
      } else {
        ans = (q <= 20) ? TEST_ANSWERS[q] : (q <= 40 ? '' : 'Incorrect');
      }
      pAnswers.push({ question_number: q, submitted_answer: ans });
    }

    batchSyncPromises.push(
      request('POST', '/api/batch-sync', {
        participant_id: p.participant_id,
        session_token: p.session_token,
        answers: pAnswers
      })
    );
  }

  const batchResults = await Promise.all(batchSyncPromises);
  const saveDuration = Date.now() - saveStartTime;

  assert(batchResults.every(r => r.status === 200), `Successfully processed 8,000 real-time answer evaluations across 100 participants in ${saveDuration}ms.`);

  // Final Submit for all participants
  console.log('Submitting final answers for all participants...');
  const submitPromises = participantSessions.map(p =>
    request('POST', '/api/submit-quiz', {
      participant_id: p.participant_id,
      session_token: p.session_token
    })
  );

  const submitResults = await Promise.all(submitPromises);
  assert(submitResults.every(r => r.status === 200), 'All 100 participants submitted final quiz successfully.');

  // 6. Verification of Score Calculations
  console.log('\n--- 6. Verifying Scores & Evaluation Accuracy ---');
  const p1Id = participantSessions[0].participant_id;
  const p60Id = participantSessions[59].participant_id;
  const p90Id = participantSessions[89].participant_id;

  const checkP1 = await request('GET', `/api/admin/participant/${p1Id}`, null, { Authorization: `Bearer ${adminToken}` });
  const checkP60 = await request('GET', `/api/admin/participant/${p60Id}`, null, { Authorization: `Bearer ${adminToken}` });
  const checkP90 = await request('GET', `/api/admin/participant/${p90Id}`, null, { Authorization: `Bearer ${adminToken}` });

  assert(checkP1.body.participant.total_score === 80, `Participant P1 (100% correct) achieved 80/80 total score.`);
  assert(checkP60.body.participant.total_score === 40, `Participant P60 (50% correct) achieved 40/80 total score.`);
  assert(checkP90.body.participant.total_score === 20, `Participant P90 (25% correct) achieved 20/80 total score.`);

  // 7. Manual Score Override
  console.log('\n--- 7. Testing Admin Manual Score Override ---');
  const overrideRes = await request('POST', '/api/admin/override-score', {
    participant_id: p90Id,
    question_number: 21,
    new_marks: 1,
    reason: 'Dispute resolved by quiz organizer'
  }, { Authorization: `Bearer ${adminToken}` });

  assert(overrideRes.status === 200 && overrideRes.body.new_total_score === 21, `Admin score override applied successfully. ${p90Id} score updated to 21.`);

  // 8. Result Release & Participant Result Viewing
  console.log('\n--- 8. Testing Admin Result Release & Participant Result Fetching ---');
  const releaseRes = await request('POST', '/api/admin/quiz-control', { action: 'SHOW_RESULTS' }, { Authorization: `Bearer ${adminToken}` });
  assert(releaseRes.status === 200 && releaseRes.body.results_released === true, 'Admin released results (SHOW_RESULTS).');

  const p1Results = await request('GET', '/api/results', null, {
    'x-participant-id': p1Id,
    'x-session-token': participantSessions[0].session_token
  });
  assert(p1Results.status === 200 && p1Results.body.total_score === 80 && p1Results.body.breakdown.length === 80, 'Participant P1 successfully retrieved final score (80/80) and complete 80-question breakdown.');

  // 9. CSV & Excel Export Verification
  console.log('\n--- 9. Testing Result Exports (CSV & Excel) ---');
  const csvRes = await request('GET', '/api/admin/export/csv', null, { Authorization: `Bearer ${adminToken}` });
  assert(csvRes.status === 200 && csvRes.headers['content-type'].includes('text/csv'), 'CSV Export generated successfully with text/csv content type.');
  assert(csvRes.raw.includes('Rank,Participant Name,Participant ID') && csvRes.raw.includes(p1Id), 'CSV file contains participant names, IDs, ranks, and answers.');

  const excelRes = await request('GET', '/api/admin/export/excel', null, { Authorization: `Bearer ${adminToken}` });
  assert(excelRes.status === 200 && excelRes.headers['content-type'].includes('application/vnd.ms-excel'), 'Excel Export generated successfully with excel content type.');

  console.log('===================================================');
  console.log(`VERIFICATION SUMMARY: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('===================================================');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test execution error:', err);
  process.exit(1);
});
