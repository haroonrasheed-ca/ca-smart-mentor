# CA Smart Mentor

Articleship ke baad thake hue dimaag ke liye banaya gaya study mentor. Yeh timer app nahi hai aur guilt-trip karne wala tracker bhi nahi. Yeh ek **GPS** ki tarah kaam karta hai: aap din miss karein to "time debt" jama nahi karta, balki baaki syllabus ko baaki dinon par dobara bant deta hai.

- **Frontend:** plain HTML/CSS/JS (koi build step nahi) → **GitHub Pages** par host hota hai
- **Backend:** aapki apni **Google Sheet** + Google Apps Script (free)
- **Phone par install:** PWA hai, "Add to Home screen" karein aur app ki tarah chalegi, offline bhi

---

## 1. Kya kya milta hai

| Feature | Kahan milega |
|---|---|
| **GPS Recalculation**: har raat baaki effort ÷ baaki study days, dobara hisaab | Pace tab + Morning card |
| **Feasibility cap**: agar required pace aapki demonstrated capacity ka 1.4 guna se zyada ho to app chup-chap impossible number nahi dikhata, 4 routes deta hai (Balanced / Light / Triage / Restructure) | "Choose a route" |
| **Low Battery**: 🟢 Full / 🟡 Half / 🔴 Empty (Empty ka rang red nahi, calm blue hai). Empty = 30-minute maintenance, streak zinda | Evening tab |
| **Audit Bankruptcy**: purana plan archive, streak 0 (best streak safe), asli capacity se naya plan | Today ke neeche link + Settings |
| **Tunnel Vision**: poora dashboard chhup jata hai, sirf ek micro-task ("Solve 1 question on …") | Auto: Empty battery, raat 8 ke baad bina session ke, ya 3+ din ki gap |
| **Frictionless START**: ek bada button, koi form nahi. Session ke baad 10 second ka log | Evening tab |
| **Trajectory graph**: Ideal vs Actual vs Forecast (±30% band) | Pace tab |
| **Landing Pad**: office ke baad 20 minute ka *jaaiz* rest, hard end ke saath | Evening tab |
| **If-Then + treat**: aapka apna sentence, aur sirf study ke waqt wala reward | Settings → Habit |
| **Never-miss-twice + Shields**: pehla miss free, doosre miss par shield, har 5 din par 1 shield milti hai | Top bar |
| **Study Capital**: total minutes jo kabhi kam nahi hote | Night tab |
| **Estimate multiplier**: app seekhta hai ke aap estimate se kitna slow/fast hain | Pace tab |
| **Optional email nudges**: din mein maximum 2, sirf agar aapne study nahi ki | Code.gs |

---

## 2. Folder structure

```
ca-smart-mentor/
├── index.html              ← app ka shell
├── manifest.webmanifest    ← phone par install ke liye
├── sw.js                   ← offline support (service worker)
├── .nojekyll               ← GitHub Pages ke liye
├── css/styles.css          ← poora design (dark + light theme)
├── js/
│   ├── app.js              ← DOM wiring, clicks, timer
│   ├── engine.js           ← GPS, streak, routes, forecast, micro-tasks (pure functions)
│   ├── mentor.js           ← mentor ki awaaz (Observation → Normalisation → One action)
│   ├── actions.js          ← jo bhi aap karte hain (start, log, bankruptcy …)
│   ├── store.js            ← local-first data store
│   ├── sync.js             ← Google Sheet sync
│   ├── views.js            ← screens (Today / Pace / Topics / Settings)
│   ├── sheets.js           ← popups (log, route, bankruptcy, topic …)
│   ├── chart.js            ← Pace graph (SVG)
│   ├── utils.js
│   └── sample.js           ← sample syllabus (apna replace karein)
├── icons/                  ← app icons
├── apps-script/
│   ├── Code.gs             ← Google Sheet backend (isay Apps Script mein paste karna hai)
│   └── appsscript.json     ← time zone Asia/Karachi + web app settings
└── tests/                  ← 30 automated tests (optional, neeche dekhein)
```

---

## 3. Setup, 4 steps (taqreeban 20 minute)

### Step 1: Google Sheet + backend

