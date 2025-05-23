let currentVideoFile = '';

/** HH:MM:SS → 초 */
function hms2sec(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** .sec/.avi → .mp4 매핑 */
function getPlayableFilename(fn) {
  const ext = fn.split('.').pop().toLowerCase();
  return (ext === 'sec' || ext === 'avi')
    ? fn.replace(/\.(sec|avi)$/i, '.mp4')
    : fn;
}

window.addEventListener('DOMContentLoaded', () => {
  // 1) 이어 업로드 재개 체크
  const pending = JSON.parse(localStorage.getItem('pendingUpload') || 'null');
  if (pending) {
    const pct = Math.round(pending.uploadedSize / pending.totalSize * 100);
    alert(`업로드가 ${pct}% 진행된 파일이 있습니다.\n동일한 파일 선택 시 이어서 업로드합니다.`);
    document.getElementById('videoFile').addEventListener('change', e => {
      const f = e.target.files[0];
      if (f && f.name === pending.filename && f.size === pending.totalSize) {
        resumeUpload(f, pending.sessionId, pending.uploadedSize);
      } else {
        localStorage.removeItem('pendingUpload');
      }
    }, { once: true });
  }

  // 2) 서버 영상 목록 로드
  loadServerVideos();

  // 3) 검출 버튼 클릭
  document.getElementById('detectBtn').addEventListener('click', e => {
    e.preventDefault();
    const file = document.getElementById('videoFile').files[0];
    if (!file) return alert('파일을 선택하세요');
    // 업로드 후 검출
    handleUploadAndDetect();
  });

  // 4) 업로드만 버튼 클릭
  document.getElementById('uploadOnlyBtn').addEventListener('click', e => {
    e.preventDefault();
    uploadOnly();
  });

  // 5) 서비스 워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
});

/** 서버 영상 목록 조회 & 렌더링 */
async function loadServerVideos() {
  const res = await fetch('/api/videos', { credentials: 'same-origin' });
  const videos = await res.json();
  const tbody = document.getElementById('serverVideos');
  tbody.innerHTML = '';
  videos.forEach(v => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="ps-3">${v.filename}</td>`;
    tr.addEventListener('click', () => selectServerVideo(v.filename));
    tbody.appendChild(tr);
  });
}

/** 서버 영상 선택 → 검출 */
function selectServerVideo(fn) {
  currentVideoFile = fn;
  document.getElementById('startTime').value = '00:00:00';
  extractAndDetect(fn);
}

/** 업로드만 (검출 없이) */
async function uploadOnly() {
  const file = document.getElementById('videoFile').files[0];
  if (!file) return alert('파일을 선택하세요');
  try {
    // 1) 세션 초기화
    const init = await fetch('/upload/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, total_size: file.size })
    });
    const { session_id, uploaded_size } = await init.json();
    // 2) 로컬 진행 저장
    localStorage.setItem('pendingUpload', JSON.stringify({
      sessionId: session_id,
      filename: file.name,
      totalSize: file.size,
      uploadedSize: uploaded_size
    }));
    // 3) 청크 업로드
    await uploadChunks(file, session_id, uploaded_size);
    localStorage.removeItem('pendingUpload');
    alert('업로드만 완료되었습니다.');
    loadServerVideos();
  } catch (err) {
    console.error(err);
    alert('업로드 중 오류가 발생했습니다.');
  }
}

/** 업로드 + 검출 */
async function handleUploadAndDetect() {
  const file = document.getElementById('videoFile').files[0];
  // 1) 세션 초기화
  const init = await fetch('/upload/init', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, total_size: file.size })
  });
  const { session_id, uploaded_size } = await init.json();
  // 2) 로컬 진행 저장
  localStorage.setItem('pendingUpload', JSON.stringify({
    sessionId: session_id,
    filename: file.name,
    totalSize: file.size,
    uploadedSize: uploaded_size
  }));
  // 3) 청크 업로드
  await uploadChunks(file, session_id, uploaded_size);
  localStorage.removeItem('pendingUpload');
  // 4) 검출 실행
  extractAndDetect(file.name);
}

/** 이어 업로드 재개 */
async function resumeUpload(file, sid, offset) {
  updateProgressBar(Math.round(offset / file.size * 100));
  await uploadChunks(file, sid, offset);
  localStorage.removeItem('pendingUpload');
  extractAndDetect(file.name);
}

/** 청크 업로드 */
async function uploadChunks(file, sid, offset) {
  const chunkSize = 1024 * 1024;
  let uploaded = offset;
  while (uploaded < file.size) {
    const end = Math.min(uploaded + chunkSize, file.size);
    const chunk = file.slice(uploaded, end);
    const form = new FormData();
    form.append('session_id', sid);
    form.append('offset', uploaded);
    form.append('chunk', chunk);
    const res = await fetch('/upload/chunk', {
      method: 'POST',
      credentials: 'same-origin',
      body: form
    });
    const data = await res.json();
    uploaded = data.uploaded_size;
    updateProgressBar(data.progress);
    // 로컬 진행 갱신
    const p = JSON.parse(localStorage.getItem('pendingUpload') || '{}');
    if (p.sessionId === sid) {
      p.uploadedSize = uploaded;
      localStorage.setItem('pendingUpload', JSON.stringify(p));
    }
  }
}

/** 진행률 바 업데이트 */
function updateProgressBar(pct) {
  document.getElementById('uploadProgress').style.width = `${pct}%`;
}

/** 프레임 추출 & 탐지 API 호출 */
async function extractAndDetect(fn) {
  // 결과 숨김
  document.getElementById('detectionSection').classList.add('d-none');
  const st = document.getElementById('startTime').value || '00:00:00';
  const res = await fetch('/extract_frames', {
    method: 'POST',
    credentials: 'same-origin',
    body: new URLSearchParams({ video_file: fn, start_time: st })
  });
  const data = await res.json();
  // 비디오 로드
  const player = document.getElementById('videoPlayer');
  player.src = `/static/uploads/${encodeURIComponent(getPlayableFilename(fn))}`;
  player.load();
  player.addEventListener('loadedmetadata', () => {
    player.currentTime = hms2sec(st);
    // 썸네일·결과·구간 렌더
    displayFramesInTimeline(data.frames, data.frame_times, data.detected_times);
    displayDetectionResults(data.csv, data.json, data.segments);
    buildTimelines(data.detected_times, player.duration);
  }, { once: true });
}

/** 썸네일 표시 */
function displayFramesInTimeline(frames, times, detected = []) {
  const wrap = document.getElementById('framesWrapper') || document.querySelector('.frames-wrapper');
  if (!wrap) return;
  wrap.innerHTML = '';
  const detSet = new Set(detected.map(t => Math.floor(t)));
  const base  = currentVideoFile.replace(/\.(sec|avi|mp4)$/i, '');
  frames.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'timeline-frame' + (detSet.has(Math.floor(times[i])) ? ' detected-frame' : '');
    const img = document.createElement('img');
    img.src = `/static/frames/${encodeURIComponent(base)}/${encodeURIComponent(f)}`;
    div.appendChild(img);
    div.onclick = () => document.getElementById('videoPlayer').currentTime = times[i];
    wrap.appendChild(div);
  });
}

/** 탐지 결과 및 클립 링크 표시 */
function displayDetectionResults(csvPath, jsonPath, segments = []) {
  const sec = document.getElementById('detectionSection');
  sec.classList.remove('d-none');
  document.getElementById('csvDownloadBtn').href  = csvPath;
  document.getElementById('jsonDownloadBtn').href = jsonPath;
  const clipWrap = document.getElementById('clipDownloads');
  clipWrap.innerHTML = '';
  segments.forEach(seg => {
    const a = document.createElement('a');
    a.href    = `/static/detections/${seg}`;
    a.download= seg;
    a.className = 'btn btn-outline-success btn-sm me-2';
    a.textContent = `다운로드: ${seg}`;
    clipWrap.appendChild(a);
  });
}

/** 검출 구간 타임라인에 표시 */
function buildTimelines(detected, duration) {
  const tl = document.getElementById('timelines');
  tl.innerHTML = '';
  const secs = Array.from(new Set(detected.map(t => Math.floor(t)))).sort((a, b) => a - b);
  if (!secs.length) return;
  let start = secs[0], prev = secs[0], segs = [];
  secs.slice(1).forEach(s => {
    if (s - prev <= 1) prev = s;
    else { segs.push([start, prev + 1]); start = prev = s; }
  });
  segs.push([start, prev + 1]);
  segs.forEach(([s, e]) => {
    const bar = document.createElement('div');
    bar.className = 'segment-detected';
    bar.style.left  = (s / duration * 100) + '%';
    bar.style.width = ((e - s) / duration * 100) + '%';
    bar.title = `${secondsToHMS(s)} ~ ${secondsToHMS(e)}`;
    bar.onclick = () => {
      location.href =
        `/download_clip?video_file=${encodeURIComponent(getPlayableFilename(currentVideoFile))}` +
        `&start=${s.toFixed(2)}&end=${e.toFixed(2)}`;
    };
    tl.appendChild(bar);
  });
}

/** 초 → HH:MM:SS */
function secondsToHMS(sec) {
  const h = Math.floor(sec / 3600),
        m = Math.floor((sec % 3600) / 60),
        s = Math.floor(sec % 60);
  return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':');
}

// 플레이어 진행선 업데이트
document.getElementById('videoPlayer').addEventListener('timeupdate', () => {
  const p = document.getElementById('videoPlayer');
  if (!p.duration) return;
  document.getElementById('timelineProgress').style.left =
    `${(p.currentTime / p.duration * 100)}%`;
});
