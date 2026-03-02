const CONFIG = {
  QUESTIONS_PER_GAME: 25,
  TIME_PER_QUESTION: 30, // 30s cho mỗi câu
  BASE_POINTS: 10,       // điểm cơ bản cho mỗi câu đúng
  MAX_SPEED_BONUS: 10,
  AUTO_NEXT_SECONDS: 2,  // tự động sang câu tiếp theo sau khi chấm (giây) - Đặt ngắn lại để nhanh hơn
  SHUFFLE_QUESTIONS: true,
  SHUFFLE_OPTIONS: true, // trộn thứ tự đáp án trong mỗi câu
  DIFFICULTY_QUOTAS: {   // đảm bảo mức độ khó đồng đều giữa các phiên
    NB: 10,  // Nhận biết
    TH: 10,  // Thông hiểu
    SL: 5   // Suy luận nhẹ
  },
  GOOGLE_SHEETS_ENDPOINT: "https://script.google.com/macros/s/AKfycbzU0KJ-N6fu8AG6JT-ltSkUz-jS8H4HduNGKZoOBO7Mk8X6Ps3UeGlmwlcja27uTH7J/exec",
  REQUIRE_CONSENT: true,     // nếu true: bắt buộc tick đồng ý mới cho bắt đầu
  THEME: "dark"               // "dark" hoặc "light"
};

// Hàm hiển thị thông báo tuỳ chỉnh dạng popup HTML
function customAlert(msg, callback, isLoading = false, btnText = "OK") {
  const modal = $("#alertModal");
  if (!modal) {
    if (!isLoading) alert(msg); // Fallback to browser alert if modal not found
    if (callback && !isLoading) callback();
    return;
  }
  $("#alertMessage").textContent = msg;
  modal.classList.remove("hidden");

  const btn = $("#btnAlertOk");
  if (isLoading) {
    btn.style.display = "none";
  } else {
    btn.style.display = "inline-block";
    btn.textContent = btnText;
    btn.onclick = () => {
      modal.classList.add("hidden");
      if (callback) callback();
    };
  }
}

// ====== Trạng thái trò chơi ======
const state = {
  sessionId: "",
  player: { name: "", mssv: "", lop: "" },
  questions: [],
  startedAt: 0,
  totalElapsedSec: 0,
  currentIndex: 0,
  timer: { remain: 0, id: null },
  score: { base: 0, speedBonus: 0, get total() { return this.base + this.speedBonus } },
  answers: [], // [{id, prompt, chosenIndex, correctIndex, correct, base, bonus, elapsedSec, tags, explanation }]
  rng: null,
  locked: false,
  autoNextId: null,
  qStartTime: 0 // Thời điểm bắt đầu hiển thị câu hỏi hiện tại
};

// ====== Tiện ích ======
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// RNG có seed theo sessionId để mỗi phiên khác nhau nhưng tái lập được nếu cần
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFromString(s) {
  const seedFn = xmur3(s);
  const seed = seedFn();
  return mulberry32(seed);
}
function shuffleRng(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { }
}

// ====== Lấy câu hỏi theo mức độ khó (stratified) ======
function pickQuestionsStratified(bank, quotas, rng, totalNeed) {
  // Nhóm theo difficulty: NB, TH, SL (mặc định NB nếu thiếu)
  const buckets = { NB: [], TH: [], SL: [] };
  bank.forEach(q => {
    const d = (q.difficulty || "NB").toUpperCase();
    if (!buckets[d]) buckets[d] = [];
    buckets[d].push(q);
  });

  const chosen = [];
  // lấy theo quota
  for (const [d, need] of Object.entries(quotas)) {
    const pool = buckets[d] || [];
    const shuffled = shuffleRng(pool, rng);
    for (let i = 0; i < Math.min(need, shuffled.length); i++) {
      chosen.push(shuffled[i]);
    }
  }
  // nếu thiếu do ngân hàng không đủ -> bù từ phần còn lại
  if (chosen.length < totalNeed) {
    const remainingPool = bank.filter(q => !chosen.includes(q));
    const shuffled = shuffleRng(remainingPool, rng);
    while (chosen.length < totalNeed && shuffled.length) {
      chosen.push(shuffled.shift());
    }
  }
  // nếu thừa (quota > totalNeed) -> cắt bớt
  return chosen.slice(0, totalNeed);
}

