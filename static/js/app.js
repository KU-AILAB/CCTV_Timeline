// static/js/app.js

let currentVideoFile = '';

// .sec → .mp4 매핑
function getPlayableFilename(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return ext === 'sec' ? filename.replace(/\.sec$/i, '.mp4') : filename;
}

// 페이지 로드 시 이어 업로드 체크
window.addEventListener('DOMContentLoaded', () => {
  const pending = JSON.parse(localStorage.getItem('pendingUpload'));
  if (pending) {
    const percent = Math.round(pending.uploadedSize / pending.totalSize * 100);
    alert(`업로드가 ${percent}% 진행된 파일이 있습니다. 동일한 파일 선택 시 이어서 업로드를 진행합니다.`);
    document.getElementById('videoFile')
      .addEventListener('change', event => {
        const file = event.target.files[0];
        if (file && file.name === pending.filename && file.size === pending.totalSize) {
          resumeUpload(file, pending.sessionId, pending.uploadedSize);
        } else {
          localStorage.removeItem('pendingUpload');
        }
      }, { once: true });
  }
  loadServerVideos();
});

// 업로드 폼 제출
document.getElementById('uploadForm').addEventListener('submit', handleUpload);

// 서버 영상 목록 로드
async function loadServerVideos() {
  const res = await fetch('/api/videos', { credentials: 'same-origin' });
  const videos = await res.json();
  const container = document.getElementById('serverVideos');
  container.innerHTML = '';
  videos.forEach(v => {
    const item = document.createElement('div');
    item.className = 'video-item';
    item.textContent = v.filename;
    item.addEventListener('click', () => selectServerVideo(v.filename));
    container.appendChild(item);
  });
}

// 서버 영상 선택
function selectServerVideo(filename) {
  currentVideoFile = filename;
  document.getElementById('startTime').value = '00:00:00';
  extractAndDetect(filename);
}

// 프레임 추출 및 탐지 호출
async function extractAndDetect(filename) {
  const startTime = document.getElementById('startTime').value || '00:00:00';
  const res = await fetch('/extract_frames', {
    method: 'POST',
    credentials: 'same-origin',
    body: new URLSearchParams({ video_file: filename, start_time: startTime })
  });
  const data = await res.json();
  const player = document.getElementById('videoPlayer');

  function renderAll() {
    player.removeEventListener('loadedmetadata', renderAll);
    player.removeEventListener('canplaythrough', renderAll);
    displayFramesInTimeline(data.frames, data.frame_times, data.detected_times);
    displayDetectionResults(data.csv, data.json, data.detected_times);
    buildTimelines(data.detected_times, player.duration);
  }

  player.addEventListener('loadedmetadata', renderAll, { once: true });
  player.addEventListener('canplaythrough', renderAll, { once: true });

  const playFile = getPlayableFilename(filename);
  player.src = `/static/uploads/${encodeURIComponent(playFile)}`;
  player.load();

  setTimeout(() => {
    if (!document.getElementById('framesWrapper').children.length) {
      console.warn('Fallback renderAll invoked');
      renderAll();
    }
  }, 1000);
}

// 업로드 처리
async function handleUpload(event) {
  event.preventDefault();
  const file = document.getElementById('videoFile').files[0];
  if (!file) return alert('파일을 선택하세요');

  try {
    const initRes = await fetch('/upload/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, total_size: file.size })
    });
    const initData = await initRes.json();

    localStorage.setItem('pendingUpload', JSON.stringify({
      sessionId: initData.session_id,
      filename: file.name,
      totalSize: file.size,
      uploadedSize: initData.uploaded_size
    }));

    await uploadChunks(file, initData.session_id, initData.uploaded_size);

    localStorage.removeItem('pendingUpload');
    onUploadComplete(file.name);

  } catch (err) {
    console.error('업로드 처리 중 에러:', err);
    alert('업로드 중 오류가 발생했습니다.');
  }
}

// 이어 업로드 재개
async function resumeUpload(file, sessionId, offset) {
  updateProgressBar(Math.round(offset / file.size * 100));
  await uploadChunks(file, sessionId, offset);
  localStorage.removeItem('pendingUpload');
  onUploadComplete(file.name);
}

// 청크 업로드
async function uploadChunks(file, sessionId, offset) {
  const chunkSize = 1024 * 1024;
  let uploaded = offset;

  while (uploaded < file.size) {
    const end = Math.min(uploaded + chunkSize, file.size);
    const chunk = file.slice(uploaded, end);
    const form = new FormData();
    form.append('session_id', sessionId);
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

    const pending = JSON.parse(localStorage.getItem('pendingUpload') || '{}');
    if (pending.sessionId === sessionId) {
      pending.uploadedSize = uploaded;
      localStorage.setItem('pendingUpload', JSON.stringify(pending));
    }
  }
}

