import cv2, sys, json, time

# 人脸跟踪 + 口型近似（2026-11-08）
# 输出：每 1/fps 秒一帧的人脸框、5 关键点派生的嘴部区域、以及两个运动量：
#   faceMotion = 脸框内的帧间平均差（整张脸在动多少）
#   mouthMotion = 嘴部区域内的帧间平均差（说话时这里最活跃）
# 只有这两个数，不做表情/身份判断。
path = sys.argv[1]
fps = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
max_s = float(sys.argv[3]) if len(sys.argv) > 3 else 0
model = sys.argv[4] if len(sys.argv) > 4 else '/home/dsh/.data/face-models/yunet.onnx'

cap = cv2.VideoCapture(path)
if not cap.isOpened():
    print(json.dumps({'error': 'cannot open video'}))
    sys.exit(2)
src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
step = max(1, int(round(src_fps / max(0.5, fps))))
w0 = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h0 = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
det = cv2.FaceDetectorYN.create(model, '', (w0, h0), 0.6, 0.3, 500)
det.setInputSize((w0, h0))

frames = []
prev_gray = None
idx = 0
t0 = time.time()

def region_motion(gray, prev, x0, y0, x1, y1):
    if prev is None:
        return 0.0
    xa, ya = max(0, int(x0)), max(0, int(y0))
    xb, yb = min(gray.shape[1], int(x1)), min(gray.shape[0], int(y1))
    if xb <= xa or yb <= ya:
        return 0.0
    d = cv2.absdiff(gray[ya:yb, xa:xb], prev[ya:yb, xa:xb])
    return round(float(d.mean()) / 255.0, 4)

while True:
    ok, frame = cap.read()
    if not ok:
        break
    t = idx / src_fps
    if max_s > 0 and t > max_s:
        break
    if idx % step == 0:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        n, faces = det.detect(frame)
        row = {'t': round(t, 2), 'faces': []}
        if faces is not None:
            for f in faces:
                x, y, w, h = [float(v) for v in f[:4]]
                lm = [float(v) for v in f[4:14]]
                # YuNet 关键点顺序：右眼(0,1) 左眼(2,3) 鼻尖(4,5) 右嘴角(6,7) 左嘴角(8,9)
                mx1, my1 = lm[6], lm[7]
                mx2, my2 = lm[8], lm[9]
                mx = min(mx1, mx2)
                mw = max(2.0, abs(mx2 - mx1) * 1.25)
                my = min(my1, my2) - h * 0.06
                mh = max(4.0, h * 0.24)
                row['faces'].append({
                    'box': [round(x, 1), round(y, 1), round(w, 1), round(h, 1)],
                    'score': round(float(f[-1]), 3),
                    'faceMotion': region_motion(gray, prev_gray, x, y, x + w, y + h),
                    'mouthMotion': region_motion(gray, prev_gray, mx, my, mx + mw, my + mh),
                })
        frames.append(row)
        prev_gray = gray
    idx += 1

cap.release()
print(json.dumps({'fps': fps, 'srcFps': round(src_fps, 2), 'frames': frames, 'elapsed': round(time.time() - t0, 2)}))
