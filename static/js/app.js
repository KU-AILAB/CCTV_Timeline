let currentVideoFile = '';
let timelineRanges = [];     // [{ start:Number, end:Number }]
let videoDuration  = 0;
let dragging       = null;   // { dot, idx, edge, startX, origLeftPx }

/** HH:MM:SS → 초 변환 */
function hms2sec(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** .sec/.avi → .mp4 매핑 */
function getPlayableFilename(fn) {
  if (!fn) return '';
  const ext = fn.split('.').pop().toLowerCase();
  return (ext === 'sec' || ext === 'avi')
    ? fn.replace(/\.(sec|avi)$/i, '.mp4')
    : fn;
}

// ─── 1) 범위 병합 헬퍼 ───────────────────────────────
function mergeRanges() {
  // 시작 시간 기준 정렬
  timelineRanges.sort((a,b) => a.start - b.start);
  const merged = [];
  for (const r of timelineRanges) {
    if (!merged.length) {
      merged.push({ start: r.start, end: r.end });
    } else {
      const last = merged[merged.length-1];
      // 겹치거나 인접(겹침 허용)하면 병합
      if (r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ start: r.start, end: r.end });
      }
    }
  }
  timelineRanges = merged;
}

// ─── 2) 세그먼트 DOM 렌더링 ─────────────────────────
function renderSegments() {
  const wrapper  = document.getElementById('timelineWrapper');
  const dotsWr   = document.getElementById('dotsWrapper');
  const controls = document.getElementById('timelineControls');
  const maxPx    = wrapper.offsetWidth;

  dotsWr.innerHTML   = '';
  controls.innerHTML = '';

  timelineRanges.forEach((rng, idx) => {
    const s = rng.start, e = rng.end;
    const leftPx  = (s / videoDuration) * maxPx;
    const widthPx = ((e - s) / videoDuration) * maxPx;
    const centerX = leftPx + widthPx/2;

    // ── 2.1) 세그먼트 라인
    const line = document.createElement('div');
    line.className   = 'segment-line';
    line.style.left  = `${leftPx}px`;
    line.style.width = `${widthPx}px`;
    dotsWr.appendChild(line);

    // ── 2.2) 드래그용 점 (양끝)
    ['left','right'].forEach(edge => {
      const dot = document.createElement('div');
      dot.className   = 'segment-dot';
      dot.style.left  = `${edge==='left'?leftPx:(leftPx+widthPx)}px`;
      dot.dataset.idx = idx;
      dot.dataset.edge= edge;
      dot.addEventListener('pointerdown', startDotDrag);
      dotsWr.appendChild(dot);
    });

    // ── 2.3) 확정 전 “삭제” 버튼 (빨간점)
    const delBtn = document.createElement('button');
    delBtn.className = 'clip-btn';               // 기존 스타일 재활용
    delBtn.style.backgroundColor = '#dc3545';     // 빨간색
    delBtn.style.left = `${centerX}px`;
    delBtn.title     = '구간 삭제';
    delBtn.addEventListener('click', () => {
      if (confirm('이 검출 구간을 삭제하시겠습니까?')) {
        timelineRanges.splice(idx, 1);
        mergeRanges();   // 혹 인접 구간 간격 재조정
        renderSegments();
      }
    });
    controls.appendChild(delBtn);
  });
}
window.addEventListener('DOMContentLoaded', () => {
  const videoFileInput = document.getElementById('videoFile');
  const videoPlayer    = document.getElementById('videoPlayer');
  const detectBtn      = document.getElementById('detectBtn');
  const uploadOnlyBtn  = document.getElementById('uploadOnlyBtn');
  const confirmBtn = document.getElementById('confirmBtn');
  confirmBtn.addEventListener('click', e => {       // 클릭 시 서버 호출
    e.preventDefault();
    finalizeSegments();                             // 또는 confirmRanges()
  });
  // 이전 업로드 이어받기
  const pending = JSON.parse(localStorage.getItem('pendingUpload') || 'null');
  if (pending) {
    const pct = Math.round(pending.uploadedSize / pending.totalSize * 100);
    alert(`업로드가 ${pct}% 진행된 파일이 있습니다.\n동일한 파일 선택 시 이어서 업로드를 진행합니다.`);
    videoFileInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f && f.name === pending.filename && f.size === pending.totalSize) {
        resumeUpload(f, pending.sessionId, pending.uploadedSize);
      } else {
        localStorage.removeItem('pendingUpload');
      }
    }, { once: true });
  }

  loadServerVideos();

  // 재생 위치 표시 및 스크롤 동기화
  if (videoPlayer) {
    videoPlayer.addEventListener('timeupdate', () => {
      if (!videoPlayer.duration) return;
      const prog = document.getElementById('timelineProgress');
      const pct  = videoPlayer.currentTime / videoPlayer.duration * 100;
      prog.style.left = `${pct}%`;
      const scroller   = document.getElementById('timelineScroller');
      const wrapper    = document.getElementById('timelineWrapper');
      const totalWidth = wrapper.offsetWidth;
      const currentX   = (videoPlayer.currentTime / videoPlayer.duration) * totalWidth;
      const halfWidth  = scroller.clientWidth / 2;
      scroller.scrollLeft = Math.max(0, currentX - halfWidth);
    });
  }

  // --- 변경: 타임라인 클릭으로 탐색 ---
  const wrapper = document.getElementById('timelineWrapper');
  if (wrapper && videoPlayer) {
    wrapper.addEventListener('click', e => {
      const rect = wrapper.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct    = clickX / rect.width;
      videoPlayer.currentTime = pct * videoPlayer.duration;
    });
  }

  // --- 변경: 프로그레스바 드래그로 실시간 탐색 ---
  const prog = document.getElementById('timelineProgress');
  let isDragging = false;

  if (prog && wrapper && videoPlayer) {
    prog.addEventListener('pointerdown', e => {
      isDragging = true;
      prog.setPointerCapture(e.pointerId);
    });
    prog.addEventListener('pointermove', e => {
      if (!isDragging) return;
      const rect = wrapper.getBoundingClientRect();
      let x = e.clientX - rect.left;
      x = Math.max(0, Math.min(rect.width, x));
      const pct = x / rect.width;
      prog.style.left = `${pct * 100}%`;                                  // 변경: 프로그레스바 즉시 움직임
      videoPlayer.currentTime = pct * videoPlayer.duration;               // 변경: 드래그 중 현재 시간 변경
    });
    prog.addEventListener('pointerup', e => {
      isDragging = false;
      prog.releasePointerCapture(e.pointerId);
    });
  }

  // Detect 버튼
  if (detectBtn) {
    detectBtn.addEventListener('click', e => {
      e.preventDefault();
      if (!videoFileInput || !videoFileInput.files[0]) {
        return alert('파일을 선택하세요');
      }
      handleUploadAndDetect();
    });
  }

  // Upload Only 버튼
  if (uploadOnlyBtn) {
    uploadOnlyBtn.addEventListener('click', e => {
      e.preventDefault();
      uploadOnly();
    });
  }

  // 서비스 워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
});