// Trộn đáp án trong mỗi câu và cập nhật answerIndex
function withShuffledOptions(q, rng) {
  const idxs = q.options.map((_, i) => i);
  const shuffledIdxs = shuffleRng(idxs, rng);
  const newOptions = shuffledIdxs.map(i => q.options[i]);
  const newAnswerIndex = shuffledIdxs.indexOf(q.answerIndex);
  return { ...q, options: newOptions, answerIndex: newAnswerIndex };
}

// ====== View helpers ======
function switchView(id) {
  $$(".view").forEach(v => v.classList.add("hidden"));
  $(`#${id} `).classList.remove("hidden");
  $(`#${id} `).classList.add("current");
}

function setTheme(mode) {
  const root = document.documentElement;
  if (mode === "light") root.classList.add("light");
  else root.classList.remove("light");
}

// ====== Khởi tạo ======
window.addEventListener("DOMContentLoaded", () => {
  // Theme
  setTheme(CONFIG.THEME === "light" ? "light" : "dark");
  $("#btnTheme").addEventListener("click", () => {
    const light = !document.documentElement.classList.contains("light");
    setTheme(light ? "light" : "dark");
  });

  // Footer year
  $("#year").textContent = new Date().getFullYear();

  // Form actions
  $("#btnStart").addEventListener("click", onStart);
  $("#btnNext").addEventListener("click", commitAnswer);
  $("#btnSend").addEventListener("click", sendToSheets);
  $("#btnDownload").addEventListener("click", downloadResult);
  $("#btnReplay").addEventListener("click", resetToLobby);
  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (!$("#view-game").classList.contains("hidden")) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9) {
        const opts = $$("#options .option");
        const idx = n - 1;
        if (opts[idx]) opts[idx].click();
      } else if (e.key === "Enter") {
        const nextBtn = $("#btnNext");
        if (!nextBtn.disabled) nextBtn.click();
      }
    }
  });
});

// ====== Gameplay ======

function lockQuestion() {
  state.locked = true;
  const ol = $("#options");
  if (ol) ol.classList.add("locked");
  $$("#options .option").forEach(el => el.setAttribute("aria-disabled", "true"));
}
function unlockQuestion() {
  state.locked = false;
  const ol = $("#options");
  if (ol) ol.classList.remove("locked");
  $$("#options .option").forEach(el => el.removeAttribute("aria-disabled"));
}
function startAutoNextCountdown() {
  // Hàm này không còn dùng nữa do chế độ AutoNext trực tiếp khi chọn
}

