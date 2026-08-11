/**
 * lib/yemotApi.js
 * ====================================
 * קליינט ל-Management API של ימות המשיח (https://www.call2all.co.il/ym/api/<Command>).
 * בשימוש כאן רק לפקודת DownloadFile - הורדת קובץ ההקלטה שנשמר בשלוחה, כדי
 * לשלוח אותו לתמלול. פרטי החיבור מגיעים ממשתני סביבה (לא נחשפים בקוד).
 *
 * שימו לב: זהו ה-Management API (השרת שלנו קורא לימות), בניגוד למודול ה-API
 * האינטראקטיבי (type=api, ימות קוראת לשרת שלנו) שמנוהל דרך api/ivr.js.
 */

const MGMT_BASE = 'https://www.call2all.co.il/ym/api';

function getToken() {
  const system = process.env.YEMOT_SYSTEM;
  const password = process.env.YEMOT_PASSWORD;
  if (!system || !password) {
    throw new Error('YEMOT_SYSTEM / YEMOT_PASSWORD environment variables are not set');
  }
  return `${system}:${password}`;
}

/**
 * מוריד קובץ מהשלוחה דרך DownloadFile ומחזיר Buffer של הבייטים הגולמיים.
 * @param {string} path - נתיב הקובץ בפורמט ivr2, למשל 'ivr2:/9/SearchRec.wav'
 */
async function downloadFile(path) {
  const token = getToken();
  const url = `${MGMT_BASE}/DownloadFile?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`YemotApi DownloadFile failed: HTTP ${res.status}`);
  }

  // תגובת DownloadFile היא הבייטים הגולמיים של הקובץ (חריגה למבנה JSON הרגיל
  // של ה-Management API) - אך אם ימות מחזירה שגיאה, זו תהיה תשובת JSON קטנה
  // עם responseStatus=ERROR. נבדוק לפי content-type כדי להבדיל בין השניים.
  const contentType = res.headers.get('content-type') || '';
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (contentType.includes('application/json')) {
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      parsed = null;
    }
    if (parsed && parsed.responseStatus && parsed.responseStatus !== 'OK') {
      throw new Error(`YemotApi DownloadFile error: ${parsed.message || parsed.responseStatus}`);
    }
  }

  return buffer;
}

/**
 * בונה את נתיב ה-ivr2 המלא לקובץ הקלטה, מתוך תיקייה + שם קובץ שהוגדרו
 * ב-lib/yemot.js:readRecord ומהערך שחזר בפועל משדה record (record path).
 * ימות מחזירה בשדה הפרמטר את שם הקובץ (עם או בלי סיומת) שנשמר בפועל.
 */
function buildRecordingPath(folder, recordedFileValue) {
  const cleanFolder = folder.startsWith('/') ? folder : `/${folder}`;
  let fileName = recordedFileValue;
  if (!fileName) {
    throw new Error('Missing recorded file value from Yemot response');
  }
  if (!fileName.toLowerCase().endsWith('.wav')) {
    fileName = `${fileName}.wav`;
  }
  return `ivr2:${cleanFolder}/${fileName}`;
}

module.exports = {
  downloadFile,
  buildRecordingPath,
};
