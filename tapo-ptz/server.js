const express = require('express');
const { Cam } = require('onvif');

const app = express();
app.use(express.json());

const CAMERA_IP = process.env.TAPO_IP || '192.168.1.147';
const CAMERA_USER = process.env.TAPO_USER;
const CAMERA_PASS = decodeURIComponent(process.env.TAPO_PASS || '');
const PTZ_ABSOLUTE = process.env.TAPO_PTZ_ABSOLUTE === '1';

let cam = null;
cam = new Cam({
  hostname: CAMERA_IP,
  username: CAMERA_USER,
  password: CAMERA_PASS,
  port: 2020
}, function(err) {
  if (err) { cam = null; return console.error('ONVIF connect failed:', err.message); }
  console.log('ONVIF connected');
});

app.get('/tapo-ptz/capabilities', (req, res) => {
  if (!cam) return res.status(503).json({ error: 'ONVIF not connected' });
  cam.getImagingSettings({ videoSourceToken: 'video_source_1' }, (err, settings) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(settings);
  });
});

app.post('/tapo-ptz/imaging', (req, res) => {
  if (!cam) return res.status(503).json({ error: 'ONVIF not connected' });
  const { irCutFilter } = req.body; // 'ON', 'OFF', 'AUTO'
  cam.setImagingSettings({ videoSourceToken: 'video_source_1', imagingSettings: { irCutFilter } }, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, irCutFilter });
  });
});

let lockOwner = null;
let lockTimer = null;

function acquireLock(id) {
  if (lockOwner && lockOwner !== id) return false;
  lockOwner = id;
  // Auto-release lock after 5s in case the client never sends a stop
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { lockOwner = null; }, 5000);
  return true;
}

function releaseLock(id) {
  if (lockOwner === id) { lockOwner = null; clearTimeout(lockTimer); }
}

app.post('/tapo-ptz/ptz', (req, res) => {
  if (!cam) return res.status(503).json({ error: 'ONVIF not connected' });
  const { x = 0, y = 0, zoom = 0, clientId } = req.body;
  const profileToken = 'profile_1';
  const isStop = x === 0 && y === 0 && zoom === 0;

  if (!isStop && !acquireLock(clientId)) {
    return res.status(409).json({ error: 'Camera is in use' });
  }

  if (isStop) {
    releaseLock(clientId);
    cam.stop({ profileToken, panTilt: true, zoom: true }, err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  } else if (PTZ_ABSOLUTE) {
    // Camera doesn't support continuousMove — get current position then absoluteMove in direction
    cam.getStatus({ profileToken }, (err, status) => {
      const curX = (!err && status && status.position) ? parseFloat(status.position.x) : 0;
      const curY = (!err && status && status.position) ? parseFloat(status.position.y) : 0;
      const targetX = x !== 0 ? Math.sign(x) : curX;
      const targetY = y !== 0 ? Math.sign(y) : curY;
      cam.absoluteMove({ profileToken, x: targetX, y: targetY, zoom: 0 }, err2 => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ ok: true });
      });
    });
  } else {
    cam.continuousMove({ profileToken, x, y, zoom }, err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
  }
});

const fs = require('fs');
const PRESETS_FILE = '/data/presets.json';

function loadPresets() {
  try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } catch { return {}; }
}
function savePresets(data) {
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(data));
}

app.post('/tapo-ptz/preset/save', (req, res) => {
  if (!cam) return res.status(503).json({ error: 'ONVIF not connected' });
  const { name } = req.body;
  cam.getStatus({ profileToken: 'profile_1' }, (err, status) => {
    if (err) return res.status(500).json({ error: err.message });
    const presets = loadPresets();
    presets[name] = { x: status.position.x, y: status.position.y };
    savePresets(presets);
    res.json({ ok: true, position: presets[name] });
  });
});

app.post('/tapo-ptz/preset/go', (req, res) => {
  if (!cam) return res.status(503).json({ error: 'ONVIF not connected' });
  const { name } = req.body;
  const preset = loadPresets()[name];
  if (!preset) return res.status(404).json({ error: 'Preset not set' });
  cam.absoluteMove({ profileToken: 'profile_1', x: preset.x, y: preset.y, zoom: 0 }, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.listen(3001, () => console.log('tapo-ptz running on port 3001'));