async function onStart() {
  const name = $("#inpName").value.trim();
  const mssv = $("#inpMssv").value.trim();
  const lop = $("#inpClass").value.trim();
  const consent = $("#inpConsent").checked;

  if (!name || !mssv || !lop) { customAlert("Vui lòng nhập đầy đủ Họ tên, MSSV và Lớp học."); return; }

  const nameRegex = /^[a-zA-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠàáâãèéêìíòóôõùúăđĩũơƯĂẠẢẤẦẨẪẬẮẰẲẴẶẸẺẼỀỀỂưăạảấầẩẫậắằẳẵặẹẻẽềềểÊỄỆỈỊỌỎỐỒỔỖỘỚỜỞỠỢỤỦỨỪễệỉịọỏốồổỗộớờởỡợụủứừỮỰỲỴÝỶỸửữựỳỵỷỹ\s]+$/;
  if (!nameRegex.test(name)) {
    customAlert("Họ và tên chỉ được chứa chữ cái.");
    return;
  }

  const mssvRegex = /^\d{10,11}$/;
  if (!mssvRegex.test(mssv)) {
    customAlert("Mã số sinh viên (MSSV) bắt buộc phải là số và có độ dài từ 10 đến 11 kí tự.");
    return;
  }

  const classRegex = /^[a-zA-Z]{3}\d{4}$/;
  if (!classRegex.test(lop)) {
    customAlert("Mã lớp gồm 7 kí tự: 3 kí tự chữ, 4 kí tự số (VD: DTT1251).");
    return;
  }

  if (CONFIG.REQUIRE_CONSENT && !consent) {
    customAlert("Vui lòng Xác nhận đồng ý cung cấp thông tin.");
    return;
  }

  const endpoint = CONFIG.GOOGLE_SHEETS_ENDPOINT;
  if (!endpoint) {
    customAlert("Lỗi ENDPOINT hãy báo lại với BTC.");
    return;
  }

  // Khóa nút bắt đầu và hiện loading
  const btnStart = $("#btnStart");
  const originalText = btnStart.textContent;
  btnStart.disabled = true;
  btnStart.textContent = "Đang kiểm tra...";

  try {
    const res = await fetch(endpoint + "?mssv=" + encodeURIComponent(mssv));
    const data = await res.json();
    if (data.exists) {
      customAlert("Mã số sinh viên (MSSV) này đã tham gia bài thi. Mỗi sinh viên chỉ được tham gia 1 lần.");
      btnStart.disabled = false;
      btnStart.textContent = originalText;
      return;
    }
  } catch (err) {
    console.warn("Lỗi kiểm tra trùng lặp MSSV:", err);
    customAlert("Lỗi kết nối máy chủ khi kiểm tra MSSV. Thử F5 lại nếu vẫn lỗi hãy báo BTC.");
    btnStart.disabled = false;
    btnStart.textContent = originalText;
    return;
  }

  btnStart.disabled = false;
  btnStart.textContent = originalText;

  state.sessionId = uuid();
  state.player = { name, mssv, lop };
  state.startedAt = Date.now();
  state.totalElapsedSec = 0;
  state.currentIndex = 0;
  state.timer = { remain: CONFIG.TIME_PER_QUESTION, id: null };
  state.score.base = 0;
  state.score.speedBonus = 0;
  state.answers = [];
  state.qStartTime = 0;

  // RNG theo session
  state.rng = rngFromString(state.sessionId);

  // Lấy câu hỏi theo quota độ khó
  const bank = Array.isArray(window.QUESTION_BANK) ? window.QUESTION_BANK.slice() : [];
  if (bank.length === 0) {
    customAlert("Chưa có câu hỏi trong QUESTION_BANK, hãy báo lại lỗi cho BTC.");
    return;
  }

  let selected = pickQuestionsStratified(bank, CONFIG.DIFFICULTY_QUOTAS, state.rng, CONFIG.QUESTIONS_PER_GAME);
  if (CONFIG.SHUFFLE_QUESTIONS) selected = shuffleRng(selected, state.rng);
  if (CONFIG.SHUFFLE_OPTIONS) selected = selected.map(q => withShuffledOptions(q, state.rng));
  state.questions = selected;

  // Bật HUD thông tin người chơi
  const hudName = $("#hudName"); if (hudName) hudName.textContent = name;
  const hudMssv = $("#hudMssv"); if (hudMssv) hudMssv.textContent = `${mssv} - ${lop} `;

  switchView("view-game");
  renderCurrent();
  startTimer();
}

function renderCurrent() {
  const q = state.questions[state.currentIndex];
  if (!q) return;
  state.currentChoice = null;

  // HUD
  $("#txtProgress").textContent = `${state.currentIndex + 1}/${state.questions.length}`;
  // $("#txtScore").textContent = state.score.total; // Removed score updates
  updateProgressLine();

  // Question
  $("#qText").innerHTML = q.prompt;
  const ol = $("#options");
  ol.innerHTML = "";

  q.options.forEach((opt, i) => {
    const li = document.createElement("li");
    li.className = "option";
    li.setAttribute("role", "option");
    li.setAttribute("tabindex", "0");
    li.dataset.index = i;

    const prefix = document.createElement("div");
    prefix.className = "prefix";
    prefix.textContent = String.fromCharCode(65 + i); // A, B, C...

    const text = document.createElement("div");
    text.className = "text";
    text.innerHTML = opt;

    li.appendChild(prefix);
    li.appendChild(text);

    li.addEventListener("click", () => onChoose(i));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") li.click(); });
    ol.appendChild(li);
  });

  $("#feedback").classList.add("hidden");
  $("#explanation").classList.add("hidden");
  $("#explanation").innerHTML = "";
  $("#btnNext").disabled = true;
  clearInterval(state.autoNextId);
  $("#btnNext").textContent = "Tiếp tục ▶";
  const firstOpt = $("#options .option"); if (firstOpt) firstOpt.focus();
  unlockQuestion();
  state.qStartTime = Date.now();
}

function onChoose(i) {
  if (state.locked) return;

  state.currentChoice = i;

  // Hiển thị đã chọn (trạng thái chosen)
  const optionsList = $("#options").children;
  for (let idx = 0; idx < optionsList.length; idx++) {
    optionsList[idx].removeAttribute("data-state");
  }
  if (optionsList[i]) optionsList[i].setAttribute("data-state", "chosen");

  // Bật nút Tiếp tục
  $("#btnNext").disabled = false;
}

