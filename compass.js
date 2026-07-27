'use strict';

(() => {
  const needle = document.getElementById('miniCompassNeedle');
  const headingText = document.getElementById('compassHeading');
  const statusText = document.getElementById('compassStatus');
  const card = document.getElementById('miniCompassCard');
  const button = document.getElementById('enableCompass');

  if (!needle || !headingText || !statusText || !card || !button) return;

  let listening = false;
  let receivedReading = false;

  function normalize(value) {
    if (!Number.isFinite(value)) return null;
    return (value % 360 + 360) % 360;
  }

  function directionName(heading) {
    const names = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
    return names[Math.round(heading / 45) % 8];
  }

  function showFallback(text = '固定北向參考') {
    card.classList.add('compass-fallback');
    needle.style.transform = 'translate(-50%,-50%) rotate(0deg)';
    headingText.textContent = '北向';
    statusText.textContent = text;
  }

  function update(heading) {
    const normalized = normalize(heading);
    if (normalized === null) return;
    receivedReading = true;
    card.classList.remove('compass-fallback');
    needle.style.transform = `translate(-50%,-50%) rotate(${-normalized}deg)`;
    headingText.textContent = `${directionName(normalized)} ${Math.round(normalized)}°`;
    statusText.textContent = '目前裝置朝向';
    button.classList.add('hidden');
  }

  function handleOrientation(event) {
    let heading = null;
    if (typeof event.webkitCompassHeading === 'number') {
      heading = event.webkitCompassHeading;
    } else if (typeof event.alpha === 'number') {
      const screenAngle = window.screen?.orientation?.angle || window.orientation || 0;
      heading = 360 - event.alpha + screenAngle;
    }
    update(heading);
  }

  function startListening() {
    if (listening) return;
    const eventName = 'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute'
      : 'deviceorientation';
    window.addEventListener(eventName, handleOrientation, true);
    if (eventName !== 'deviceorientation') {
      window.addEventListener('deviceorientation', handleOrientation, true);
    }
    listening = true;
    statusText.textContent = '正在讀取方向…';
    setTimeout(() => {
      if (!receivedReading) showFallback('感測器無讀值，顯示北向');
    }, 3000);
  }

  async function enableCompass() {
    try {
      if (typeof DeviceOrientationEvent === 'undefined') {
        showFallback('此裝置不支援方向感測');
        button.classList.add('hidden');
        return;
      }

      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') {
          showFallback('方向權限未開啟');
          return;
        }
      }

      startListening();
    } catch (error) {
      console.warn(error);
      showFallback('無法啟用方向感測');
    }
  }

  button.addEventListener('click', enableCompass);
  showFallback();

  if (typeof DeviceOrientationEvent === 'undefined') {
    button.classList.add('hidden');
    showFallback('此裝置不支援方向感測');
  } else if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    button.classList.remove('hidden');
    statusText.textContent = '點按按鈕啟用即時朝向';
  } else {
    button.classList.add('hidden');
    startListening();
  }
})();
