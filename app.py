import os, cv2, json, logging, tempfile, shutil, pandas as pd, subprocess
from datetime import timedelta
from flask import Flask, request, jsonify, render_template, redirect, url_for, flash, send_from_directory, send_file, current_app
from ultralytics import YOLO
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from collections import defaultdict

# ── 설정 ─────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
app = Flask(__name__, static_folder='static')
app.secret_key = 'your-secret-key'
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024**3
BASE = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE,'static','uploads')
FRAME_FOLDER  = os.path.join(BASE,'static','frames')
DETECT_FOLDER = os.path.join(BASE,'static','detections')
os.makedirs(UPLOAD_FOLDER,exist_ok=True)
os.makedirs(FRAME_FOLDER,exist_ok=True)
os.makedirs(DETECT_FOLDER,exist_ok=True)

# ── 모델 로드 ─────────────────────────────────────────────────
model = YOLO('/home/mini/CCTV_Timeline_v2/all_yolo11x_imgsz640_orgin.pt')

# ── DB & 로그인 ─────────────────────────────────────────────
app.config['SQLALCHEMY_DATABASE_URI']='mysql+pymysql://cctv_user:cctvPass2025@localhost/mini?charset=utf8mb4'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS']=False
db=SQLAlchemy(app)
login=LoginManager(app)
login.login_view='login'

class User(UserMixin, db.Model):
    __tablename__='users'
    id=db.Column(db.Integer,primary_key=True)
    username=db.Column(db.String(150),unique=True,nullable=False)
    password_hash=db.Column(db.Text,nullable=False)
    progress=db.Column(db.Float,default=0.0)
    videos=db.relationship('Video',backref='user',cascade='all,delete-orphan')
    sessions=db.relationship('UploadSession',backref='user',cascade='all,delete-orphan')
    def set_password(self,p): self.password_hash=generate_password_hash(p)
    def check_password(self,p): return check_password_hash(self.password_hash,p)

class Video(db.Model):
    __tablename__='videos'
    id=db.Column(db.Integer,primary_key=True)
    user_id=db.Column(db.Integer,db.ForeignKey('users.id',ondelete='CASCADE'),nullable=False)
    filename=db.Column(db.String(255),nullable=False)
    progress=db.Column(db.Float,default=0.0)
    created_at=db.Column(db.DateTime,default=db.func.current_timestamp())

class UploadSession(db.Model):
    __tablename__='upload_sessions'
    id=db.Column(db.Integer,primary_key=True)
    user_id=db.Column(db.Integer,db.ForeignKey('users.id',ondelete='CASCADE'),nullable=True)
    filename=db.Column(db.String(255),nullable=False)
    total_size=db.Column(db.BigInteger,nullable=False)
    uploaded_size=db.Column(db.BigInteger,default=0)
    created_at=db.Column(db.DateTime,default=db.func.current_timestamp())

with app.app_context():
    db.create_all()

@login.user_loader
def load_user(uid):
    return User.query.get(int(uid))

# ── 유틸 ─────────────────────────────────────────────────────
def allowed_file(fn):
    return '.' in fn and fn.rsplit('.',1)[1].lower() in {'mp4','avi','mov','mkv','wmv','flv','webm','mpeg','mpg','ts','m2ts','m4v','sec'}
