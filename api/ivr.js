/**
 * api/ivr.js
 * ====================================
 * נקודת הכניסה הראשית (api_link) של מערכת ה-IVR עבור shchiche.com.
 *
 * לאחר המעבר ל-endpoint הפרטי (shc-reader/v1/questions, ראה lib/wp.js)
 * אין יותר קטגוריות זמינות מהמקור, ולכן הזרימה פושטה לשני מסלולים בלבד:
 *   1. חיפוש קולי - המשתמש מדבר, ההקלטה מתומללת (api/transcribe.py),
 *      והתמלול מושווה כטקסט חופשי מול title/content של כל השאלות.
 *   2. שאלות אחרונות - הקראת רשימת השאלות האחרונות שנוספו לאתר (לפי id
 *      יורד, ראה הערה ב-lib/wp.js), ובחירה בהקשה לשמיעת אחת מהן.
 *
 * הפרוטוקול: ימות שולחת לכתובת הזו POST עם כל הפרמטרים שנאספו עד כה בשיחה
 * (req.body), ומצפה לתשובת טקסט פשוט (לא JSON) בפורמט key=value שבונה
 * lib/yemot.js. אנחנו מבחינים בין שלבי השיחה לפי אילו פרמטרים כבר קיימים
 * ב-body (ApiExtension + מה שנאסף עד כה ב-read).
 */

const wp = require('../lib/wp');
const yemot = require('../lib/yemot');
const yemotApi = require('../lib/yemotApi');

const RECORD_FOLDER = process.env.RECORD_FOLDER || '/9';
const RECORD_PARAM = 'SearchRec';
const RECORD_MAX_SECONDS = Number(process.env.RECORD_MAX_SECONDS || 20);
const TRANSCRIBE_URL = process.env.TRANSCRIBE_URL;
const LATEST_PAGE_SIZE = 9; // מגבלת הקשה 1-9 לתפריט

// גג זמן פנימי לכל פעולה שתלויה ב-WordPress (רשת חיצונית). מוגדר קצר בהרבה
// ממגבלת ה-maxDuration של Vercel (30 שניות, ראה vercel.json), כדי שאם WP
// איטי/לא מגיב, המשתמש יקבל הודעת שגיאה מדוברת מהר, במקום שהשיחה תישאר
// שקטה עד שVercel עצמה תפיל את הפונקציה בכוח (מה שגרם לחזרה לתפריט הראשי
// בלי הודעת שגיאה כלל).
const WP_TIMEOUT_MS = Number(process.env.WP_TIMEOUT_MS || 8000);

/** מריץ promise עם גג זמן; אם חלף הזמן - נזרקת שגיאה במקום להמתין לנצח */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

// ---- הודעות קבועות ----

const MSG_WELCOME =
  'ברוכים הבאים למאגר שאלות ותשובות. לחיפוש קולי הקישו אחת. לשמיעת השאלות האחרונות שנוספו לאתר הקישו שתיים';
const MSG_ASK_VOICE_SEARCH = 'אמרו את נושא השאלה שאתם מחפשים לאחר הצפצוף';
const MSG_ASK_LATEST_CHOICE = 'להקשה, בחרו שאלה מהרשימה';
const MSG_NO_LATEST = 'לא נמצאו שאלות כרגע. נסו שוב מאוחר יותר';
const MSG_INVALID_CHOICE = 'בחירה לא תקינה. נסו שוב';
const MSG_NOT_FOUND = 'לא נמצאה תוצאה מתאימה לחיפוש שלכם. חוזרים לתפריט הראשי';
const MSG_TRANSCRIBE_FAILED = 'לא הצלחנו לזהות את הדיבור. חוזרים לתפריט הראשי';
const MSG_ERROR = 'אירעה שגיאה זמנית. נסו שוב מאוחר יותר';
const MSG_WP_TIMEOUT = 'הטעינה התארכה מהצפוי. נסו שוב בעוד רגע';

module.exports = async (req, res) => {
  try {
    const body = req.method === 'POST' ? req.body || {} : req.query || {};
    const response = await handleStep(body);
    sendText(res, response);
  } catch (err) {
    console.error('IVR error:', err);
    sendText(res, yemot.idListMessage([yemot.ttsSegment(MSG_ERROR)], yemot.goToFolder('/')));
  }
};

function sendText(res, text) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send(text);
}

/**
 * מנתב את הבקשה לשלב הנכון בזרימה, לפי הפרמטרים שכבר קיימים ב-body.
 * סדר הבדיקה חשוב: מהשלב "העמוק" ביותר לשלב הרדוד ביותר, כי כל שלב
 * מוסיף פרמטר חדש לבקשה הבאה.
 */
async function handleStep(body) {
  // שלב 3א: המשתמש בחר שאלה מתוך רשימת "אחרונים" -> הקראת התשובה
  if (body.LatestChoice) {
    return handleLatestChosen(body);
  }

  // שלב חיפוש קולי - ההקלטה חזרה מימות (שם הקובץ בפרמטר RECORD_PARAM)
  if (body[RECORD_PARAM]) {
    return handleVoiceSearchRecording(body);
  }

  // שלב 2: המשתמש בחר במסלול (1=חיפוש קולי, 2=אחרונים)
  if (body.MainChoice) {
    return handleMainChoice(body);
  }

  // שלב 1: כניסה ראשונית לשלוחה -> תפריט ראשי
  return mainMenu();
}

// ---- שלב 1: תפריט ראשי ----

function mainMenu() {
  return yemot.readDigits([yemot.ttsSegment(MSG_WELCOME)], 'MainChoice', {
    min: 1,
    max: 1,
    timeoutSec: 15,
    playAs: 'Digits',
    allowStar: 'yes',
  });
}

