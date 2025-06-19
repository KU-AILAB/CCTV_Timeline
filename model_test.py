import pandas as pd
from datetime import timedelta

# CSV 파일 경로 지정
file_path = "/home/sjy/0529video/CCTV_Timeline_v2/03441313_1300_final.csv"  # 실제 파일 경로로 변경 필요

# 시간 변환 함수
def to_timedelta(time_str):
    h, m, s = map(int, time_str.strip().split(":"))
    return timedelta(hours=h, minutes=m, seconds=s)

# CSV 불러오기
df = pd.read_csv(file_path)

# 예측 시작 시간 추출 및 변환
pred_times = df['time1'].dropna().apply(lambda x: to_timedelta(x.split('-')[0]))
# GT 시작 시간 변환
gt_times = df['time2'].dropna().apply(to_timedelta)

# 허용 오차 범위
tolerance = timedelta(seconds=60)

# GT별로 정확히 예측된 것이 있는지 확인
def is_detected(gt_time):
    return any(abs(gt_time - pred) <= tolerance for pred in pred_times)

# 평가 수행
results = gt_times.apply(is_detected)

# 정확도 계산
accuracy = results.mean()

# 결과 출력
print(f"±5초 기준 ground truth 정탐률: {accuracy:.2%}")
