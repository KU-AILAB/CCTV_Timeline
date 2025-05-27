let currentVideoFile = '';

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

window.addEventListener('DOMContentLoaded', () => {
  const videoFileInput = document.getElementById('videoFile');
  const videoPlayer    = document.getElementById('videoPlayer');
  const detectBtn      = document.getElementById('detectBtn');
  const uploadOnlyBtn  = document.getElementById('uploadOnlyBtn');

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
  const st = document.getElementById('startTime').value || '00:00:00';
  const res = await fetch('/extract_frames', {
    method: 'POST',
    body: new URLSearchParams({ video_file: fn, start_time: st })
  });
  const data = await res.json();
  const player = document.getElementById('videoPlayer');
  currentVideoFile = fn;
  player.src = `/static/uploads/${encodeURIComponent(getPlayableFilename(fn))}`;
  player.load();
  player.addEventListener('loadedmetadata', () => {
    player.currentTime = hms2sec(st);
    buildTimelineWithDots(data.detected_times, player.duration);
    const detSec = document.getElementById('detectionSection');
    detSec.classList.remove('d-none');
    document.getElementById('csvDownloadBtn').href  = data.csv;
    document.getElementById('jsonDownloadBtn').href = data.json;
  }, { once: true });
}

function buildTimelineWithDots(detectedTimes, duration) {
  const cellWidth  = 50;
  const totalCells = Math.ceil(duration / 10);
  const totalWidth = totalCells * cellWidth;
  const scroller   = document.getElementById('timelineScroller');
  const wrapper    = document.getElementById('timelineWrapper');
  const dotsWr     = document.getElementById('dotsWrapper');
  const controls   = document.getElementById('timelineControls');

  scroller.scrollLeft     = 0;
  wrapper.style.width     = `${totalWidth}px`;
  dotsWr.style.width      = `${totalWidth}px`;
  controls.style.width    = `${totalWidth}px`;

  dotsWr.innerHTML   = '';
  controls.innerHTML = '';
  if (!duration || detectedTimes.length === 0) return;

  const secs = Array.from(new Set(detectedTimes.map(t =>
    Math.floor(t)
  ))).sort((a, b) => a - b);

  const ranges = [];
  let start = secs[0], prev = secs[0];
  for (let i = 1; i < secs.length; i++) {
    if (secs[i] - prev <= 1) prev = secs[i];
    else { ranges.push([start, prev]); start = prev = secs[i]; }
  }
  ranges.push([start, prev]);

  ranges.forEach(([s, e]) => {
    const leftPx  = (s / 10) * cellWidth;
    const widthPx = ((e + 1 - s) / 10) * cellWidth;
    const centerX = leftPx + widthPx / 2;

    const line = document.createElement('div');
    line.className   = 'segment-line';
    line.style.left  = `${leftPx}px`;
    line.style.width = `${widthPx}px`;
    dotsWr.appendChild(line);

    [leftPx, leftPx + widthPx].forEach(x => {
      const dot = document.createElement('div');
      dot.className  = 'segment-dot';
      dot.style.left = `${x}px`;
      dotsWr.appendChild(dot);
    });

    const btn = document.createElement('button');
    btn.className  = 'clip-btn';
    btn.style.left = `${centerX}px`;
    btn.addEventListener('click', () => {
      const url = `/download_clip?video_file=${encodeURIComponent(currentVideoFile)
        }&start=${s.toFixed(2)}&end=${(e + 1).toFixed(2)}`;
      const a = document.createElement('a');
      a.href = url; a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    controls.appendChild(btn);
  });
}

/** 초 → HH:MM:SS 포맷 */
function secondsToHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}