// ---- שלב 2: בחירת מסלול ----

async function handleMainChoice(body) {
  const choice = String(body.MainChoice || '').trim();

  if (choice === '1') {
    return voiceSearchPrompt();
  }

  if (choice === '2') {
    return latestMenu();
  }

  return yemot.idListMessage([yemot.ttsSegment(MSG_INVALID_CHOICE)], yemot.goToFolder('/'));
}

// ---- נתיב "אחרונים": הצגת רשימת השאלות האחרונות ----

async function latestMenu() {
  let latest;
  try {
    latest = await withTimeout(
      wp.getLatestQuestions(LATEST_PAGE_SIZE),
      WP_TIMEOUT_MS,
      'wp.getLatestQuestions'
    );
  } catch (err) {
    console.error('latestMenu timeout/error:', err);
    return yemot.idListMessage([yemot.ttsSegment(MSG_WP_TIMEOUT)], yemot.goToFolder('/'));
  }

  if (!latest.length) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_NO_LATEST)], yemot.goToFolder('/'));
  }

  const prompt = [yemot.ttsSegment(MSG_ASK_LATEST_CHOICE)];
  latest.forEach((q, idx) => {
    prompt.push(yemot.ttsSegment(`להקשה ${idx + 1}, ${q.title}`));
  });

  // משתמשים ב-readDigits (ולא ב-read הגולמי) כדי ש-confirmDigit יוגדר
  // תמיד ל-'no' - אחרת ימות מבקשת מהמשתמש לאשר את ההקשה בנפרד לפני
  // שממשיכה, מה שגרם למעבר לא-חלק בין הקשה לתשובה.
  return yemot.readDigits(prompt, 'LatestChoice', {
    min: 1,
    max: latest.length,
    timeoutSec: 20,
    playAs: 'Digits',
    allowStar: 'yes',
  });
}

async function handleLatestChosen(body) {
  const idx = Number(body.LatestChoice) - 1;
  let latest;
  try {
    latest = await withTimeout(
      wp.getLatestQuestions(LATEST_PAGE_SIZE),
      WP_TIMEOUT_MS,
      'wp.getLatestQuestions'
    );
  } catch (err) {
    console.error('handleLatestChosen timeout/error:', err);
    return yemot.idListMessage([yemot.ttsSegment(MSG_WP_TIMEOUT)], yemot.goToFolder('/'));
  }

  const question = latest[idx];

  if (!question) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_INVALID_CHOICE)], yemot.goToFolder('/'));
  }

  return answerQuestion(question);
}

function answerQuestion(question) {
  const segments = [
    yemot.ttsSegment(question.title),
    yemot.ttsSegment(question.content || 'אין תוכן זמין לשאלה זו'),
  ];
  return yemot.idListMessage(segments, yemot.goToFolder('/'));
}

// ---- נתיב חיפוש קולי ----

function voiceSearchPrompt() {
  return yemot.readRecord([yemot.ttsSegment(MSG_ASK_VOICE_SEARCH)], RECORD_PARAM, {
    folder: RECORD_FOLDER,
    fileName: RECORD_PARAM,
    saveOnHangup: 'no',
  });
}

async function handleVoiceSearchRecording(body) {
  if (!TRANSCRIBE_URL) {
    throw new Error('TRANSCRIBE_URL environment variable is not set');
  }

  const recordedValue = body[RECORD_PARAM];
  const recordingPath = yemotApi.buildRecordingPath(RECORD_FOLDER, recordedValue);
  const wavBytes = await yemotApi.downloadFile(recordingPath);

  const transcribed = await transcribeAudio(wavBytes);

  if (!transcribed) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_TRANSCRIBE_FAILED)], yemot.goToFolder('/'));
  }

  const match = await findBestMatch(transcribed);

  if (!match) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_NOT_FOUND)], yemot.goToFolder('/'));
  }

  return answerQuestion(match);
}

async function transcribeAudio(wavBytes) {
  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: wavBytes,
  });

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson.error || '';
    } catch {
      // ignore
    }
    throw new Error(`Transcribe endpoint failed: HTTP ${res.status} ${detail}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

/**
 * חיפוש fuzzy פשוט: מנקד כל שאלה לפי כמות המילים המשותפות בין השאילתה
 * לכותרת/תוכן, ומחזיר את הניקוד הגבוה ביותר (אם הוא מעל סף מינימלי).
 */
async function findBestMatch(query) {
  const questions = await withTimeout(wp.getAllQuestions(), WP_TIMEOUT_MS, 'wp.getAllQuestions');
  const queryWords = normalizeWords(query);

  if (!queryWords.length) return null;

  let best = null;
  let bestScore = 0;

  for (const q of questions) {
    const titleWords = normalizeWords(q.title);
    const contentWords = normalizeWords(q.content).slice(0, 60); // תוכן ארוך - מגבילים לביצועים

    const titleOverlap = countOverlap(queryWords, titleWords) * 2; // כותרת חשובה יותר
    const contentOverlap = countOverlap(queryWords, contentWords);
    const score = titleOverlap + contentOverlap;

    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }

  return bestScore > 0 ? best : null;
}

function normalizeWords(text) {
  if (!text) return [];
  return String(text)
    .replace(/[^\u05D0-\u05EA\s]/g, ' ') // רק אותיות עבריות
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function countOverlap(wordsA, wordsB) {
  const setB = new Set(wordsB);
  let count = 0;
  for (const w of wordsA) {
    if (setB.has(w)) count += 1;
  }
  return count;
}