// 진행률 바 업데이트
function updateProgressBar(percent) {
  const bar = document.getElementById('uploadProgress');
  if (bar) bar.style.width = `${percent}%`;
}

// 업로드 완료 후 자동 프레임 추출
async function onUploadComplete(filename) {
  currentVideoFile = filename;
  const startTime = document.getElementById('startTime').value || '00:00:00';
  const res = await fetch('/extract_frames', {
    method: 'POST',
    credentials: 'same-origin',
    body: new URLSearchParams({ video_file: filename, start_time: startTime })
  });
  const data = await res.json();

  const player = document.getElementById('videoPlayer');
  const playFile = getPlayableFilename(filename);
  setVideoSource(`/static/uploads/${encodeURIComponent(playFile)}`);

  displayFramesInTimeline(data.frames, data.frame_times, data.detected_times);
  displayDetectionResults(data.csv, data.json, data.detected_times);
  buildTimelines(data.detected_times, player.duration);
}

// 비디오 소스 설정
function setVideoSource(path) {
  const player = document.getElementById('videoPlayer');
  const source = document.getElementById('videoSource');
  source.src = path;
  source.type = 'video/mp4';
  player.load();
}

// 타임라인 프레임 표시
function displayFramesInTimeline(frames, frameTimes, detectedTimes = []) {
  const wrapper = document.getElementById('framesWrapper');
  wrapper.innerHTML = '';
  const detectedSet = new Set(detectedTimes.map(t => Math.floor(t)));
  const base = currentVideoFile.split('.').slice(0, -1).join('.');

  frames.forEach((frame, i) => {
    const div = document.createElement('div');
    div.classList.add('timeline-frame');
    if (detectedSet.has(Math.floor(frameTimes[i]))) {
      div.classList.add('detected-frame');
    }
    const img = document.createElement('img');
    img.src = `/static/frames/${encodeURIComponent(base)}/${encodeURIComponent(frame)}`;
    img.alt = `Frame at ${frameTimes[i]}s`;
    div.appendChild(img);
    div.addEventListener('click', () => {
      document.getElementById('videoPlayer').currentTime = frameTimes[i];
    });
    wrapper.appendChild(div);
  });
}

// 초 → HH:MM:SS 변환
function secondsToHMS(sec) {
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  return [h,m,s].map(v => v.toString().padStart(2,'0')).join(':');
}

// 재생 진행선 이동
document.getElementById('videoPlayer').addEventListener('timeupdate', () => {
  const player = document.getElementById('videoPlayer');
  if (!player.duration) return;
  const pct = (player.currentTime / player.duration) * 100;
  document.getElementById('timelineProgress').style.left = `${pct}%`;
});

// 탐지 결과 표시
function displayDetectionResults(csvPath, jsonPath, detectedTimes) {
  const div = document.getElementById('detectionResults');
  div.innerHTML = `
    <p><strong>탐지 결과:</strong></p>
    <a href="${csvPath}" download>CSV 다운로드</a><br>
    <a href="${jsonPath}" download>JSON 다운로드</a>
  `;
}

// 타임라인 검출 구간 표시 및 다운로드 링크 생성
function buildTimelines(detectedTimes, duration) {
  const tl = document.getElementById('timelines');
  tl.innerHTML = '';
  const secs = Array.from(new Set(detectedTimes.map(t => Math.floor(t)))).sort((a,b)=>a-b);
  const segments = [];
  if (secs.length) {
    let start = secs[0], prev = secs[0];
    for (let s of secs.slice(1)) {
      if (s - prev <= 1) {
        prev = s;
      } else {
        segments.push([start, prev+1]);
        start = prev = s;
      }
    }
    segments.push([start, prev+1]);
  }
  segments.forEach(([s,e]) => {
    const bar = document.createElement('div');
    bar.className = 'segment-detected';
    bar.style.left  = (s/duration*100)+'%';
    bar.style.width = ((e-s)/duration*100)+'%';
    bar.title = `${secondsToHMS(s)}~${secondsToHMS(e)}`;
    bar.addEventListener('click', () => {
      const vf = encodeURIComponent(currentVideoFile);
      location.href = `/download_clip?video_file=${vf}&start=${s.toFixed(2)}&end=${e.toFixed(2)}`;
    });
    tl.appendChild(bar);
  });
}
