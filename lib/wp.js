/**
 * lib/wp.js
 * ====================================
 * משיכת שאלות/קטגוריות מ-WordPress (shchiche.com) ושמירתן בזיכרון (cache).
 * ה-cache מתרענן אוטומטית כל שעה (CACHE_TTL_MS) כדי לא להכביד על השרת
 * החיצוני בכל שיחת טלפון, ולמנוע latency גבוה באמצע שיחה חיה.
 *
 * הערה: ה-cache נשמר במשתנה מודול (In-memory). ב-Vercel serverless
 * זה נשמר כל עוד ה-function "חמה" (warm) בין קריאות; ב-cold start
 * הוא מתאפס וייבנה מחדש בבקשה הראשונה.
 */

const WP_BASE = process.env.WP_BASE_URL || 'https://shchiche.com/wp-json/wp/v2';
const CACHE_TTL_MS = Number(process.env.WP_CACHE_TTL_MS || 60 * 60 * 1000); // שעה
const PER_PAGE = 100;

/** @type {{ questions: any[], categories: any[], fetchedAt: number } | null} */
let cache = null;
/** @type {Promise<void> | null} - מונע ריצות רענון כפולות במקביל */
let refreshInFlight = null;

async function fetchJsonAllPages(path) {
  const results = [];
  let page = 1;

  while (true) {
    const url = `${WP_BASE}${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });

    // וורדפרס מחזיר 400 כשעוברים את מספר העמודים הקיים - זה סימן לעצור, לא שגיאה אמיתית
    if (res.status === 400 && page > 1) break;

    if (!res.ok) {
      throw new Error(`WP fetch failed: ${url} -> ${res.status}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    results.push(...batch);

    const totalPagesHeader = res.headers.get('x-wp-totalpages');
    const totalPages = totalPagesHeader ? Number(totalPagesHeader) : null;
    if (totalPages && page >= totalPages) break;
    if (!totalPages && batch.length < PER_PAGE) break;

    page += 1;
  }

  return results;
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuestion(raw) {
  return {
    id: raw.id,
    title: stripHtml(raw.title && raw.title.rendered),
    content: stripHtml(raw.content && raw.content.rendered),
    categoryIds: Array.isArray(raw['question-category']) ? raw['question-category'] : [],
    link: raw.link || '',
  };
}

function normalizeCategory(raw) {
  return {
    id: raw.id,
    name: stripHtml(raw.name),
    count: raw.count || 0,
  };
}

async function refreshCache() {
  const [questionsRaw, categoriesRaw] = await Promise.all([
    fetchJsonAllPages('/question'),
    fetchJsonAllPages('/question-category'),
  ]);

  const questions = questionsRaw.map(normalizeQuestion);
  const categories = categoriesRaw
    .map(normalizeCategory)
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  cache = { questions, categories, fetchedAt: Date.now() };
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

async function getCategories() {
  const c = await ensureCache();
  return c.categories;
}

async function getQuestionsByCategory(categoryId) {
  const c = await ensureCache();
  return c.questions.filter((q) => q.categoryIds.includes(Number(categoryId)));
}

async function getQuestionById(questionId) {
  const c = await ensureCache();
  return c.questions.find((q) => q.id === Number(questionId)) || null;
}

async function getAllQuestions() {
  const c = await ensureCache();
  return c.questions;
}

module.exports = {
  getCategories,
  getQuestionsByCategory,
  getQuestionById,
  getAllQuestions,
  ensureCache,
};