function commitAnswer() {
  if (state.locked) return;
  lockQuestion();
  const q = state.questions[state.currentIndex];
  if (!q) return;

  stopTimer();
  const elapsed = CONFIG.TIME_PER_QUESTION - Math.max(0, state.timer.remain); // giây
  state.totalElapsedSec += elapsed;

  const i = state.currentChoice;
  const correctIndex = q.answerIndex;
  const correct = (i === correctIndex);

  const base = correct && i !== null ? CONFIG.BASE_POINTS : 0;

  // Logic điểm cộng: 10 điểm cơ bản + tối đa 10 điểm thưởng nếu chọn ngay lập tức (phân bổ đều theo 30s)
  const bonus = correct && i !== null ? Math.round(CONFIG.MAX_SPEED_BONUS * (Math.max(0, state.timer.remain) / CONFIG.TIME_PER_QUESTION)) : 0;

  state.score.base += base;
  state.score.speedBonus += bonus;

  // Haptic nhẹ khi người dùng chọn đáp án
  vibrate(15);

  // Lưu câu trả lời
  state.answers.push({
    id: q.id, prompt: q.prompt, chosenIndex: i, correctIndex: q.answerIndex,
    correct, base, bonus, elapsedSec: elapsed, tags: q.tags || [],
    explanation: q.explanation || "", difficulty: q.difficulty || "NB"
  });

  // Tức khắc chuyển câu tiếp theo thay vì chờ
  nextQuestion();
}

