# app.py

# ── 공통 모듈/라이브러리 임포트 ───────────────────────────────
import os
import cv2
import json
import logging
import tempfile
import shutil
import pandas as pd
import subprocess  # ffmpeg 호출
from datetime import timedelta
from flask import (
    Flask, request, jsonify,
    render_template, redirect,
    url_for, flash,
    send_from_directory, send_file
)
from ultralytics import YOLO
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin,
    login_user, logout_user,
    login_required, current_user
)
from werkzeug.security import (
    generate_password_hash,
    check_password_hash
)
from collections import defaultdict

# ── 로깅 설정 ───────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)

# ── Flask 앱 초기화 ────────────────────────────────────────
app = Flask(__name__, static_folder='static')
app.secret_key = 'your-secret-key'
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024**3  # 20GB

# ── 업로드/프레임/탐지 폴더 설정 ────────────────────────────
BASE_DIR         = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER    = os.path.join(BASE_DIR, 'static', 'uploads')
FRAME_FOLDER     = os.path.join(BASE_DIR, 'static', 'frames')
DETECTION_FOLDER = os.path.join(BASE_DIR, 'static', 'detections')

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(FRAME_FOLDER, exist_ok=True)
os.makedirs(DETECTION_FOLDER, exist_ok=True)

# ── YOLO 모델 로드 ───────────────────────────────────────
MODEL_PATH = 'waterdeer.pt'
model = YOLO(MODEL_PATH)

# ── 데이터베이스 설정 ─────────────────────────────────────
app.config['SQLALCHEMY_DATABASE_URI'] = (
    'mysql+pymysql://cctv_user:cctvPass2025@localhost/mini?charset=utf8mb4'
)
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

# ── 로그인 매니저 설정 ────────────────────────────────────
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# ── DB 모델 정의 ───────────────────────────────────────────
class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id               = db.Column(db.Integer, primary_key=True)
    username         = db.Column(db.String(150), unique=True, nullable=False)
    password_hash    = db.Column(db.Text,    nullable=False)
    email            = db.Column(db.String(150), unique=True)
    created_at       = db.Column(db.DateTime, default=db.func.current_timestamp())
    progress         = db.Column(db.Float,   default=0.0)
    videos           = db.relationship('Video', backref='user', cascade='all, delete-orphan')
    upload_sessions  = db.relationship('UploadSession', backref='user', cascade='all, delete-orphan')

    def set_password(self, pwd):
        self.password_hash = generate_password_hash(pwd)

    def check_password(self, pwd):
        return check_password_hash(self.password_hash, pwd)

class Video(db.Model):
    __tablename__ = 'videos'
    id          = db.Column(db.Integer, primary_key=True)
    user_id     = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    filename    = db.Column(db.String(255), nullable=False)
    progress    = db.Column(db.Float, default=0.0)
    created_at  = db.Column(db.DateTime, default=db.func.current_timestamp())

class UploadSession(db.Model):
    __tablename__ = 'upload_sessions'
    id            = db.Column(db.Integer, primary_key=True)
    user_id       = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=True)
    filename      = db.Column(db.String(255), nullable=False)
    total_size    = db.Column(db.BigInteger, nullable=False)
    uploaded_size = db.Column(db.BigInteger, default=0)
    created_at    = db.Column(db.DateTime, default=db.func.current_timestamp())

with app.app_context():
    db.create_all()

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ── 유틸리티 함수 ───────────────────────────────────────────
def allowed_file(filename):
    exts = {
        'mp4','avi','mov','mkv','wmv','flv','webm',
        'mpeg','mpg','ts','m2ts','m4v','sec'
    }
    return '.' in filename and filename.rsplit('.',1)[1].lower() in exts

def convert_time_to_seconds(time_str):
    h, m, s = time_str.split(":")
    return int(h)*3600 + int(m)*60 + float(s)

