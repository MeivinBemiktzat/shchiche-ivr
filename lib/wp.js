/**
 * lib/wp.js
 * ====================================
 * משיכת שאלות מ-shchiche.com דרך ה-endpoint הפרטי שנמסר לטכנאי
 * (shc-reader/v1/questions, ראה הוראות_לטכנאי.md + connection.json).
 *
 * ה-endpoint הזה שונה מה-REST הכללי של וורדפרס: הוא מחזיר רק שלושה שדות
 * (id, title_raw, content_raw), התוכן "גולמי" (לא HTML מעובד - כולל
 * shortcodes/קיצורים כפי שנשמרו במקור), ואין בו קטגוריות בכלל. הפגינציה
 * שלו היא לפי after_id/next_after_id/has_more, לא page כמו ב-REST הכללי.
 *
 * לכן הקובץ הזה לא תומך בקטגוריות (וכך גם api/ivr.js) - רק חיפוש טקסטואלי
 * חופשי על כלל השאלות, ורשימת "אחרונים" (id גבוה = פורסם מאוחר יותר).
 *
 * ה-cache נשמר בזיכרון התהליך (module-level) ומתרענן אוטומטית כל שעה,
 * כדי לא להכביד על shchiche.com בכל שיחת טלפון. בהוראות לטכנאי מוזכר
 * שבשאיבה מרוכזת/אגרסיבית מדי התקבלה תשובת 418 - ולכן הרענון נעשה
 * ברצף (עמוד אחר עמוד), לא במקביל, ורק פעם בשעה כברירת מחדל.
 */

const WP_ENDPOINT =
  process.env.WP_QUESTIONS_ENDPOINT || 'https://shchiche.com/wp-json/shc-reader/v1/questions';
const WP_USERNAME = process.env.WP_READER_USERNAME;
const WP_APP_PASSWORD = process.env.WP_READER_APP_PASSWORD;
const CACHE_TTL_MS = Number(process.env.WP_CACHE_TTL_MS || 60 * 60 * 1000); // שעה
const PER_PAGE = 100; // המקסימום המותר ע"י ה-endpoint

/** @type {{ questions: any[], fetchedAt: number } | null} */
let cache = null;
/** @type {Promise<void> | null} - מונע ריצות רענון כפולות במקביל */
let refreshInFlight = null;

function authHeader() {
  if (!WP_USERNAME || !WP_APP_PASSWORD) {
    throw new Error(
      'Missing WP_READER_USERNAME / WP_READER_APP_PASSWORD environment variables (ראה connection.json)'
    );
  }
  const token = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

/** מסיר shortcodes/סימוני עיצוב גולמיים מ-content_raw/title_raw בצורה סבירה להקראה */
function cleanRawText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\[[^\]]*\]/g, ' ') // shortcodes בסגנון [note]...[/note]
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/<[^>]*>/g, ' ') // ליתר ביטחון, אם בכל זאת מוטמע HTML
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuestion(raw) {
  return {
    id: raw.id,
    title: cleanRawText(raw.title_raw),
    content: cleanRawText(raw.content_raw),
  };
}

/** שולף עמוד יחיד לפי after_id. מחזיר { questions, hasMore, nextAfterId } */
async function fetchPage(afterId) {
  const url = `${WP_ENDPOINT}?per_page=${PER_PAGE}&after_id=${afterId}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: authHeader(),
    },
  });

  if (!res.ok) {
    throw new Error(`WP questions fetch failed: ${url} -> HTTP ${res.status}`);
  }

  const data = await res.json();
  const questions = Array.isArray(data.questions) ? data.questions : [];

  return {
    questions,
    hasMore: !!data.has_more,
    nextAfterId: data.next_after_id,
  };
}

/**
 * שולף את כל השאלות, עמוד אחר עמוד (ברצף, לא במקביל - ראה הערה בראש הקובץ
 * לגבי 418 בשאיבה מרוכזת).
 */
async function fetchAllPages() {
  const results = [];
  let afterId = 0;

  while (true) {
    const { questions, hasMore, nextAfterId } = await fetchPage(afterId);
    if (!questions.length) break;

    results.push(...questions);

    if (!hasMore) break;
    if (nextAfterId === undefined || nextAfterId === null) break;
    afterId = nextAfterId;
  }

  return results;
}

async function refreshCache() {
  const questionsRaw = await fetchAllPages();
  const questions = questionsRaw.map(normalizeQuestion);
  cache = { questions, fetchedAt: Date.now() };
}

function isCacheFresh() {
  return !!cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

/**
 * מבטיח שה-cache קיים ועדכני. אם יש cache ישן, מחזיר אותו מיד ומרענן
 * ברקע (stale-while-revalidate) כדי לא להוסיף latency לשיחה חיה.
 */
async function ensureCache() {
  if (isCacheFresh()) return cache;

  if (!cache) {
    // אין שום cache - חייבים לחכות לטעינה הראשונה
    if (!refreshInFlight) {
      refreshInFlight = refreshCache().finally(() => {
        refreshInFlight = null;
      });
    }
    await refreshInFlight;
    return cache;
  }

  // יש cache ישן - נחזיר אותו מיד ונרענן ברקע
  if (!refreshInFlight) {
    refreshInFlight = refreshCache().finally(() => {
      refreshInFlight = null;
    });
  }
  return cache;
}

async function getAllQuestions() {
  const c = await ensureCache();
  return c.questions;
}

async function getQuestionById(questionId) {
  const c = await ensureCache();
  return c.questions.find((q) => q.id === Number(questionId)) || null;
}

/**
 * שאלות אחרונות. ה-endpoint לא חושף תאריך פרסום, אבל id עולה עם הזמן
 * (שאלה חדשה = id גבוה יותר), ולכן מיון לפי id יורד הוא קירוב סביר ל"אחרונות".
 */
async function getLatestQuestions(limit = 9) {
  const c = await ensureCache();
  return [...c.questions].sort((a, b) => b.id - a.id).slice(0, limit);
}

module.exports = {
  getAllQuestions,
  getQuestionById,
  getLatestQuestions,
  ensureCache,
};
