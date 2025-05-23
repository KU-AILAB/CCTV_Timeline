let currentVideoFile = '';

/**
 * HH:MM:SS → 초 환산
 */
function hms2sec(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + Number(s);
}

/**
 * .sec/.avi → .mp4 매핑
 */
function getPlayableFilename(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'sec' || ext === 'avi') {
    return filename.replace(/\.(sec|avi)$/i, '.mp4');
  }
  return filename;
}

// 페이지 로드 시
window.addEventListener('DOMContentLoaded', () => {
  // 1) 이어 업로드 재개 체크
  const pending = JSON.parse(localStorage.getItem('pendingUpload'));
  if (pending) {
    const pct = Math.round(pending.uploadedSize / pending.totalSize * 100);
    alert(`업로드가 ${pct}% 진행된 파일이 있습니다.\n동일한 파일 선택 시 이어서 업로드합니다.`);
    document.getElementById('videoFile')
      .addEventListener('change', e => {
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

  // 3) 검출 없이 업로드 버튼
  document.getElementById('uploadOnlyBtn')
          .addEventListener('click', uploadOnly);

  // 4) 일반 업로드 & 검출 폼
  document.getElementById('uploadForm')
          .addEventListener('submit', handleUpload);
});

/**
 * 서버 영상 목록 조회 & 테이블 렌더링
 */
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

/**
 * 서버 영상 선택 → 검출 로직
 */
function selectServerVideo(filename) {
  currentVideoFile = filename;
  document.getElementById('startTime').value = '00:00:00';
  extractAndDetect(filename);
}

/**
 * "검출 없이 업로드" 버튼 핸들러
 */
async function uploadOnly() {
  const file = document.getElementById('videoFile').files[0];
  if (!file) return alert('파일을 선택하세요');
  try {
    const initRes = await fetch('/upload/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({filename:file.name, total_size:file.size})
    });
    const { session_id, uploaded_size } = await initRes.json();
    localStorage.setItem('pendingUpload', JSON.stringify({
      sessionId: session_id,
      filename:  file.name,
      totalSize: file.size,
      uploadedSize: uploaded_size
    }));
    await uploadChunks(file, session_id, uploaded_size);
    localStorage.removeItem('pendingUpload');
    alert('영상 업로드가 완료되었습니다.');
    loadServerVideos();
  } catch(err) {
    console.error(err);
    alert('업로드 중 오류가 발생했습니다.');
  }
}

/**
 * 업로드 + 검출 폼 제출 핸들러
 */
async function handleUpload(e) {
  e.preventDefault();
  const file = document.getElementById('videoFile').files[0];
  if (!file) return alert('파일을 선택하세요');
  try {
    const initRes = await fetch('/upload/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({filename:file.name, total_size:file.size})
    });
    const { session_id, uploaded_size } = await initRes.json();
    localStorage.setItem('pendingUpload', JSON.stringify({
      sessionId: session_id,
      filename:  file.name,
      totalSize: file.size,
      uploadedSize: uploaded_size
    }));
    await uploadChunks(file, session_id, uploaded_size);
    localStorage.removeItem('pendingUpload');
    onUploadComplete(file.name);
  } catch(err) {
    console.error(err);
    alert('업로드 처리 중 오류가 발생했습니다.');
  }
}

/**
 * 이어 업로드 재개
 */
async function resumeUpload(file, sessId, offset) {
  updateProgressBar(Math.round(offset / file.size * 100));
  await uploadChunks(file, sessId, offset);
  localStorage.removeItem('pendingUpload');
  onUploadComplete(file.name);
}

/**
 * 청크 단위 업로드
 */
async function uploadChunks(file, sessId, offset) {
  const chunkSize = 1024 * 1024;
  let uploaded = offset;
  while (uploaded < file.size) {
    const end   = Math.min(uploaded + chunkSize, file.size);
    const chunk = file.slice(uploaded, end);
    const form  = new FormData();
    form.append('session_id', sessId);
    form.append('offset', uploaded);
    form.append('chunk', chunk);
    const res = await fetch('/upload/chunk', {
      method:'POST', credentials:'same-origin', body:form
    });
    const data = await res.json();
    uploaded = data.uploaded_size;
    updateProgressBar(data.progress);
    const pending = JSON.parse(localStorage.getItem('pendingUpload') || '{}');
    if (pending.sessionId === sessId) {
      pending.uploadedSize = uploaded;
      localStorage.setItem('pendingUpload', JSON.stringify(pending));
    }
  }
}

/**
 * 진행률 바 업데이트
 */
function updateProgressBar(percent) {
  const bar = document.getElementById('uploadProgress');
  if (bar) bar.style.width = `${percent}%`;
}

/**
 * 프레임 추출 & 탐지 API 호출
 */
async function extractAndDetect(filename) {
  // 숨김 처리
  document.getElementById('detectionSection').classList.add('d-none');

  const startTime = document.getElementById('startTime').value || '00:00:00';
  const res = await fetch('/extract_frames', {
    method:'POST',
    credentials:'same-origin',
    body: new URLSearchParams({video_file: filename, start_time: startTime})
  });
  const data = await res.json();

  const player = document.getElementById('videoPlayer');
  player.addEventListener('loadedmetadata', () => {
    player.currentTime = hms2sec(startTime);
  }, { once: true });

  function renderAll() {
    displayFramesInTimeline(data.frames, data.frame_times, data.detected_times);
    displayDetectionResults(data.csv, data.json, data.detected_times);
    buildTimelines(data.detected_times, player.duration);
  }
  player.addEventListener('loadedmetadata', renderAll, { once: true });

  player.src = `/static/uploads/${encodeURIComponent(getPlayableFilename(filename))}`;
  player.load();

  setTimeout(() => {
    if (!document.getElementById('framesWrapper').children.length) {
      console.warn('Fallback renderAll invoked');
      renderAll();
    }
  }, 1000);
}

/**
 * 업로드 완료 후 자동 프레임 추출
 */
async function onUploadComplete(filename) {
  extractAndDetect(filename);
}

/**
 * 프레임 썸네일 뿌리기
 */
function displayFramesInTimeline(frames, frameTimes, detectedTimes=[]) {
  const wrapper = document.getElementById('framesWrapper');
  if (!wrapper) return;
  wrapper.innerHTML = '';
  const detectedSet = new Set(detectedTimes.map(t=>Math.floor(t)));
  const base = currentVideoFile.split('.').slice(0,-1).join('.');
  frames.forEach((f,i)=>{
    const div = document.createElement('div');
    div.classList.add('timeline-frame');
    if (detectedSet.has(Math.floor(frameTimes[i]))) {
      div.classList.add('detected-frame');
    }
    const img = document.createElement('img');
    img.src = `/static/frames/${encodeURIComponent(base)}/${encodeURIComponent(f)}`;
    img.alt = `Frame at ${frameTimes[i]}s`;
    div.appendChild(img);
    div.addEventListener('click', ()=>{
      document.getElementById('videoPlayer').currentTime = frameTimes[i];
    });
    wrapper.appendChild(div);
  });
}

/**
 * 탐지 결과 버튼 활성화
 */
function displayDetectionResults(csvPath, jsonPath, detectedTimes) {
  document.getElementById('csvDownloadBtn').href  = csvPath;
  document.getElementById('jsonDownloadBtn').href = jsonPath;
  document.getElementById('detectionSection').classList.remove('d-none');
}

/**
 * 타임라인 검출 구간 표시
 */
function buildTimelines(detectedTimes, duration) {
  const tl = document.getElementById('timelines');
  tl.innerHTML = '';
  const secs = Array.from(new Set(detectedTimes.map(t=>Math.floor(t))))
                    .sort((a,b)=>a-b);
  const segs = [];
  if (secs.length) {
    let start=secs[0], prev=secs[0];
    secs.slice(1).forEach(s=>{
      if (s - prev <= 1) prev = s;
      else { segs.push([start, prev+1]); start=prev=s; }
    });
    segs.push([start, prev+1]);
  }
  segs.forEach(([s,e])=>{
    const bar = document.createElement('div');
    bar.className = 'segment-detected';
    bar.style.left  = (s/duration*100) + '%';
    bar.style.width = ((e-s)/duration*100) + '%';
    bar.title = `${secondsToHMS(s)}~${secondsToHMS(e)}`;
    bar.addEventListener('click', ()=>{
      const vf = encodeURIComponent(getPlayableFilename(currentVideoFile));
      location.href = `/download_clip?video_file=${vf}&start=${s.toFixed(2)}&end=${e.toFixed(2)}`;
    });
    tl.appendChild(bar);
  });
}

/**
 * 초 → HH:MM:SS
 */
function secondsToHMS(sec) {
  const h = Math.floor(sec/3600),
        m = Math.floor((sec%3600)/60),
        s = Math.floor(sec%60);
  return [h,m,s].map(v=>v.toString().padStart(2,'0')).join(':');
}

/**
 * 플레이어 타임업데이트 → 커서 이동
 */
document.getElementById('videoPlayer').addEventListener('timeupdate', ()=>{
  const player = document.getElementById('videoPlayer');
  if (!player.duration) return;
  const pct = (player.currentTime / player.duration)*100;
  document.getElementById('timelineProgress').style.left = `${pct}%`;
});
