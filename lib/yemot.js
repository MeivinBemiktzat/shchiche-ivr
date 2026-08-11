/**
 * lib/yemot.js
 * ====================================
 * בונה תשובות בפרוטוקול הטקסטואלי של מודול ה-API של ימות המשיח.
 * כל תשובה מהשרת חייבת להיות טקסט פשוט (לא JSON, לא HTML) בפורמט key=value,
 * ופעולות משורשרות מופרדות ב-'&'. מקור: מודול API - ימות המשיח (f2 post 77904/78283).
 *
 * חשוב: טקסט המועבר ל-TTS (t-) אסור שיכיל '.' (מפריד בין הודעות) או '-'
 * (מפריד סוג/תוכן), אחרת ההודעה תישבר / תתפרש לא נכון. escapeTtsText דואג לכך.
 */

/** מנקה טקסט להקראת TTS: מסיר תווים שאסורים בתחביר id_list_message/read */
function escapeTtsText(text) {
  if (!text) return '';
  return String(text)
    .replace(/[.\-]/g, ' ') // '.' ו-'-' שמורים לתחביר הפרוטוקול
    .replace(/[&=]/g, ' ') // '&' מפריד פעולות, '=' מפריד חלקים
    .replace(/\s+/g, ' ')
    .trim();
}

/** בונה מקטע יחיד מסוג t- (טקסט להקראה) עבור id_list_message / read */
function ttsSegment(text) {
  return `t-${escapeTtsText(text)}`;
}

/** מחבר כמה מקטעי id_list_message לרצף הודעות (מופרד ב-'.') */
function joinSegments(segments) {
  return segments.filter(Boolean).join('.');
}

/**
 * go_to_folder=<path>
 * מעביר את המשתמש לשלוחה אחרת. path יכול להיות יחסי ('3') או מוחלט ('/3').
 */
function goToFolder(path) {
  return `go_to_folder=${path}`;
}

/**
 * id_list_message=<segments>
 * משמיע למשתמש רצף הודעות (TTS/קובץ/ספרות וכו') ומסיים את השיחה עם השרת
 * (אלא אם משורשר עם פעולה נוספת דרך '&').
 */
function idListMessage(segments, chainedAction) {
  const body = Array.isArray(segments) ? joinSegments(segments) : segments;
  const base = `id_list_message=${body}`;
  return chainedAction ? `${base}&${chainedAction}` : base;
}

/**
 * read=<הודעה>=<פרמטר>,<שימוש-חוזר>,<סוג-קלט>,...
 * מבקש קלט נוסף מהמשתמש (הקשה/הקלטה/voice) ומקריא הודעה לפני כן.
 * לא ניתן לשרשר פעולה נוספת אחרי read - אחרי קבלת הקלט, ימות שולחת
 * מיד את הנתון לשרת (לתגובת ה-api הבאה).
 *
 * @param {string|string[]} promptSegments - הודעת ה-TTS/קובץ שתישמע לפני הבקשה
 * @param {string} paramSpec - המפרט אחרי '=' השני, כגון "Digit,,5,1,7,Number,yes,no"
 */
function read(promptSegments, paramSpec) {
  const body = Array.isArray(promptSegments) ? joinSegments(promptSegments) : promptSegments;
  return `read=${body}=${paramSpec}`;
}

/**
 * read עבור הקשה (digits). paramName - שם הפרמטר שיחזור בבקשה הבאה.
 * options: { max, min, timeoutSec, playAs, allowStar, allowZero, confirmDigit }
 *
 * confirmDigit: ערך 15 בפרוטוקול ימות (בקשת אישור על ההקשה). כברירת מחדל
 * ימות מבקשת מהמשתמש לאשר כל הקשה בהודעה "לאישור הקישו אחת, להקשה מחודשת
 * הקישו שתיים" (M1353). כדי לבטל את הבקשה הזו ולעבור ישר לשלב הבא (מעבר
 * חלק) יש להעביר confirmDigit: 'no'. ברירת המחדל כאן היא 'no' כדי שכל
 * שימוש חדש ב-readDigits יהיה "חלק" אלא אם מבקשים אחרת באופן מפורש.
 */
function readDigits(promptSegments, paramName, options = {}) {
  const {
    max = '',
    min = '',
    timeoutSec = '',
    playAs = 'Number',
    allowStar = '',
    allowZero = '',
    replaceChar = '',
    allowedKeys = '',
    retries = '',
    emptyOk = '',
    emptyValue = '',
    keyboardLock = '',
    confirmDigit = 'no',
  } = options;
  // מבנה (15 ערכים): name,reuse,max,min,timeout,playAs,allowStar,allowZero,
  // replaceChar,allowedKeys,retries,emptyOk,emptyValue,keyboardLock,confirmDigit
  const spec = [
    paramName,
    '',
    max,
    min,
    timeoutSec,
    playAs,
    allowStar,
    allowZero,
    replaceChar,
    allowedKeys,
    retries,
    emptyOk,
    emptyValue,
    keyboardLock,
    confirmDigit,
  ].join(',');
  return read(promptSegments, spec);
}

/**
 * read עבור voice - הקלטה שימות עצמה מתמללת (לא בשימוש אצלנו - אנחנו
 * מתמללים בעצמנו דרך Python, ולכן נשתמש ב-readRecord).
 */
function readVoice(promptSegments, paramName, options = {}) {
  const { language = 'he-IL' } = options;
  const spec = `${paramName},,voice,${language}`;
  return read(promptSegments, spec);
}

/**
 * read עבור record - מקליט ושומר קובץ בשלוחה, ומחזיר את שם הקובץ שנשמר
 * בפרמטר paramName. options: { folder, fileName, saveOnHangup }
 */
function readRecord(promptSegments, paramName, options = {}) {
  const { folder = '', fileName = '', saveOnHangup = 'yes' } = options;
  // מבנה: name,reuse,record,folder,fileName,endOnHash(no=מיידי),saveOnHangup
  const spec = `${paramName},,record,${folder},${fileName},no,${saveOnHangup}`;
  return read(promptSegments, spec);
}

module.exports = {
  escapeTtsText,
  ttsSegment,
  joinSegments,
  goToFolder,
  idListMessage,
  read,
  readDigits,
  readVoice,
  readRecord,
};