// 업로드 진행 바 업데이트
function updateProgressBar(pct) {
  const bar = document.getElementById('uploadProgress');
  if (bar) bar.style.width = `${pct}%`;
}

/** 서버 영상 목록 로드 */
async function loadServerVideos() {
  const res    = await fetch('/api/videos', { credentials: 'same-origin' });
  const videos = await res.json();
  const tbody  = document.getElementById('serverVideos');
  tbody.innerHTML = '';
  const seen = new Set();
  videos.forEach(v => {
    if (!seen.has(v.filename)) {
      seen.add(v.filename);
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className   = 'ps-3';
      td.textContent = v.filename;
      tr.appendChild(td);
      tr.addEventListener('click', () => selectServerVideo(v.filename));
      tbody.appendChild(tr);
    }
  });
}

function selectServerVideo(fn) {
  currentVideoFile = fn;
  document.getElementById('startTime').value = '00:00:00';
  extractAndDetect(fn);
}

async function uploadOnly() {
  const file = document.getElementById('videoFile').files[0];
  if (!file) return alert('파일을 선택하세요');
  try {
    const init = await fetch('/upload/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, total_size: file.size })
    });
    const { session_id, uploaded_size } = await init.json();
    localStorage.setItem('pendingUpload', JSON.stringify({
      sessionId: session_id,
      filename: file.name,
      totalSize: file.size,
      uploadedSize: uploaded_size
    }));
    await uploadChunks(file, session_id, uploaded_size);
    localStorage.removeItem('pendingUpload');
    alert('업로드만 완료되었습니다.');
    loadServerVideos();
  } catch (e) {
    console.error(e);
    alert('업로드 중 오류가 발생했습니다.');
  }
}

async function handleUploadAndDetect() {
  const file = document.getElementById('videoFile').files[0];
  const init = await fetch('/upload/init', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, total_size: file.size })
  });
  const { session_id, uploaded_size } = await init.json();
  localStorage.setItem('pendingUpload', JSON.stringify({
    sessionId: session_id,
    filename: file.name,
    totalSize: file.size,
    uploadedSize: uploaded_size
  }));
  await uploadChunks(file, session_id, uploaded_size);
  localStorage.removeItem('pendingUpload');
  extractAndDetect(file.name);
}