def convert_time_to_seconds(t): h,m,s=t.split(':'); return int(h)*3600+int(m)*60+float(s)
def format_seconds_to_hms(sec): h=int(sec//3600);m=int((sec%3600)//60);s=int(sec%60);return f"{h:02d}:{m:02d}:{s:02d}"

def convert_sec_to_mp4_ffmpeg(sec_path,mp4_path):
    cmd=['ffmpeg','-y','-fflags','+genpts','-copyts','-start_at_zero','-f','h264','-i',sec_path,'-c:v','libx264','-preset','fast','-crf','23','-movflags','+faststart',mp4_path]
    try: subprocess.run(cmd,check=True); logging.info(f".sec→.mp4 완료 {mp4_path}")
    except Exception as e: logging.error(e)

def split_video_segment(inp,outp,start,end):
    root,ext=os.path.splitext(outp); tmp=f"{root}_tmp{ext}"
    dur=(end-start) if end is not None else None
    cmd=['ffmpeg','-y','-ss',f"{start:.3f}",'-i',inp]
    if dur is not None: cmd+=['-t',f"{dur:.3f}"]
    if inp.lower().endswith('.mp4'):
        cmd+=['-c','copy','-movflags','+faststart',tmp]
    else:
        cmd+=['-c:v','libx264','-preset','fast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart',tmp]
    subprocess.run(cmd,check=True); os.replace(tmp,outp)

def group_contiguous_ranges(times,max_gap=5):
    if not times: return []
    ranges=[]; start=prev=times[0]
    for t in times[1:]:
        if t-prev<=max_gap+1: prev=t
        else: ranges.append((start,prev)); start=prev=t
    ranges.append((start,prev)); return ranges

def extract_frames(video_path,output_folder,offset_sec=0):
    if os.path.exists(output_folder): shutil.rmtree(output_folder)
    os.makedirs(output_folder,exist_ok=True)
    cap=cv2.VideoCapture(video_path)
    if not cap.isOpened(): raise ValueError("비디오 열기 실패")
    cap.set(cv2.CAP_PROP_POS_MSEC,offset_sec*1000)
    fps=cap.get(cv2.CAP_PROP_FPS) or 30
    interval=int(fps);count=0;saved=[];times=[]
    while True:
        ret,frame=cap.read()
        if not ret: break
        if count%interval==0:
            t=offset_sec+(count/fps)
            name=f"frame_{int((offset_sec*fps)+count)}.jpg"
            cv2.imwrite(os.path.join(output_folder,name),frame)
            saved.append(name); times.append(t)
        count+=1
    cap.release(); return saved,times,fps

def detect_animals(frames_folder,fps,video_name,offset_sec=0):
    buckets=defaultdict(set)
    files=sorted(os.listdir(frames_folder), key=lambda x:int(x.split('_')[1].split('.')[0]))
    for fname in files:
        idx=int(fname.split('_')[1].split('.')[0])
        t=idx/fps-offset_sec
        if t<0: continue
        frame=cv2.imread(os.path.join(frames_folder,fname))
        if frame is None: continue
        dets=model(frame)[0].boxes.data.cpu().numpy()
        for *_,conf,cid in dets:
            if conf>0.2: buckets[model.names[int(cid)]].add(int(t))
    merged=[]
    for animal,tms in buckets.items():
        for s,e in group_contiguous_ranges(sorted(tms)):
            merged.append({'time':f"{format_seconds_to_hms(s)}-{format_seconds_to_hms(e)}",'animal':animal})
    df=pd.DataFrame(merged)
    csv_p=os.path.join(DETECT_FOLDER,f"{video_name}_results.csv")
    json_p=os.path.join(DETECT_FOLDER,f"{video_name}_results.json")
    df.to_csv(csv_p,index=False,encoding='utf-8')
    with open(json_p,'w',encoding='utf-8') as f: json.dump(merged,f,ensure_ascii=False,indent=2)
    return csv_p,json_p

def get_detected_times_from_csv(csv_path):
    if not os.path.exists(csv_path): return []
    df=pd.read_csv(csv_path)
    if "time" not in df: return []
    secs=set()
    for t in df["time"]:
        t=str(t).strip()
        if '-' in t:
            a,b=[x.strip() for x in t.split('-',1)]
            s=convert_time_to_seconds(a); e=convert_time_to_seconds(b)
            secs.update(range(int(s),int(e)+1))
        else:
            secs.add(int(convert_time_to_seconds(t)))
    return sorted(secs)

# ── 서비스 워커 ─────────────────────────────────────────
@app.route('/sw.js')
def service_worker():
    return send_from_directory(os.path.join(app.root_path,'static/js'),'sw.js',mimetype='application/javascript')

# ── 인증 라우트 ─────────────────────────────────────────
@app.route('/signup',methods=['GET','POST'])
def signup():
    if request.method=='POST':
        u=request.form['username']; p=request.form['password']
        if User.query.filter_by(username=u).first(): flash('이미 존재'); return redirect(url_for('signup'))
        usr=User(username=u); usr.set_password(p); db.session.add(usr); db.session.commit()
        login_user(usr); return redirect(url_for('index'))
    return render_template('signup.html')

@app.route('/login',methods=['GET','POST'])
def login():
    if request.method=='POST':
        u=request.form['username']; p=request.form['password']
        usr=User.query.filter_by(username=u).first()
        if usr and usr.check_password(p): login_user(usr); return redirect(url_for('index'))
        flash('로그인 실패'); return redirect(url_for('login'))
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user(); return redirect(url_for('login'))

# ── 메인 ─────────────────────────────────────────────────
@app.route('/')
def index(): return render_template('index.html')

# ── 서버 영상 목록 ───────────────────────────────────────
@app.route('/api/videos')
@login_required
def get_server_videos():
    files=[f for f in os.listdir(UPLOAD_FOLDER) if os.path.isfile(os.path.join(UPLOAD_FOLDER,f)) and allowed_file(f) and not f.lower().endswith('.sec')]
    files.sort(key=lambda fn:os.path.getmtime(os.path.join(UPLOAD_FOLDER,fn)),reverse=True)
    return jsonify([{'filename':fn} for fn in files])

# ── 업로드 init ─────────────────────────────────────────
@app.route('/upload/init',methods=['POST'])
def upload_init():
    data=request.get_json()
    sess=UploadSession(user_id=current_user.id if current_user.is_authenticated else None,
                       filename=data['filename'],
                       total_size=data['total_size'])
    db.session.add(sess); db.session.commit()
    if sess.user_id:
        vid=Video(user_id=sess.user_id,filename=sess.filename)
        db.session.add(vid); db.session.commit()
    return jsonify({'session_id':sess.id,'uploaded_size':0,'total_size':sess.total_size})

# ── 업로드 chunk ────────────────────────────────────────
@app.route('/upload/chunk',methods=['POST'])
def upload_chunk():
    sess=UploadSession.query.get(request.form['session_id'])
    if not sess: return jsonify({'error':'invalid session'}),400
    offset=int(request.form.get('offset',0))
    part=os.path.join(UPLOAD_FOLDER,f"{sess.id}_{sess.filename}.part")
    os.makedirs(os.path.dirname(part),exist_ok=True)
    mode='r+b' if os.path.exists(part) else 'wb'
    with open(part,mode) as f:
        f.seek(offset); f.write(request.files['chunk'].read())
    sess.uploaded_size=os.path.getsize(part)
    pct=sess.uploaded_size/sess.total_size*100
    if sess.user: sess.user.progress=pct
    vid=Video.query.filter_by(user_id=sess.user_id,filename=sess.filename).first()
    if vid: vid.progress=pct
    db.session.commit()
    if sess.uploaded_size>=sess.total_size:
        final=os.path.join(UPLOAD_FOLDER,sess.filename)
        os.replace(part,final)
        if sess.filename.lower().endswith('.sec'):
            convert_sec_to_mp4_ffmpeg(final,final.rsplit('.',1)[0]+'.mp4')
        sess.user.progress=100.0
        if vid: vid.progress=100.0
        db.session.delete(sess); db.session.commit()
    return jsonify({'uploaded_size':sess.uploaded_size,'progress':pct})

# ── 프레임 추출 & 검출 ────────────────────────────────────
@app.route('/extract_frames',methods=['POST'])
@login_required
def extract_frames_api():
    vf=request.form.get('video_file'); st=request.form.get('start_time','00:00:00')
    if not vf: return jsonify({'error':'No video file'}),400
    offset=convert_time_to_seconds(st)
    src=os.path.join(UPLOAD_FOLDER,vf)
    if vf.lower().endswith('.sec'):
        mp4=f"{vf.rsplit('.',1)[0]}.mp4"
        mp4p=os.path.join(UPLOAD_FOLDER,mp4)
        if not os.path.exists(mp4p): convert_sec_to_mp4_ffmpeg(src,mp4p)
        src, vf = mp4p, mp4
    name=vf.rsplit('.',1)[0]; out=os.path.join(FRAME_FOLDER,name)
    current_user.progress=30; db.session.commit()
    frames, fts, fps = extract_frames(src,out,offset)
    fts=[t-offset for t in fts]
    current_user.progress=60; db.session.commit()
    csvp, jsonp = detect_animals(out,fps,name,offset)
    times = get_detected_times_from_csv(csvp)
    segments=[]
    for s,e in group_contiguous_ranges(times):
        abs_s=offset+s; abs_e=offset+e
        seg_name=f"{name}_{format_seconds_to_hms(abs_s)}_{format_seconds_to_hms(abs_e)}.mp4"
        dest=os.path.join(DETECT_FOLDER,seg_name)
        split_video_segment(src,dest,abs_s,abs_e)
        segments.append(seg_name)
    current_user.progress=100; db.session.commit()
    return jsonify({
        'frames':frames,
        'frame_times':fts,
        'detected_times':times,
        'csv': url_for('static',filename=f"detections/{os.path.basename(csvp)}"),
        'json':url_for('static',filename=f"detections/{os.path.basename(jsonp)}"),
        'segments':segments
    })

# ── 클립 다운로드 ─────────────────────────────────────────
@app.route('/download_clip')
def download_clip():
    vf=request.args.get('video_file'); st=float(request.args.get('start',0)); ed=float(request.args.get('end',0))
    if not vf: return jsonify({'error':'video_file 누락'}),400
    base,ext=os.path.splitext(vf)
    if ext.lower() in {'.sec','.avi'}:
        alt=f"{base}.mp4"
        if os.path.exists(os.path.join(UPLOAD_FOLDER,alt)): vf=alt
    src=os.path.join(UPLOAD_FOLDER,vf)
    if not os.path.exists(src): return jsonify({'error':'파일 없음'}),404
    tmp=tempfile.NamedTemporaryFile(suffix='.mp4',delete=False); tmp.close()
    split_video_segment(src,tmp.name,st,ed)
    dl=f"{base}_{st:.2f}-{ed:.2f}.mp4"
    resp=send_file(tmp.name,as_attachment=True,download_name=dl)
    @resp.call_on_close
    def _cleanup(): os.remove(tmp.name)
    return resp

# ── 내 업로드 목록 ─────────────────────────────────────────
@app.route('/my_uploads')
@login_required
def my_uploads():
    ups=Video.query.filter_by(user_id=current_user.id).order_by(Video.created_at.desc()).all()
    return render_template('my_uploads.html',uploads=ups)

if __name__ == "__main__":
    # 디버그 모드 + 리로더 켜기
    app.run(
        host="0.0.0.0",
        port=2311,
        debug=True,        # debug=True 가 reloader=True 를 포함합니다
        # use_reloader=True  # (명시적으로 켜고 싶으면 uncomment)
    )

