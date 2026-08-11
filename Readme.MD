# מערכת IVR עבור shchiche.com (ימות המשיח + Vercel)

## מבנה הפרויקט (4 קבצי קוד עיקריים)

1. `api/ivr.js` — נקודת הכניסה הראשית (`api_link`). מנהלת את כל שלבי השיחה.
2. `lib/wp.js` — משיכת קטגוריות/שאלות מ-WordPress + קאש בזיכרון (מתרענן כל שעה).
3. `lib/yemot.js` — בניית תשובות בפרוטוקול הטקסטואלי של ימות (`read=`, `id_list_message=` וכו').
4. `api/transcribe.py` — פונקציית Python נפרדת שמתמללת הקלטות עם `SpeechRecognition` מול Google.

קובץ עזר נוסף: `lib/yemotApi.js` — קליינט ל-Management API של ימות (הורדת קבצי הקלטה).

## פריסה (Deploy) ל-Vercel דרך GitHub

1. דחפו את התיקייה הזו לריפו ב-GitHub.
2. ב-Vercel: New Project → Import מה-GitHub repo.
3. Vercel מזהה אוטומטית גם את `api/ivr.js` (Node) וגם את `api/transcribe.py` (Python) כ-Serverless Functions נפרדות.
4. הגדירו את משתני הסביבה (Environment Variables) בהגדרות הפרויקט ב-Vercel:

| משתנה | תיאור |
|---|---|
| `YEMOT_SYSTEM` | מספר המערכת שלכם בימות |
| `YEMOT_USERNAME` | שם המשתמש לניהול (Management API) |
| `YEMOT_PASSWORD` | הסיסמה (שמרו בסוד, אל תחשפו בקוד) |
| `TRANSCRIBE_URL` | כתובת מלאה לפונקציית התמלול, לדוגמה `https://your-project.vercel.app/api/transcribe` |

5. אחרי הפריסה תקבלו כתובת כמו: `https://your-project.vercel.app/api/ivr`

## הגדרת השלוחה בימות המשיח

בקובץ `ext.ini` של השלוחה הרלוונטית:

```ini
type=api
api_link=https://your-project.vercel.app/api/ivr
api_url_post=yes
api_wait_answer_music_on_hold=yes
```

`api_wait_answer_music_on_hold=yes` חשוב במיוחד עבור חיפוש קולי — כי הורדת ההקלטה + התמלול מול גוגל לוקחים כמה שניות, וזה מונע שקט מוזר בשיחה.

### חשוב לגבי ההקלטה (חיפוש קולי)

בקוד (`api/ivr.js`) מוגדר ש-Yemot תשמור את ההקלטה בתיקייה `/9` בשלוחה עם שם קובץ `SearchRec`, עד 20 שניות. ודאו שתיקייה `9` קיימת תחת השלוחה, או שנו את הנתיב לפי הצורך.

## איך זה עובד (זרימה)

1. כניסה → תפריט: הקישו 1 לניווט קטגוריות, 2 לחיפוש קולי.
2. **נתיב קטגוריה**: הקראת קטגוריות → בחירה → הקראת שאלות בקטגוריה → בחירה → הקראת התשובה המלאה (TTS).
3. **נתיב חיפוש קולי**: הקלטה → הורדת הקובץ מימות → שליחה ל-`api/transcribe.py` → תמלול מול Google → חיפוש בקאש המקומי → הקראת התוצאה המתאימה ביותר (או רשימה לבחירה אם יש כמה).

## מגבלות ידועות שכדאי לדעת

- **Google Web Speech API (ללא מפתח)**: זהו שירות לא רשמי בחינם עם הגבלת קצב שימוש. לעומס גבוה (הרבה שיחות בו-זמנית) מומלץ לעבור בעתיד ל-Google Cloud Speech-to-Text עם מפתח API בתשלום.
- **תפריטים מוגבלים ל-9 פריטים** (הקשה 1-9) — אם יש יותר שאלות/קטגוריות, כדאי בהמשך להוסיף "עמוד הבא" (הקשה 0).
- **קאש בזיכרון**: מתאפס בכל "cold start" של הפונקציה. אם רוצים קאש עמיד יותר בין קריאות, אפשר להוסיף Vercel KV או Redis בהמשך.