def format_seconds_to_hms(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"

def convert_avi_to_mp4_ffmpeg(avi_path, mp4_path):
    cmd = ['ffmpeg','-y','-i',avi_path,'-c:v','libx264','-preset','fast','-crf','23',mp4_path]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        logging.error(f"AVI→MP4 변환 실패: {e}")

# ── 추가: .sec → .mp4 컨테이너 변환 ─────────────────────────────
def convert_sec_to_mp4_ffmpeg(sec_path, mp4_path):
    cmd = [
        'ffmpeg', '-y',
        '-fflags', '+genpts',
        '-copyts',
        '-start_at_zero',
        '-f', 'h264',
        '-i', sec_path,
        '-c:v', 'libx264',    # re-encode video
        '-preset', 'fast',
        '-crf', '23',
        '-movflags', '+faststart',
        mp4_path
    ]
    try:
        subprocess.run(cmd, check=True)
        logging.info(f".sec → .mp4 (re-encode) 변환 완료: {mp4_path}")
    except subprocess.CalledProcessError as e:
        logging.error(f".sec → .mp4 변환 실패: {e}")



import os
import subprocess

def split_video_segment(input_path: str,
                        output_path: str,
                        start_sec: float,
                        end_sec: float | None):
    """
    input_path에서 start_sec부터 end_sec(또는 영상 종료 시점)까지 잘라
    output_path에 저장하는 함수입니다.
    mp4는 key-frame 복사 모드로, 그 외 포맷은 재인코딩 방식으로 처리합니다.
    """
    # 출력용 임시 파일 경로 생성
    root, ext = os.path.splitext(output_path)
    tmp_out = root + '_tmp' + ext

    # 자를 구간 길이 계산
    duration = (end_sec - start_sec) if end_sec is not None else None

    if input_path.lower().endswith('.mp4'):
        # ── key-frame 안전 복사 (빠른 seek) ─────────────────────────
        cmd = [
            'ffmpeg', '-y',
            '-ss', f'{start_sec:.3f}',
            '-i', input_path
        ]
        if duration is not None:
            cmd += ['-t', f'{duration:.3f}']
        cmd += [
            '-c', 'copy',
            '-movflags', '+faststart',
            tmp_out
        ]
    else:
        # ── 재인코딩 모드 ────────────────────────────────────────────
        cmd = [
            'ffmpeg', '-y',
            '-ss', f'{start_sec:.3f}',
            '-i', input_path
        ]
        if duration is not None:
            cmd += ['-t', f'{duration:.3f}']
        cmd += [
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac',     '-b:a', '128k',
            '-movflags', '+faststart',
            tmp_out
        ]

    # ffmpeg 실행
    subprocess.run(cmd, check=True)

    # 임시 파일을 최종 파일로 교체
    os.replace(tmp_out, output_path)



def group_contiguous_ranges(times):
    """
    >>> group_contiguous_ranges([0,1,2,10,11])  →  [(0,2), (10,11)]
    """
    if not times:
        return []

    ranges = []
    start = prev = times[0]
    for t in times[1:]:
        if t == prev + 1:          # 바로 다음 초면 같은 구간
            prev = t
        else:                      # 끊겼으면 구간 종료
            ranges.append((start, prev))
            start = prev = t
    ranges.append((start, prev))
    return ranges


def extract_frames(video_path, output_folder, offset_sec=0):
    if os.path.exists(output_folder):
        shutil.rmtree(output_folder)
    os.makedirs(output_folder, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError("비디오 열기 실패")
    cap.set(cv2.CAP_PROP_POS_MSEC, offset_sec * 1000)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    interval = int(fps)
    count, saved, times = 0, [], []

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if count % interval == 0:
            t = offset_sec + (count / fps)
            name = f"frame_{int((offset_sec*fps)+count)}.jpg"
            path = os.path.join(output_folder, name)
            cv2.imwrite(path, frame)
            saved.append(name)
            times.append(t)
        count += 1

    cap.release()
    return saved, times, fps

# ── 동물 탐지 및 결과 파싱 ─────────────────────────────────
def detect_animals(frames_folder, fps, video_name, offset_sec=0):
    """
    프레임 폴더를 돌면서 탐지된 '로컬 시간(시작=0)'을
    HH:MM:SS-HH:MM:SS 범위로 묶어 CSV/JSON 저장
    """
    buckets = defaultdict(set)          # {animal: {0,1,2,…}}

    files = sorted(
        os.listdir(frames_folder),
        key=lambda x: int(x.split('_')[1].split('.')[0])
    )

    for fname in files:
        idx = int(fname.split('_')[1].split('.')[0])
        t   = idx / fps - offset_sec    # ← 전체 시각 – 오프셋 = 로컬 s
        if t < 0:
            continue                    # 이론상 없지만 안전
        frame = cv2.imread(os.path.join(frames_folder, fname))
        if frame is None:
            continue
        dets = model(frame)[0].boxes.data.cpu().numpy()
        for *_, conf, cid in dets:
            if conf > 0.2:
                buckets[model.names[int(cid)]].add(int(t))

    merged = []
    for animal, times in buckets.items():
        for s, e in group_contiguous_ranges(sorted(times)):
            merged.append({
                'time'  : f"{format_seconds_to_hms(s)}-{format_seconds_to_hms(e)}",
                'animal': animal
            })

    df = pd.DataFrame(merged)

    csv_path  = os.path.join(DETECTION_FOLDER, f"{video_name}_results.csv")
    json_path = os.path.join(DETECTION_FOLDER, f"{video_name}_results.json")

    df.to_csv(csv_path, index=False, encoding='utf-8')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    return csv_path, json_path

def get_detected_times_from_csv(csv_path):
    """
    CSV의 'time' 컬럼에서
      - 단일 시각  → 해당 초 1개
      - 범위 'a-b' → a ~ b 구간 전체
    를 수집해 정렬된 리스트로 반환
    """
    if not os.path.exists(csv_path):
        return []

    df = pd.read_csv(csv_path)
    if "time" not in df.columns:
        return []

    seconds = set()
    for t in df["time"]:
        t = str(t).strip()
        if '-' in t:                                   # 범위형
            start_str, end_str = [x.strip() for x in t.split('-', 1)]
            s = convert_time_to_seconds(start_str)
            e = convert_time_to_seconds(end_str)
            seconds.update(range(int(s), int(e) + 1))  # 끝 초 포함
        else:                                          # 단일 시각
            seconds.add(int(convert_time_to_seconds(t)))

    return sorted(seconds)

# ── 서비스 워커 제공 ───────────────────────────────────────
@app.route('/sw.js')
def service_worker():
    return send_from_directory(
        os.path.join(app.root_path, 'static/js'),
        'sw.js', mimetype='application/javascript'
    )

# ── 인증 관련 라우트 ───────────────────────────────────────
@app.route('/signup', methods=['GET','POST'])
def signup():
    if request.method == 'POST':
        uname = request.form['username']
        pwd   = request.form['password']
        if User.query.filter_by(username=uname).first():
            flash('이미 존재하는 아이디입니다.')
            return redirect(url_for('signup'))
        u = User(username=uname)
        u.set_password(pwd)
        db.session.add(u)
        db.session.commit()
        login_user(u)
        return redirect(url_for('index'))
    return render_template('signup.html')

@app.route('/login', methods=['GET','POST'])
def login():
    if request.method == 'POST':
        uname = request.form['username']
        pwd   = request.form['password']
        u = User.query.filter_by(username=uname).first()
        if u and u.check_password(pwd):
            login_user(u)
            return redirect(url_for('index'))
        flash('아이디 또는 비밀번호가 잘못되었습니다.')
        return redirect(url_for('login'))
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# ── 메인 페이지 ───────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

# ── 서버 영상 목록 조회 ────────────────────────────────────
@app.route('/api/videos')
@login_required
def get_server_videos():
    db_files = {v.filename for v in Video.query.filter_by(user_id=current_user.id)}
    fs = {f for f in os.listdir(UPLOAD_FOLDER) if os.path.isfile(os.path.join(UPLOAD_FOLDER,f)) and allowed_file(f)}
    filtered = set()
    for f in fs:
        base, ext = os.path.splitext(f.lower())
        if ext == '.sec' and os.path.exists(os.path.join(UPLOAD_FOLDER, base + '.mp4')):
            continue
        filtered.add(f)
    all_set = db_files | filtered
    existing = [f for f in all_set if os.path.exists(os.path.join(UPLOAD_FOLDER,f))]
    missing  = sorted(all_set - set(existing))
    existing_sorted = sorted(existing, key=lambda fn: os.path.getmtime(os.path.join(UPLOAD_FOLDER,fn)), reverse=True)
    return jsonify([{'filename':fn} for fn in existing_sorted + missing])

# ── 업로드 초기화 API ───────────────────────────────────────
@app.route('/upload/init', methods=['POST'])
def upload_init():
    data = request.get_json()
    sess = UploadSession(
        user_id=current_user.id if current_user.is_authenticated else None,
        filename=data['filename'],
        total_size=data['total_size']
    )
    db.session.add(sess)
    db.session.commit()
    if sess.user_id:
        vid = Video(user_id=sess.user_id, filename=sess.filename)
        db.session.add(vid)
        db.session.commit()
    return jsonify({
        'session_id': sess.id,
        'uploaded_size': 0,
        'total_size': sess.total_size
    })

# ── 청크 업로드 API ───────────────────────────────────────
# ── 청크 업로드 API ─────────────────────────────────────────
@app.route('/upload/chunk', methods=['POST'])
def upload_chunk():
    sess = UploadSession.query.get(request.form['session_id'])
    if not sess:
        return jsonify({'error': 'invalid session'}), 400

    offset = int(request.form.get('offset', 0))
    part_path = os.path.join(
        UPLOAD_FOLDER, f"{sess.id}_{sess.filename}.part"
    )
    os.makedirs(os.path.dirname(part_path), exist_ok=True)

    mode = 'r+b' if os.path.exists(part_path) else 'wb'
    with open(part_path, mode) as f:
        f.seek(offset)
        f.write(request.files['chunk'].read())

    # ── 진행률 계산 ────────────────────────────────────────
    sess.uploaded_size = os.path.getsize(part_path)
    percent = sess.uploaded_size / sess.total_size * 100

    # User.progress (기존) -------------------------------------------------
    if sess.user:
        sess.user.progress = percent

    # Video.progress (신규) -----------------------------------------------
    if sess.user_id:
        video = Video.query.filter_by(
            user_id=sess.user_id, filename=sess.filename
        ).first()
        if video:
            video.progress = percent

    db.session.commit()

    # ── 업로드 완료 처리 ────────────────────────────────────
    if sess.uploaded_size >= sess.total_size:
        final_path = os.path.join(UPLOAD_FOLDER, sess.filename)
        os.replace(part_path, final_path)

        # 변환 작업 (종전 로직 유지)
        if sess.filename.lower().endswith('.avi'):
            convert_avi_to_mp4_ffmpeg(final_path, final_path.rsplit('.', 1)[0] + '.mp4')
        if sess.filename.lower().endswith('.sec'):
            convert_sec_to_mp4_ffmpeg(final_path, final_path.rsplit('.', 1)[0] + '.mp4')

        # 100 % 로 마무리
        if sess.user:
            sess.user.progress = 100.0
        if sess.user_id and video:
            video.progress = 100.0

        # 세션 레코드 정리(선택) — 필요 없으면 주석 처리
        db.session.delete(sess)

        db.session.commit()

    return jsonify({'uploaded_size': sess.uploaded_size, 'progress': percent})


# ── 프레임 추출 및 탐지 API ─────────────────────────────────
@app.route('/extract_frames', methods=['POST'])
@login_required
def extract_video_frames():
    video_file = request.form.get('video_file')
    start_time = request.form.get('start_time', '00:00:00')
    if not video_file:
        return jsonify({'error': 'No video file'}), 400

    offset = convert_time_to_seconds(start_time)
    src_path = os.path.join(UPLOAD_FOLDER, video_file)

    # .sec 업로드라면 mp4 변환본 사용 (생략 가능: 앞서 구현돼 있으면)
    if video_file.lower().endswith('.sec'):
        mp4_name = os.path.splitext(video_file)[0] + '.mp4'
        mp4_path = os.path.join(UPLOAD_FOLDER, mp4_name)
        if not os.path.exists(mp4_path):
            convert_sec_to_mp4_ffmpeg(src_path, mp4_path)
        src_path   = mp4_path
        video_file = mp4_name

    name    = os.path.splitext(video_file)[0]
    out_dir = os.path.join(FRAME_FOLDER, name)

    current_user.progress = 30; db.session.commit()

    # 프레임/타임스탬프 추출 (frame_times는 오프셋 포함 → 곧 보정)
    frames, frame_times, fps = extract_frames(src_path, out_dir, offset)
    frame_times = [t - offset for t in frame_times]   # ← 0 기준 보정

    current_user.progress = 60; db.session.commit()

    csv_p, json_p = detect_animals(out_dir, fps, name, offset)

    times = get_detected_times_from_csv(csv_p)        # 이미 로컬 s 리스트

    # 세그먼트 파일 생성 (split은 원본 기준 절대 s 필요)
    segments = []
    for s, e in group_contiguous_ranges(times):
        abs_s = offset + s
        abs_e = offset + e
        seg_name = f"{name}_{format_seconds_to_hms(abs_s)}_{format_seconds_to_hms(abs_e)}.mp4"
        dest = os.path.join(DETECTION_FOLDER, seg_name)
        split_video_segment(src_path, dest, abs_s, abs_e)
        segments.append(seg_name)

    current_user.progress = 100; db.session.commit()

    return jsonify({
        'frames': frames,
        'frame_times': frame_times,      # 0부터 시작
        'detected_times': times,
        'csv':  url_for('static', filename=f'detections/{os.path.basename(csv_p)}'),
        'json': url_for('static', filename=f'detections/{os.path.basename(json_p)}'),
        'segments': segments
    })

# ── 클립 다운로드 ─────────────────────────────────────────
@app.route('/download_clip')
def download_clip():
    vf    = request.args.get('video_file')
    start = float(request.args.get('start', 0))
    end   = float(request.args.get('end', 0))

    if not vf:
        return jsonify({'error': 'video_file 누락'}), 400

    # ⬇️ .sec/.avi → .mp4 매핑
    base, ext = os.path.splitext(vf)
    if ext.lower() in {'.sec', '.avi'}:
        alt = base + '.mp4'
        if os.path.exists(os.path.join(UPLOAD_FOLDER, alt)):
            vf = alt   # 변환본 사용

    src = os.path.join(UPLOAD_FOLDER, vf)
    if not os.path.exists(src):
        return jsonify({'error': '파일 없음'}), 404

    tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False); tmp.close()
    split_video_segment(src, tmp.name, start, end)

    dl_name = f"{base}_{start:.2f}-{end:.2f}.mp4"
    resp = send_file(tmp.name, as_attachment=True, download_name=dl_name)

    @resp.call_on_close
    def _cleanup(): os.remove(tmp.name)
    return resp


# ── 내 업로드 목록 페이지 ────────────────────────────────────
@app.route('/my_uploads')
@login_required
def my_uploads():
    uploads = Video.query.filter_by(user_id=current_user.id).all()
    return render_template('my_uploads.html', uploads=uploads)




if __name__ == "__main__":
    app.run(host="0.0.0.0", port=2312, debug=False)
