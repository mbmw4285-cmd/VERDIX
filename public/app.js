(() => {
  'use strict';
  const API = String(window.VERDIX_API_URL || '').replace(/\/+$/, '');
  const $ = id => document.getElementById(id);
  const video = $('video'), canvas = $('canvas'), select = $('cameraSelect');
  const startBtn = $('startBtn'), scanBtn = $('scanBtn'), sortBtn = $('sortBtn'), autoMode = $('autoMode');
  let stream = null, current = null, busy = false, triggerBusy = false;
  const cap = s => s ? s[0] + s.slice(1).toLowerCase() : '';
  function say(text, kind = '') { const el = $('msg'); el.textContent = text; el.className = 'message ' + kind; }

  async function loadStatus() {
    try {
      const response = await fetch(API + '/api/status');
      if (!response.ok) throw new Error('Backend status unavailable');
      const s = await response.json();
      $('statusDot').className = 'dot ' + (s.ai ? (s.esp32 === 'simulation' ? 'warn' : 'ok') : 'err');
      $('statusText').textContent = !s.ai ? 'AI key missing on server' : (s.esp32 === 'simulation' ? 'AI online · Sorting simulation' : s.esp32 === 'connected' ? 'AI online · ESP32 connected' : 'AI online · ESP32 configured');
      const levels = s.bins || {};
      document.querySelectorAll('.bin').forEach(bin => {
        const el = bin.querySelector('.bin-status'); const v = levels[bin.dataset.bin];
        if (!el) return;
        if (typeof v !== 'number') { el.textContent = 'READY TO RECEIVE'; el.style.color = ''; }
        else if (v >= 90) { el.textContent = `BIN FULL · ${v}%`; el.style.color = 'var(--red)'; }
        else { el.textContent = `${v}% FULL`; el.style.color = ''; }
      });
    } catch {
      $('statusDot').className = 'dot err'; $('statusText').textContent = 'Backend unavailable';
    }
  }

  async function listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      select.innerHTML = '<option value="">Camera access requires HTTPS</option>'; return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const activeId = stream?.getVideoTracks()[0]?.getSettings()?.deviceId || '';
    const previous = select.value;
    select.innerHTML = '';
    if (!cameras.length) { select.add(new Option('No cameras found — connect webcam', '')); return; }
    cameras.forEach((camera, i) => {
      const option = new Option(camera.label || `Camera ${i + 1}`, camera.deviceId);
      select.add(option);
      if (camera.deviceId === activeId || (!activeId && camera.deviceId === previous)) option.selected = true;
    });
  }

  async function startCamera(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('cameraHint').textContent = 'Camera access needs HTTPS and a modern browser such as Chrome or Edge.'; return;
    }
    stopCamera(false);
    try {
      const constraints = deviceId
        ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }
        : { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      $('camEmpty').classList.add('hide');
      scanBtn.disabled = false;
      startBtn.textContent = 'Restart Camera';
      $('cameraHint').textContent = 'Live feed connected. Center one waste item inside the frame.';
      await listCameras();
      const active = stream.getVideoTracks()[0]?.getSettings()?.deviceId;
      if (active) select.value = active;
      say('Camera connected. Ready to scan.', 'ok');
    } catch (e) {
      stream = null;
      $('camEmpty').classList.remove('hide');
      $('cameraHint').textContent = e.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Allow camera access from the browser address bar and retry.'
        : e.name === 'NotFoundError' ? 'No webcam detected. Connect your USB webcam and try again.'
        : 'Could not start camera: ' + e.message;
      say('Camera could not start.', 'err');
      await listCameras().catch(() => {});
    }
  }

  function stopCamera(showMessage = true) {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null; video.srcObject = null; scanBtn.disabled = true;
    $('camEmpty').classList.remove('hide');
    if (showMessage) { $('cameraHint').textContent = 'Camera stopped. Select a camera and start it again when ready.'; say('Camera stopped.'); }
  }

  function showResult(r) {
    current = r;
    $('resultCard').dataset.material = r.material;
    $('material').textContent = r.material === 'UNKNOWN' ? 'Uncertain' : cap(r.material);
    $('item').textContent = r.item || 'Unidentified item';
    $('confText').textContent = `${r.confidence}%`;
    $('confBar').style.width = `${r.confidence}%`;
    $('reason').textContent = r.reason || 'Please check the item before sorting.';
    $('destination').textContent = r.material === 'UNKNOWN' ? 'Manual review needed' : `${cap(r.material)} bin`;
    $('resultSymbol').textContent = ({PLASTIC:'◇', METAL:'▱', ORGANIC:'✿', OTHER:'◈', UNKNOWN:'?'}[r.material] || '?');
    document.querySelectorAll('.bin').forEach(bin => bin.classList.toggle('active', bin.dataset.bin === r.material));
    sortBtn.disabled = r.material === 'UNKNOWN';
    sortBtn.innerHTML = r.material === 'UNKNOWN' ? 'Manual Review Required' : `Confirm &amp; Sort to ${cap(r.material)} <span>→</span>`;
  }

  async function scan() {
    if (!stream || !video.videoWidth || busy) return say('Start the camera first.', 'err');
    busy = true; scanBtn.disabled = true; sortBtn.disabled = true; scanBtn.textContent = 'Analyzing…';
    $('scanLine').classList.add('on'); say('Sending the captured image to Gemini AI…');
    try {
      const scale = Math.min(1, 1024 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.82);
      const response = await fetch(API + '/api/classify', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ image })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Classification failed (${response.status})`);
      showResult(data); say('Classification complete. Verify the result before confirming.', 'ok');
    } catch (e) { say(e.message || 'Could not classify this image.', 'err'); }
    finally { busy = false; scanBtn.disabled = !stream; scanBtn.textContent = 'Capture & Classify ↗'; $('scanLine').classList.remove('on'); }
  }

  async function checkIRTrigger() {
    if (!autoMode.checked || !stream || busy || triggerBusy) return;
    triggerBusy = true;
    try {
      const response = await fetch(API + '/api/ir-trigger', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (data.detected && autoMode.checked && stream && !busy) {
        say('IR sensor detected an object. Capturing automatically…', 'ok');
        await scan();
      }
    } catch { /* keep manual scan available if the trigger service is offline */ }
    finally { triggerBusy = false; }
  }

  autoMode.addEventListener('change', () => {
    $('irStatus').textContent = autoMode.checked ? 'WAITING FOR IR SENSOR' : 'AUTO MODE OFF';
    $('irStatus').classList.toggle('on', autoMode.checked);
    if (autoMode.checked) {
      if (!stream) say('Automatic mode is on. Start the camera and connect the ESP32 IR trigger.', '');
      else say('Automatic mode on. Waiting for an IR sensor trigger.', 'ok');
    } else say('Automatic mode off. Use Capture & Classify whenever you want.');
  });

  async function sort() {
    if (!current || current.material === 'UNKNOWN') return;
    sortBtn.disabled = true; say(`Requesting ${cap(current.material)} bin…`);
    try {
      const response = await fetch(API + '/api/sort', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ material: current.material })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Sort request failed.');
      say(data.message || 'Sort request completed.', data.simulated ? '' : 'ok');
    } catch (e) { say(e.message, 'err'); sortBtn.disabled = false; }
  }

  startBtn.addEventListener('click', () => startCamera(select.value || undefined));
  select.addEventListener('change', () => { if (stream) startCamera(select.value || undefined); });
  scanBtn.addEventListener('click', scan);
  sortBtn.addEventListener('click', sort);
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { /* keep the camera active while the page is open */ } });
  loadStatus();
  setInterval(loadStatus, 10000);
  setInterval(checkIRTrigger, 1200);
  if (navigator.mediaDevices?.enumerateDevices) listCameras().catch(() => {});
})();