async function resumeUpload(file, sid, offset) {
  updateProgressBar(Math.round(offset / file.size * 100));
  await uploadChunks(file, sid, offset);
  localStorage.removeItem('pendingUpload');
  extractAndDetect(file.name);
}

async function uploadChunks(file, sid, offset) {
  const chunkSize = 1024 * 1024;
  let uploaded = offset;
  while (uploaded < file.size) {
    const end   = Math.min(uploaded + chunkSize, file.size);
    const chunk = file.slice(uploaded, end);
    const form  = new FormData();
    form.append('session_id', sid);
    form.append('offset', uploaded);
    form.append('chunk', chunk);
    const res  = await fetch('/upload/chunk', {
      method: 'POST',
      credentials: 'same-origin',
      body: form
    });
    const data = await res.json();
    uploaded = data.uploaded_size;
    updateProgressBar(data.progress);
    const p = JSON.parse(localStorage.getItem('pendingUpload') || '{}');
    if (p.sessionId === sid) {
      p.uploadedSize = uploaded;
      localStorage.setItem('pendingUpload', JSON.stringify(p));
    }
  }
}

async function extractAndDetect(fn) {
  const st  = document.getElementById('startTime').value || '00:00:00';
  const res = await fetch('/extract_frames', {
    method:'POST',
    body:new URLSearchParams({ video_file:fn, start_time:st })
  });
  const { detected_times } = await res.json();

  currentVideoFile = fn;
  const player = document.getElementById('videoPlayer');
  player.src = `/static/uploads/${encodeURIComponent(fn.replace(/\.(sec|avi)$/i,'.mp4'))}`;
  player.load();
  player.addEventListener('loadedmetadata', () => {
    player.currentTime = hms2sec(st);
    videoDuration = player.duration;

    // ── 연속 5초 이내 묶기 (클라이언트 기준) ──
    const secs = Array.from(new Set(detected_times.map(t=>Math.floor(t)))).sort((a,b)=>a-b);
    const tmpRanges = [];
    let s=secs[0], p=secs[0];
    for (let i=1; i<secs.length; i++){
      if (secs[i] - p <= 5) {
        p = secs[i];
      } else {
        tmpRanges.push({ start: s, end: p+1 });
        s = p = secs[i];
      }
    }
    tmpRanges.push({ start: s, end: p+1 });
    timelineRanges = tmpRanges;

    // ── 렌더 & UI 노출 ──
    const detSec = document.getElementById('detectionSection');
    detSec.classList.remove('d-none');
    document.getElementById('confirmBtn').classList.remove('d-none');
    document.getElementById('downloadButtons').classList.add('d-none');

    renderSegments();
  }, { once:true });
}



async function finalizeSegments() {
  const res = await fetch('/finalize_segments', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_file: currentVideoFile,
      segments:    timelineRanges
    })
  });
  const data = await res.json();

  // ① CSV/JSON 다운로드 링크 설정
  const dlBtns = document.getElementById('downloadButtons');
  document.getElementById('csvDownloadBtn').href  = data.csv;
  document.getElementById('jsonDownloadBtn').href = data.json;

  // ② 클립 다운로드 버튼 생성
  const controls = document.getElementById('timelineControls');
  controls.innerHTML = '';  // 이전 버튼 제거
  data.clips.forEach((url, idx) => {
    const a = document.createElement('a');
    a.href        = url;
    a.textContent = `클립 ${idx+1}`;
    a.className   = 'btn btn-outline-primary btn-sm me-1';
    controls.appendChild(a);
  });

  // ③ UI 갱신: 확정 버튼 숨기고 다운로드 버튼들 보임
  document.getElementById('confirmBtn').classList.add('d-none');
  dlBtns.classList.remove('d-none');
}

// ❸ 이벤트 바인딩 (DOMContentLoaded 내부)
window.addEventListener('DOMContentLoaded', () => {
  // … 기존 upload/resume/detect 바인딩 유지 …

  // 확정 버튼 리스너
  const confirmBtn = document.getElementById('confirmBtn');
  confirmBtn.addEventListener('click', e => {
    e.preventDefault();
    finalizeSegments();
  });
});


