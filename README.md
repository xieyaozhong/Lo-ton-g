# 雨境｜定位降雨預警 PWA

線上版：https://xieyaozhong.github.io/Lo-ton-g/

一個不需要 API Key 的定位降雨預警原型。它以使用者位置為中心，取樣中心點與指定半徑邊界八個方向，找出最早達到降雨門檻的時間與方向。

## 功能

- 瀏覽器定位與移動追蹤
- 1–30 公里偵測半徑
- 中心＋八方向同步取樣
- 每 15 分鐘降水預估與未來 3 小時圖表
- 可調降雨門檻與提前通知時間
- 每 5 分鐘自動更新
- 可安裝為 PWA
- 網頁開啟或 PWA 在前景時可發送系統通知

## 電腦快速啟動

1. 確認已安裝 Python 3。
2. Windows 雙擊 `啟動_雨境.bat`；其他系統執行 `python server.py`。
3. 瀏覽器開啟啟動視窗顯示的網址（通常是 `http://localhost:8765`）。
4. 按「開始偵測」並允許位置權限。

也可在此資料夾執行：

```bash
python -m http.server 8765
```

## 放到手機使用

手機瀏覽器的定位與通知通常要求 HTTPS。可把整個資料夾部署到 GitHub Pages、Cloudflare Pages、Netlify 或其他 HTTPS 靜態網站，再用 Safari／Chrome 開啟並加入主畫面。

### iPhone 注意

- 建議先「加入主畫面」後，以主畫面圖示開啟。
- 通知必須由使用者按鈕主動授權。
- 純網頁無法保證在 App 完全關閉後持續每 5 分鐘執行。要做到真正背景常駐預警，需要原生 App，或伺服器定期查詢後透過 Web Push／APNs 發送。

## 技術與判定

- 資料來源：Open-Meteo Forecast API
- API 使用 `minutely_15=precipitation,rain,weather_code`
- 一次傳送九組經緯度，找出最早達到門檻的取樣點
- 時間使用 Unix timestamp，前端轉為使用者裝置本地時間
- 「信心參考」取最接近該時段的逐小時降雨機率；若該模式無資料，顯示「模式雨量」

## 精度限制

15 分鐘資料在部分地區可能由逐小時模式內插，且預報格點解析度通常比 1–5 公里範圍更粗。這個版本適合當作生活提醒，不應取代中央氣象署警特報或防災決策。

## GitHub Pages 部署

此儲存庫已包含 `.github/workflows/pages.yml`。推送到 `main` 後會自動建立並部署靜態網站。