function startTimer() {
  state.timer.remain = CONFIG.TIME_PER_QUESTION;
  updateTimerRing();

  clearInterval(state.timer.id);
  state.timer.id = setInterval(() => {
    state.timer.remain -= 1;
    updateTimerRing();
    if (state.timer.remain <= 0) {
      clearInterval(state.timer.id);
      onTimeout();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timer.id);
}

function updateTimerRing() {
  const pct = clamp(state.timer.remain / CONFIG.TIME_PER_QUESTION, 0, 1);
  $("#timerRing").style.setProperty("--pct", pct.toFixed(4));

  // Cập nhật số điểm có thể nhận (hiện tại)
  const potentialBonus = Math.round(CONFIG.MAX_SPEED_BONUS * (state.timer.remain / CONFIG.TIME_PER_QUESTION));
  const potentialScore = CONFIG.BASE_POINTS + potentialBonus;
  const txtPot = $("#txtPotentialScore");
  if (txtPot) {
    txtPot.textContent = `+${potentialScore}`;
    // Nếu điểm sắp giảm về mức thấp, đổi màu cảnh báo
    if (potentialScore <= 12) txtPot.style.color = "var(--bad)";
    else txtPot.style.color = "var(--ok)";
  }
}

function onTimeout() {
  if (state.currentChoice != null) {
    commitAnswer();
  } else {
    // Chấm như trả lời sai
    const q = state.questions[state.currentIndex];
    const correctIndex = q.answerIndex;
    state.totalElapsedSec += CONFIG.TIME_PER_QUESTION;

    // Lưu
    state.answers.push({
      id: q.id, prompt: q.prompt, chosenIndex: null, correctIndex,
      correct: false, base: 0, bonus: 0, elapsedSec: CONFIG.TIME_PER_QUESTION, tags: q.tags || [],
      explanation: q.explanation || "", difficulty: q.difficulty || "NB"
    });

    // Chuyển câu tiếp
    nextQuestion();
  }
}

function nextQuestion() {
  const card = $("#questionCard");
  if (card) {
    card.classList.add("fade-out");
    setTimeout(() => {
      doNextQuestionLogic();
      card.classList.remove("fade-out");
    }, 250); // Khớp với thời gian transition CSS
  } else {
    doNextQuestionLogic();
  }
}

function doNextQuestionLogic() {
  clearInterval(state.autoNextId);
  $("#btnNext").textContent = "Tiếp tục ▶";
  state.currentIndex += 1;
  if (state.currentIndex >= state.questions.length) {
    updateProgressLine(1);
    stopTimer();
    const p = showSummary();
    // Tự động gửi kết quả khi hoàn thành
    sendToSheets();
    return p;
  }
  renderCurrent();
  startTimer();
}

function updateProgressLine(force1) {
  const bar = $("#lineProgress");
  if (!bar) return;
  const total = state.questions.length || CONFIG.QUESTIONS_PER_GAME;
  const ratio = force1 ? 1 : (state.currentIndex / total);
  bar.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}

function showSummary() {
  switchView("view-summary");

  const correctCount = state.answers.filter(a => a.correct).length;
  const acc = Math.round((correctCount / state.questions.length) * 100);

  $("#sumTotal").textContent = state.score.total;
  $("#sumBase").textContent = state.score.base;
  $("#sumSpeed").textContent = state.score.speedBonus;
  $("#sumAcc").textContent = `${acc}%`;
  $("#sumTime").textContent = `${state.totalElapsedSec}s`;
  $("#sumSession").textContent = state.sessionId;
  $("#sumName").textContent = state.player.name;
  $("#sumMssv").textContent = state.player.mssv;
  $("#sumClass").textContent = state.player.lop;
}

function stripHTML(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function resetToLobby() {
  switchView("view-lobby");
  // reset view game
  $("#txtProgress").textContent = `1/${CONFIG.QUESTIONS_PER_GAME}`;
  $("#txtTimer").textContent = CONFIG.TIME_PER_QUESTION;
  $("#options").innerHTML = "";
  $("#feedback").classList.add("hidden");
  $("#explanation").classList.add("hidden");
  const txtPot = $("#txtPotentialScore"); if (txtPot) { txtPot.textContent = `+${CONFIG.BASE_POINTS + CONFIG.MAX_SPEED_BONUS}`; txtPot.style.color = "var(--ok)"; }
  const bar = $("#lineProgress"); if (bar) bar.style.width = "0%";
}

// ====== Gửi dữ liệu sang Google Sheets (Apps Script) ======
async function sendToSheets() {
  const endpoint = CONFIG.GOOGLE_SHEETS_ENDPOINT;
  if (!endpoint) {
    customAlert("Lỗi ENDPOINT hãy báo lại với BTC.");
    return;
  }
  const btn = $("#btnSend"); if (btn) btn.disabled = true;
  const correctCount = state.answers.filter(a => a.correct).length;
  const payload = {
    sessionId: state.sessionId,
    // Google Sheets apps script gốc kì vọng "email", nên ta gán thông tin "lop" vào trường "email" để gửi, đồng thời giữ nguyên "lop" để không làm hỏng code cũ của sheet.
    player: { name: state.player.name, mssv: state.player.mssv, lop: state.player.lop, email: state.player.lop },
    score: { base: state.score.base, speedBonus: state.score.speedBonus, total: state.score.total },
    meta: {
      totalQuestions: state.questions.length,
      correctCount,
      accuracy: Math.round((correctCount / state.questions.length) * 100),
      timeSpentSec: state.totalElapsedSec,
      userAgent: navigator.userAgent
    },
    answers: state.answers
  };

  try {
    // Hiển thị trạng thái đang gửi
    customAlert("Hệ thống đang ghi nhận dữ liệu vào máy chủ, vui lòng đợi trong giây lát...", null, true);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    try {
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Máy chủ phản hồi lỗi");
    } catch (parseErr) {
      if (parseErr.message.includes("Máy chủ")) throw parseErr;
      throw new Error("Lỗi máy chủ Google Apps Script (Hãy đảm bảo đã tạo New Deployment)");
    }

    // Đã nộp thành công, hiện popup thông báo
    customAlert(
      "Kết quả điểm số đã được hệ thống ghi nhận. Kết quả giải thưởng chung cuộc sẽ được công bố tại Trang Tuổi trẻ Khoa Khoa học Xã hội và Nghệ thuật.",
      () => {
        // Đã báo xong, người dùng bấm OK thì hiển thị summary (có bảng điểm)
        $("#view-summary").classList.add("current");
      },
      false,
      "Hoàn tất"
    );
  } catch (err) {
    console.error(err);
    if (btn) btn.disabled = false;
    customAlert(
      "Gửi dữ liệu nhận kết quả thất bại:\n" + err.message + "\n\nBạn có muốn thử gửi lại không?",
      () => {
        sendToSheets(); // Thử gửi lại
      },
      false,
      "Gửi lại"
    );
  }
}

// Cho phép tải kết quả về máy (phòng trường hợp không gửi được)
function downloadResult() {
  const data = {
    sessionId: state.sessionId,
    player: state.player,
    score: { base: state.score.base, speedBonus: state.score.speedBonus, total: state.score.total },
    answers: state.answers,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `quiz-thu-vien-so_${state.sessionId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