function buildTimelineWithDots(detectedTimes, duration) {
  videoDuration = duration;
  const cellWidth  = 50;
  const totalCells = Math.ceil(duration / 10);
  const totalWidth = totalCells * cellWidth;

  const scroller = document.getElementById('timelineScroller');
  const wrapper  = document.getElementById('timelineWrapper');
  const dotsWr   = document.getElementById('dotsWrapper');
  const controls = document.getElementById('timelineControls');

  scroller.scrollLeft = 0;
  wrapper.style.width = `${totalWidth}px`;
  dotsWr.style.width  = `${totalWidth}px`;
  controls.style.width = `${totalWidth}px`;

  dotsWr.innerHTML   = '';
  controls.innerHTML = '';
  if (!duration || detectedTimes.length === 0) return;

  /* 1) 초 단위 시각 → 연속 구간 배열 */
  const secs = Array.from(new Set(detectedTimes.map(t => Math.floor(t)))).sort((a, b) => a - b);
  const ranges = [];
  let start = secs[0], prev = secs[0];
  for (let i = 1; i < secs.length; i++) {
    if (secs[i] - prev <= 10) prev = secs[i];
    else { ranges.push([start, prev]); start = prev = secs[i]; }
  }
  ranges.push([start, prev]);

  /* 전역 상태 저장 (드래그 반영용) */
  timelineRanges = ranges.map(([s, e]) => ({ start: s, end: e + 1 })); // end는 +1(구간 끝점)

  /* 2) 구간별 선·점·버튼 DOM 생성 */
  timelineRanges.forEach(({ start: s, end: e }, idx) => {
    const leftPx  = (s / 10) * cellWidth;
    const widthPx = ((e - s) / 10) * cellWidth;
    const centerX = leftPx + widthPx / 2;

    /* 선 */
    const line = document.createElement('div');
    line.className   = 'segment-line';
    line.style.left  = `${leftPx}px`;
    line.style.width = `${widthPx}px`;
    dotsWr.appendChild(line);

    /* 좌·우 점 (드래그 가능) */
    [['left', s], ['right', e]].forEach(([edge, sec]) => {
      const dot = document.createElement('div');
      dot.className  = 'segment-dot';
      dot.style.left = `${(sec / 10) * cellWidth}px`;
      dot.dataset.idx  = idx;   // 구간 인덱스
      dot.dataset.edge = edge;  // 'left' | 'right'
      dot.addEventListener('pointerdown', startDotDrag);
      dotsWr.appendChild(dot);
    });

    /* (선택) 다운로드 버튼 */
    const btn = document.createElement('button');
    btn.className  = 'clip-btn';
    btn.style.left = `${centerX}px`;
    btn.addEventListener('click', () => {
      const url = `/download_clip?video_file=${encodeURIComponent(currentVideoFile)
        }&start=${s.toFixed(2)}&end=${e.toFixed(2)}`;
      const a = document.createElement('a');
      a.href = url; a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    controls.appendChild(btn);
  });
}

// ─── 4) 드래그 이벤트 후 병합 & 리렌더 ─────────────────
function startDotDrag(e) {
  dragging = {
    dot        : e.target,
    idx        : +e.target.dataset.idx,
    edge       : e.target.dataset.edge,
    startX     : e.clientX,
    origLeftPx : parseFloat(e.target.style.left)
  };
  e.target.setPointerCapture(e.pointerId);
  document.addEventListener('pointermove', moveDotDrag);
  document.addEventListener('pointerup',   endDotDrag, { once:true });
}


function moveDotDrag(e) {
  if (!dragging) return;
  const wrapper = document.getElementById('timelineWrapper');
  const maxPx   = wrapper.offsetWidth;
  const dx      = e.clientX - dragging.startX;
  let newPx     = dragging.origLeftPx + dx;
  newPx = Math.max(0, Math.min(maxPx, newPx));
  dragging.dot.style.left = `${newPx}px`;

  // 영역 좌/우 갱신
  const rng = timelineRanges[dragging.idx];
  const sec = (newPx / maxPx) * videoDuration;
  if (dragging.edge === 'left') {
    rng.start = Math.min(sec, rng.end - 1);
  } else {
    rng.end   = Math.max(sec, rng.start + 1);
  }
  // 바로 DOM 업데이트
  refreshSegmentDOM(dragging.idx);
}
function endDotDrag(e) {
  if (dragging) {
    dragging.dot.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', moveDotDrag);
    // ── 병합 & 리렌더 ──
    mergeRanges();
    renderSegments();
    dragging = null;
  }
}

/* ────────────────────────────────────────────────────────
   NEW ─ 선·점 위치 동기화
──────────────────────────────────────────────────────── */
function refreshSegmentDOM(idx) {
  const { start:s, end:e } = timelineRanges[idx];
  const wrapper = document.getElementById('timelineWrapper');
  const maxPx   = wrapper.offsetWidth;
  // 선
  const line    = document.querySelectorAll('.segment-line')[idx];
  line.style.left  = `${(s/videoDuration)*maxPx}px`;
  line.style.width = `${((e-s)/videoDuration)*maxPx}px`;
  // 점
  document.querySelectorAll(`.segment-dot[data-idx="${idx}"]`)
    .forEach(dot => {
      const sec = dot.dataset.edge === 'left' ? s : e;
      dot.style.left = `${(sec/videoDuration)*maxPx}px`;
    });
}


/** 초 → HH:MM:SS 포맷 */
function secondsToHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}