1. [sheets.google.com](https://sheets.google.com) par naya blank sheet banayein, naam rakhein **CA Smart Mentor DB**.
2. Menu: **Extensions → Apps Script**. Naya editor khulega.
3. Editor mein jo purana code hai usay delete karein aur `apps-script/Code.gs` ki **poori file** paste karein.
4. File ke upar yeh line dhoondhein aur apna **lamba random token** likhein (kam az kam 20 characters, yaad rakhein ya copy kar lein):
   ```js
   const API_TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
   ```
   Misal: `ca-mentor-7Hq29xLpZ4vN8wTd` (yeh misal use na karein, apna banayein).
5. **Time zone set karein:** left side ⚙️ **Project Settings** → "Show appsscript.json manifest file in editor" tick karein → wapas Editor mein `appsscript.json` kholein → uska content `apps-script/appsscript.json` se replace karein → save.
6. Upar function dropdown se **`setup`** select karein → **▶ Run**. Pehli baar Google permission maangega ("Advanced → Go to project (unsafe) → Allow"). Yeh aapka apna script hai, isliye theek hai. Sheet mein saare tabs aur ek **Dashboard** ban jayega.
7. **Deploy → New deployment** → ⚙️ type **Web app**:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - **Deploy** dabayein, aur jo **Web app URL** aaye (`https://script.google.com/macros/s/…/exec`) usay copy karein.

> "Anyone" isliye zaroori hai ke aapka browser Google login ke baghair is URL ko call karta hai. Aapka data **token** se protected hai: sahi token ke baghair script sirf `unauthorized` jawab deta hai.

> **Code.gs mein kabhi bhi kuch badlein** to: Deploy → **Manage deployments** → ✏️ edit → Version: **New version** → Deploy. Warna purana code chalta rahega.

### Step 2: GitHub par upload

1. [github.com/new](https://github.com/new) par repository banayein, misal `ca-smart-mentor` (Public theek hai, kyunke token repo mein nahi hota).
2. Is folder ki **saari files** upload karein (Add file → Upload files). `index.html` repo ke **root** mein honi chahiye, kisi sub-folder mein nahi.
3. **Settings → Pages → Build and deployment:** Source = *Deploy from a branch*, Branch = **main**, Folder = **/ (root)** → Save.
4. 1–2 minute baad aapka link: `https://<aapka-username>.github.io/ca-smart-mentor/`

> Apna Web App URL ya token kabhi GitHub par commit **na** karein. App unhein sirf aapke phone/browser ke Settings mein rakhti hai.

### Step 3: App ko Sheet se jodein

1. Apna GitHub Pages link kholein. Pehli baar onboarding aayegi: exam date, roz ke realistic minutes, rest day, aur apna if-then sentence.
2. **Settings → Google Sheet sync:** Web App URL aur Token paste karein → **Save & test connection**.
3. Hari dot (top-right) ka matlab synced. Ab har session aapki Sheet mein save hoga.

### Step 4: Phone par install

- **Android Chrome:** ⋮ menu → *Install app* / *Add to Home screen*
- **iPhone Safari:** Share → *Add to Home Screen*

Ab yeh aapki home screen par ek app hai, aur wahan ek **"Start now"** shortcut bhi hai (Android par icon ko long-press karein).

---

## 4. Apna syllabus lagana

App sample topics ke saath aati hai taake aap pehle din se istemal kar sakein, lekin **apne papers ke topics** daalein:

- **Topics tab → Import**: CSV paste karein. Columns:

  ```
  subject, chapter, name, estMin, weightage, difficulty
  FAR,Leases,IFRS 16 Leases,210,8,4
  ```
  - `estMin` = aapka andaza ke pehli baar parhne mein kitne minute lagenge
  - `weightage` = paper mein marks ka taqreeban %
  - `difficulty` = 1 se 5
- Ya **Add topic** se ek ek karke.
- Sample topics ko Topics tab mein topic kholkar **Delete** kar sakte hain.

Estimate galat ho to ghabrayein nahi: jaise jaise aap topics khatam karte hain, app aapka asli speed seekh kar agle topics ka estimate khud theek kar leti hai (Pace tab → *Estimate multiplier*).

---

## 5. Roz ka istemal

| Waqt | Kya karein |
|---|---|
| **Subah** (30 second) | Route card parhein. Office ka din Normal / Heavy / Off tap karein. Chahein to 15 minute ka "Morning spark". |
| **Office ke baad** | Pehle **Landing Pad**: 20 minute rest. Phir battery tap karein (ya na karein) aur bada **START** dabayein. Bas. |
| **Session ke baad** | "Done" → 10 second ka log (sab kuch pehle se bhara hota hai) → save. |
| **Raat** (5 minute) | Aaj ka scorecard, kal kaisa din lagta hai, kal ka pehla chhota step likhein. Sone se pehle graph na dekhein. |
| **Weekend** | Pace tab: graph, hafte ka summary, kamzor topics. Zaroorat ho to route badlein. |

**Thaka hua din?** Battery 🔴 Empty tap karein. Target 30 minute ho jata hai, sirf halka kaam (revision, MCQs) milta hai, aur 15 minute bhi streak zinda rakhte hain.

**Sab kuch bahut zyada lag raha hai?** Today ya Settings mein **Audit Bankruptcy**. Purana plan archive hota hai (delete nahi), streak 0 hoti hai, aapka best streak aur total study time safe rehta hai.

---

## 6. Optional: halke email nudges

Agar chahte hain ke din mein 2 baar tak (7 baje aur 9 baje) ek naram email aaye, sirf tab jab aapne us din study na ki ho:

1. Apps Script editor mein function **`installTriggers`** select karke **Run** karein.
2. Settings mein "Allow up to two soft email nudges" tick rehne dein.
3. Waqt badalna ho to `Code.gs` mein `NUDGE_HOURS = [19, 21]` badlein (aur dobara deploy karein).
4. Band karne ke liye `removeTriggers` run karein.

Email aapke apne Google account par jati hai. Jis din aap "Off" mark karein us din koi nudge nahi aati.

---

## 7. Data kahan hai, aur safety

- Aapka data pehle **aapke phone ke browser** mein rehta hai (offline bhi chalta hai) aur phir Sheet mein mirror hota hai.
- Do devices par chalayein to **last write wins** (har row ka `updatedAt`). Ek waqt mein ek device istemal karna sab se behtar hai.
- **Backup:** Settings → *Download backup* (JSON). *Restore backup* se wapas.
- Sheet ke tabs: `sessions`, `topics`, `days`, `plans`, `events`, `meta`. Aap in par apne charts/formulas bana sakte hain. **Header row ko na chhedein.** Rows delete karne ke bajaye app mein delete karein (soft delete hota hai).
- Web App URL aur token sirf **usi device** ke browser mein hote hain, sync hone wale data mein nahi.

---

## 8. Jaanchne / badalne ke liye

**Local mein chalana** (file:// se nahi chalega, server chahiye):

```bash
python3 -m http.server 8080
# phir browser mein http://localhost:8080
```

**Tests chalana** (Node 20+):

```bash
npm test
```

30 tests: GPS maths, streak rules, routes/triage, micro-tasks, har screen ka render, aur **asli Code.gs ek nakli Google backend par** (push/pull/upsert/token/nudges). Isme ek poora "device A push karta hai, naya device B pull karke sab wapas le leta hai" test bhi hai.

**Update deploy karne par:** `sw.js` mein `VERSION = 'v1.0.0'` ko `'v1.0.1'` karein, warna phone purana version dikha sakta hai.

**Tuning ke numbers** (`js/engine.js` ke upar):

| Constant | Matlab | Default |
|---|---|---|
| `FEASIBILITY_LIMIT` | required pace / capacity isse upar ho to route choose karwata hai | 1.4 |
| `BALANCED_FACTOR` | "Balanced" route = capacity × yeh | 1.15 |
| `REVISION_FACTOR` | revision pass = pehli pass ka kitna % | 0.3 |
| `TIERS` | micro-task ke sizes (minutes) | 5 / 10 / 20 |

Streak ke qaide `rolloverStreak()` mein hain, mentor ke jumle `js/mentor.js` mein.

---

## 9. Masle aur hal

| Masla | Hal |
|---|---|
| "Token does not match" | Settings ka token aur `Code.gs` ka `API_TOKEN` bilkul same hona chahiye. Code badla ho to **New version** deploy karein. |
| "The URL did not answer like the mentor backend" | URL `/exec` par khatam hona chahiye (`/dev` nahi), aur access **Anyone** hona chahiye. |
| "Could not reach the sheet" | Internet check karein. Offline mein bhi app chalti hai, baad mein khud sync ho jati hai. |
| Naya deploy phone par nazar nahi aa raha | App band karke dobara kholein (do baar). `sw.js` ka VERSION badla hona chahiye. |
| Dashboard tab mein error | Wo sirf ek bonus hai. Pehle `setup` run karein aur kam az kam ek session log karein. |
| Galat session log ho gaya | Pace tab → Recent sessions → Delete. Phir manually sahi log karein. |

---

## 10. Design ke usool (taake aap khud bhi badal saken)

1. **Shame nahi, data.** Koi laal rang nahi, "failed" lafz nahi. Gap "din ki pace" mein dikhta hai, "ghanton ke karz" mein nahi.
2. **Shuru karna sab se mushkil hai**, isliye START ek tap hai aur log baad mein hota hai.
3. **Thakan ko plan mein shamil karein**, uske khilaf na ladein. Empty battery aur Landing Pad isi liye hain.
4. **Plan hamesha believable rahe.** Impossible number chup-chap dikhane ke bajaye app aapko route choose karne deti hai.
5. **Mentor ka format:** Observation → Normalisation → One action.

Aap ke exams ke liye best of luck. Chhota start, roz.
