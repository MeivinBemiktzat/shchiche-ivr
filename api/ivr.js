/**
 * api/ivr.js
 * ====================================
 * נקודת הכניסה הראשית (api_link) של מערכת ה-IVR עבור shchiche.com.
 * מטפל בכל שלבי השיחה: תפריט ראשי, ניווט קטגוריות, חיפוש קולי, הקראת תשובה.
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
const MENU_PAGE_SIZE = 9; // מגבלת הקשה 1-9 לתפריט

// ---- הודעות קבועות ----

const MSG_WELCOME =
  'ברוכים הבאים למאגר שאלות ותשובות. להקשה לפי קטגוריה הקישו אחת. לחיפוש קולי הקישו שתיים';
const MSG_ASK_CATEGORY = 'בחרו קטגוריה מהרשימה';
const MSG_ASK_QUESTION = 'בחרו שאלה מהרשימה';
const MSG_ASK_VOICE_SEARCH = 'אמרו את נושא השאלה שאתם מחפשים לאחר הצפצוף';
const MSG_NO_CATEGORIES = 'לא נמצאו קטגוריות כרגע. נסו שוב מאוחר יותר';
const MSG_NO_QUESTIONS = 'לא נמצאו שאלות בקטגוריה זו';
const MSG_INVALID_CHOICE = 'בחירה לא תקינה. נסו שוב';
const MSG_NOT_FOUND = 'לא נמצאה תוצאה מתאימה לחיפוש שלכם. חוזרים לתפריט הראשי';
const MSG_TRANSCRIBE_FAILED = 'לא הצלחנו לזהות את הדיבור. חוזרים לתפריט הראשי';
const MSG_ERROR = 'אירעה שגיאה זמנית. נסו שוב מאוחר יותר';

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
  // שלב 4: המשתמש בחר שאלה בתוך קטגוריה -> הקראת התשובה
  if (body.QuestionChoice) {
    return handleQuestionChosen(body);
  }

  // שלב 3: המשתמש בחר קטגוריה -> הקראת רשימת שאלות
  if (body.CategoryChoice) {
    return handleCategoryChosen(body);
  }

  // שלב חיפוש קולי - ההקלטה חזרה מימות (שם הקובץ בפרמטר RECORD_PARAM)
  if (body[RECORD_PARAM]) {
    return handleVoiceSearchRecording(body);
  }

  // שלב 2: המשתמש בחר במסלול (1=קטגוריה, 2=חיפוש קולי)
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
    return categoryMenu();
  }

  if (choice === '2') {
    return voiceSearchPrompt();
  }

  return yemot.idListMessage([yemot.ttsSegment(MSG_INVALID_CHOICE)], yemot.goToFolder('/'));
}

// ---- נתיב קטגוריה: הצגת רשימת קטגוריות ----

async function categoryMenu() {
  const categories = await wp.getCategories();

  if (!categories.length) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_NO_CATEGORIES)], yemot.goToFolder('/'));
  }

  const page = categories.slice(0, MENU_PAGE_SIZE);
  const prompt = [yemot.ttsSegment(MSG_ASK_CATEGORY)];
  page.forEach((cat, idx) => {
    prompt.push(yemot.ttsSegment(`להקשה ${idx + 1}, ${cat.name}`));
  });

  return yemot.readDigits(prompt, 'CategoryChoice', {
    min: 1,
    max: 1,
    timeoutSec: 20,
    playAs: 'Digits',
    allowStar: 'yes',
  });
}

async function handleCategoryChosen(body) {
  const idx = Number(body.CategoryChoice) - 1;
  const categories = await wp.getCategories();
  const page = categories.slice(0, MENU_PAGE_SIZE);
  const category = page[idx];

  if (!category) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_INVALID_CHOICE)], yemot.goToFolder('/'));
  }

  const questions = await wp.getQuestionsByCategory(category.id);

  if (!questions.length) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_NO_QUESTIONS)], yemot.goToFolder('/'));
  }

  const page2 = questions.slice(0, MENU_PAGE_SIZE);
  const prompt = [yemot.ttsSegment(MSG_ASK_QUESTION)];
  page2.forEach((q, i) => {
    prompt.push(yemot.ttsSegment(`להקשה ${i + 1}, ${q.title}`));
  });

  // הערה: 'read' לא ניתן לשרשור עם '&' (הפרוטוקול של ימות אוסר זאת - פעולה
  // אחת בלבד מתבצעת). לכן איננו משרשרים כאן שום פעולה נוספת; זיהוי הקטגוריה
  // בשלב הבא (handleQuestionChosen) מתבסס על כך שימות שולחת שוב את כל
  // הפרמטרים שנאספו קודם בשיחה (כולל CategoryChoice) בכל בקשה עוקבת.
  return yemot.read(prompt, `QuestionChoice,,${page2.length},1,20,Digits,yes,no`);
}

async function handleQuestionChosen(body) {
  // ימות שולחת מחדש את כל הפרמטרים שנאספו קודם, כולל CategoryChoice
  const idx = Number(body.QuestionChoice) - 1;
  const categoryId = await resolveCategoryIdFromChoice(body);

  if (!categoryId) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_INVALID_CHOICE)], yemot.goToFolder('/'));
  }

  const questions = await wp.getQuestionsByCategory(categoryId);
  const page = questions.slice(0, MENU_PAGE_SIZE);
  const question = page[idx];

  if (!question) {
    return yemot.idListMessage([yemot.ttsSegment(MSG_INVALID_CHOICE)], yemot.goToFolder('/'));
  }

  return answerQuestion(question);
}

async function resolveCategoryIdFromChoice(body) {
  if (!body.CategoryChoice) return null;
  const categories = await wp.getCategories();
  const page = categories.slice(0, MENU_PAGE_SIZE);
  const category = page[Number(body.CategoryChoice) - 1];
  return category ? category.id : null;
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
  const questions = await wp.getAllQuestions();
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
