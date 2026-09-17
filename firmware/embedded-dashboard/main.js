class CanDoDashboard {
  constructor() {
    this.ws = null;
    this.reconnectInterval = 3000;
    this.entities = [];
    this.statusBadge = document.getElementById('connection-status');
    this.entityGrid = document.getElementById('entity-grid');
    this.terminal = document.getElementById('terminal-window');
    this.autoScrollChk = document.getElementById('chk-autoscroll');
    this.filterInput = document.getElementById('filter-input');

    // Sniffer State
    this.snifferPaused = false;
    this.snifferFrames = new Map(); // id -> { id, dlc, data, count, ts }
    this.snifferOrder = [];

    this.initEvents();
    this.connect();
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || '192.168.4.1';
    this.ws = new WebSocket(`${protocol}//${host}/ws`);

    this.ws.onopen = () => {
      this.updateStatus(true);
      this.syncAllStates();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          this.appendLog(data.msg);
        } else if (data.type === 'state') {
          this.updateEntityState(data.entity, data.state);
        } else if (data.type === 'can_frame') {
          this.handleCanFrame(data);
        }
      } catch (err) {
        this.appendLog(event.data);
      }
    };

    this.ws.onclose = () => {
      this.updateStatus(false);
      setTimeout(() => this.connect(), this.reconnectInterval);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  }

  updateStatus(connected) {
    if (!this.statusBadge) return;
    if (connected) {
      this.statusBadge.textContent = 'Connected';
      this.statusBadge.className = 'status-badge online';
    } else {
      this.statusBadge.textContent = 'Offline';
      this.statusBadge.className = 'status-badge offline';
    }
  }

  async syncAllStates() {
    await Promise.all([
      this.syncInitialStates(),
      this.syncSystemStatus(),
      this.syncWifiStatus(),
      this.syncKnownNetworks()
    ]);
  }

  async syncInitialStates() {
    try {
      const res = await fetch('/api/states');
      if (!res.ok) return;
      this.entities = await res.json();
      
      const statEnt = document.getElementById('stat-entities');
      if (statEnt) statEnt.textContent = this.entities.length;

      this.renderEntityGrid();
    } catch (e) {
      console.error('Failed to fetch states', e);
    }
  }

  async syncSystemStatus() {
    try {
      const res = await fetch('/api/system/status');
      if (!res.ok) return;
      const data = await res.json();

      // Automations toggle
      const autoChk = document.getElementById('toggle-automations');
      const autoLbl = document.getElementById('label-automations-state');
      const statAuto = document.getElementById('stat-automations-toggle');
      if (autoChk) autoChk.checked = data.automations_enabled;
      if (autoLbl) {
        autoLbl.textContent = data.automations_enabled ? 'ENABLED' : 'DISABLED';
        autoLbl.style.color = data.automations_enabled ? 'var(--accent-emerald)' : 'var(--text-muted)';
      }
      if (statAuto) {
        statAuto.textContent = data.automations_enabled ? 'Active' : 'Paused';
        statAuto.style.color = data.automations_enabled ? 'var(--accent-emerald)' : 'var(--text-muted)';
      }

      // Sniffer toggle
      const sniffChk = document.getElementById('toggle-sniffer');
      const sniffLbl = document.getElementById('label-sniffer-state');
      const sniffAlert = document.getElementById('sniffer-alert');
      const statSniff = document.getElementById('stat-sniffer');
      if (sniffChk) sniffChk.checked = data.sniffer_mode;
      if (sniffLbl) {
        sniffLbl.textContent = data.sniffer_mode ? 'ACTIVE' : 'INACTIVE';
        sniffLbl.style.color = data.sniffer_mode ? 'var(--accent-amber)' : 'var(--text-muted)';
      }
      if (sniffAlert) sniffAlert.style.display = data.sniffer_mode ? 'flex' : 'none';
      if (statSniff) {
        statSniff.textContent = data.sniffer_mode ? 'Active' : 'Off';
        statSniff.style.color = data.sniffer_mode ? 'var(--accent-amber)' : 'var(--text-muted)';
      }

      // Hardware listen only
      const hwChk = document.getElementById('chk-hw-listen-only');
      const twaiModeLbl = document.getElementById('twai-mode-status');
      if (hwChk) hwChk.checked = data.hardware_listen_only;
      if (twaiModeLbl) {
        twaiModeLbl.textContent = data.hardware_listen_only ? 'TWAI Mode: LISTEN-ONLY (No ACK)' : 'TWAI Mode: NORMAL (ACK)';
        twaiModeLbl.style.color = data.hardware_listen_only ? 'var(--accent-amber)' : 'var(--text-muted)';
      }

      // GVRET clients badge
      const gvretBadge = document.getElementById('gvret-badge');
      if (gvretBadge) {
        gvretBadge.textContent = `GVRET: ${data.gvret_clients}`;
        gvretBadge.style.background = data.gvret_clients > 0 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(6, 182, 212, 0.15)';
        gvretBadge.style.color = data.gvret_clients > 0 ? 'var(--accent-emerald)' : 'var(--accent-cyan)';
      }
    } catch (e) {
      console.error('Failed to fetch system status', e);
    }
  }

  async syncWifiStatus() {
    try {
      const res = await fetch('/api/wifi/status');
      if (!res.ok) return;
      const data = await res.json();

      const staStatus = document.getElementById('net-sta-status');
      const staIp = document.getElementById('net-sta-ip');
      const apStatus = document.getElementById('net-ap-status');
      const apSelect = document.getElementById('select-ap-mode');
      const statWifi = document.getElementById('stat-wifi-link');

      if (staStatus) {
        if (data.sta_connected) {
          staStatus.textContent = `Connected to "${data.sta_ssid}" (${data.sta_rssi} dBm)`;
          staStatus.style.color = 'var(--accent-emerald)';
        } else {
          staStatus.textContent = 'Disconnected';
          staStatus.style.color = 'var(--text-muted)';
        }
      }

      if (staIp) {
        staIp.textContent = data.sta_connected ? `${data.sta_ip} (GW: ${data.sta_gw})` : '0.0.0.0';
      }

      if (apStatus) {
        if (data.ap_active) {
          apStatus.textContent = `Active: "${data.ap_ssid}" (${data.ap_ip}) [Clients: ${data.ap_clients}]`;
          apStatus.style.color = 'var(--accent-cyan)';
        } else {
          apStatus.textContent = 'Torn Down (STA Connected)';
          apStatus.style.color = 'var(--text-muted)';
        }
      }

      if (apSelect) {
        apSelect.value = data.ap_mode || 'auto';
      }

      if (statWifi) {
        if (data.sta_connected) {
          statWifi.textContent = data.sta_ssid;
          statWifi.style.color = 'var(--accent-emerald)';
        } else if (data.ap_active) {
          statWifi.textContent = 'SoftAP';
          statWifi.style.color = 'var(--accent-cyan)';
        } else {
          statWifi.textContent = 'Offline';
          statWifi.style.color = 'var(--accent-rose)';
        }
      }
    } catch (e) {
      console.error('Failed to fetch wifi status', e);
    }
  }

  async syncKnownNetworks() {
    try {
      const res = await fetch('/api/wifi/networks');
      if (!res.ok) return;
      const networks = await res.json();
      const tbody = document.getElementById('known-nets-tbody');
      if (!tbody) return;

      if (!networks || networks.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding:0.6rem;">No stored networks. Add one below.</td></tr>`;
        return;
      }

      tbody.innerHTML = networks.map(net => `
        <tr>
          <td style="font-weight:600; color:#fff;">${net.ssid}</td>
          <td><span class="entity-badge" style="background:#1e293b; color:#93c5fd;">Prio: ${net.priority}</span></td>
          <td>
            <button class="btn btn-danger btn-tiny" onclick="window.dashboard.removeNetwork('${net.ssid}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      console.error('Failed fetching networks', e);
    }
  }

  handleCanFrame(frame) {
    if (this.snifferPaused) return;

    const key = frame.id;
    let existing = this.snifferFrames.get(key);
    const now = new Date().toLocaleTimeString();

    if (existing) {
      existing.data = frame.data;
      existing.dlc = frame.dlc;
      existing.ts = now;
      existing.count++;
    } else {
      existing = {
        id: frame.id,
        extd: frame.extd,
        dlc: frame.dlc,
        data: frame.data,
        ts: now,
        count: 1
      };
      this.snifferFrames.set(key, existing);
      this.snifferOrder.unshift(key);
      if (this.snifferOrder.length > 50) {
        const removed = this.snifferOrder.pop();
        this.snifferFrames.delete(removed);
      }
    }

    this.renderSnifferTable();
  }

  renderSnifferTable() {
    const tbody = document.getElementById('sniffer-tbody');
    if (!tbody) return;

    if (this.snifferOrder.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:1rem;">Listening for CAN traffic...</td></tr>`;
      return;
    }

    tbody.innerHTML = this.snifferOrder.map(key => {
      const f = this.snifferFrames.get(key);
      if (!f) return '';
      // Format spaced hex bytes: e.g. "00 11 22"
      const hexSpaced = (f.data.match(/.{1,2}/g) || []).join(' ');
      return `
        <tr>
          <td style="color:var(--text-muted);">${f.ts}</td>
          <td><span class="can-id-badge">${f.id}</span></td>
          <td>${f.dlc}</td>
          <td><span class="can-data-hex">${hexSpaced}</span></td>
          <td style="font-weight:700; color:var(--accent-cyan);">${f.count}</td>
        </tr>
      `;
    }).join('');
  }

  renderEntityGrid() {
    if (!this.entityGrid) return;
    const filter = (this.filterInput?.value || '').toLowerCase();
    const filtered = this.entities.filter(e => 
      e.entity.toLowerCase().includes(filter) || (e.state && e.state.toLowerCase().includes(filter))
    );

    if (filtered.length === 0) {
      this.entityGrid.innerHTML = '<div class="subtext">No matching entities found.</div>';
      return;
    }

    this.entityGrid.innerHTML = filtered.map(e => `
      <div class="entity-card" id="card-${e.entity}">
        <div class="entity-header">
          <span class="entity-name">${e.entity}</span>
          <span class="entity-badge" id="badge-${e.entity}">${e.state || 'Unknown'}</span>
        </div>
        <div class="entity-actions">
          <input type="text" id="cmd-input-${e.entity}" placeholder="Command (e.g. Medium Cool)" class="input-search" style="width:100%;margin-bottom:0.4rem;">
          <button class="btn btn-secondary btn-tiny" onclick="window.dashboard.sendCommand('${e.entity}')" style="width:100%;">Send Command</button>
        </div>
      </div>
    `).join('');
  }

  updateEntityState(entityId, state) {
    const badge = document.getElementById(`badge-${entityId}`);
    if (badge) badge.textContent = state;
    const item = this.entities.find(e => e.entity === entityId);
    if (item) item.state = state;
  }

  async sendCommand(entityId) {
    const input = document.getElementById(`cmd-input-${entityId}`);
    const command = input ? input.value : '';
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity: entityId, command })
      });
      const data = await res.json();
      this.appendLog(`Command [${entityId} -> ${command}]: ${data.status || 'sent'}`);
    } catch (err) {
      this.appendLog(`Command error: ${err.message}`);
    }
  }

  async testAutomation(mode) {
    const select = document.getElementById('automation-select');
    const resultBox = document.getElementById('test-result');
    const autoId = select?.value || 'menu_ok_cool_driver_seat';

    if (!resultBox) return;
    resultBox.style.display = 'block';
    resultBox.textContent = `Evaluating ${mode}...`;
    resultBox.className = 'test-result-box';

    try {
      const res = await fetch('/api/test_automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: autoId, mode })
      });
      const data = await res.json();
      resultBox.textContent = `[${mode.toUpperCase()}] ${data.message || JSON.stringify(data)}`;
      resultBox.className = data.status === 'ok' ? 'test-result-box ok' : 'test-result-box fail';
    } catch (err) {
      resultBox.textContent = `Error: ${err.message}`;
      resultBox.className = 'test-result-box fail';
    }
  }

  appendLog(msg) {
    if (!this.terminal) return;
    const line = document.createElement('div');
    line.className = 'log-entry';
    if (msg.includes('E (') || msg.includes('error')) line.className += ' error';
    else if (msg.includes('W (') || msg.includes('warn')) line.className += ' warn';
    else if (msg.includes('I (')) line.className += ' info';
    line.textContent = msg;

    this.terminal.appendChild(line);

    if (this.autoScrollChk?.checked) {
      this.terminal.scrollTop = this.terminal.scrollHeight;
    }
  }

  async removeNetwork(ssid) {
    if (!confirm(`Delete stored Wi-Fi network "${ssid}"?`)) return;
    try {
      const res = await fetch('/api/wifi/networks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid })
      });
      if (res.ok) {
        this.syncKnownNetworks();
      }
    } catch (err) {
      alert('Failed to remove network: ' + err.message);
    }
  }

  initEvents() {
    this.filterInput?.addEventListener('input', () => this.renderEntityGrid());

    document.getElementById('btn-dry-run')?.addEventListener('click', () => this.testAutomation('dry_run'));
    document.getElementById('btn-live-fire')?.addEventListener('click', () => this.testAutomation('live_fire'));

    document.getElementById('btn-clear-log')?.addEventListener('click', () => {
      if (this.terminal) this.terminal.innerHTML = '';
    });

    // Automations execution toggle
    document.getElementById('toggle-automations')?.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      try {
        await fetch('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ automations_enabled: enabled })
        });
        this.syncSystemStatus();
      } catch (err) {
        console.error('Failed toggling automations', err);
      }
    });

    // Sniffer mode toggle
    document.getElementById('toggle-sniffer')?.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const hwListen = document.getElementById('chk-hw-listen-only')?.checked || false;
      try {
        await fetch('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sniffer_mode: enabled, hardware_listen_only: hwListen })
        });
        this.syncSystemStatus();
      } catch (err) {
        console.error('Failed toggling sniffer mode', err);
      }
    });

    // Hardware listen-only toggle
    document.getElementById('chk-hw-listen-only')?.addEventListener('change', async (e) => {
      const hwListen = e.target.checked;
      const snifferActive = document.getElementById('toggle-sniffer')?.checked || false;
      try {
        await fetch('/api/system/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sniffer_mode: snifferActive, hardware_listen_only: hwListen })
        });
        this.syncSystemStatus();
      } catch (err) {
        console.error('Failed updating hardware listen-only mode', err);
      }
    });

    // Sniffer table controls
    const btnPauseSniffer = document.getElementById('btn-pause-sniffer');
    btnPauseSniffer?.addEventListener('click', () => {
      this.snifferPaused = !this.snifferPaused;
      btnPauseSniffer.textContent = this.snifferPaused ? 'Resume' : 'Pause';
      btnPauseSniffer.className = this.snifferPaused ? 'btn btn-primary btn-tiny' : 'btn btn-secondary btn-tiny';
    });

    document.getElementById('btn-clear-sniffer')?.addEventListener('click', () => {
      this.snifferFrames.clear();
      this.snifferOrder = [];
      this.renderSnifferTable();
    });

    // AP Fallback mode change
    document.getElementById('select-ap-mode')?.addEventListener('change', async (e) => {
      const mode = e.target.value;
      try {
        await fetch('/api/wifi/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ap_mode: mode })
        });
        this.syncWifiStatus();
      } catch (err) {
        console.error('Failed updating AP mode', err);
      }
    });

    // Scan Wi-Fi Networks
    document.getElementById('btn-scan-wifi')?.addEventListener('click', async () => {
      const scanCont = document.getElementById('scan-container');
      const scanList = document.getElementById('scan-list');
      if (scanCont) scanCont.style.display = 'block';
      if (scanList) scanList.innerHTML = `<div style="padding:0.5rem; color:var(--text-muted);">Scanning 2.4GHz Wi-Fi channels (non-blocking)...</div>`;

      try {
        const res = await fetch('/api/wifi/scan');
        const data = await res.json();
        const results = data.results || [];

        if (results.length === 0) {
          scanList.innerHTML = `<div style="padding:0.5rem; color:var(--text-muted);">Scan in progress or no networks found. Click again in a moment.</div>`;
          return;
        }

        scanList.innerHTML = results.map(ap => `
          <div class="scan-item" onclick="window.dashboard.selectScannedNetwork('${ap.ssid}')">
            <span style="font-weight:600; color:#fff;">${ap.ssid}</span>
            <span class="subtext" style="color:var(--accent-cyan);">${ap.rssi} dBm ${ap.in_known_list ? '★ Stored' : ''}</span>
          </div>
        `).join('');
      } catch (err) {
        scanList.innerHTML = `<div style="padding:0.5rem; color:var(--accent-rose);">Scan failed: ${err.message}</div>`;
      }
    });

    // Add Stored Network
    document.getElementById('btn-save-net')?.addEventListener('click', async () => {
      const ssidInput = document.getElementById('add-net-ssid');
      const passInput = document.getElementById('add-net-pass');
      const prioInput = document.getElementById('add-net-prio');

      const ssid = ssidInput?.value.trim();
      const password = passInput?.value || '';
      const priority = parseInt(prioInput?.value || '50', 10);

      if (!ssid) {
        alert('Please provide an SSID.');
        return;
      }

      try {
        const res = await fetch('/api/wifi/networks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssid, password, priority })
        });
        if (res.ok) {
          if (ssidInput) ssidInput.value = '';
          if (passInput) passInput.value = '';
          this.syncKnownNetworks();
          this.syncWifiStatus();
        }
      } catch (err) {
        alert('Failed saving network: ' + err.message);
      }
    });

    // OTA Firmware Upload
    const fwInput = document.getElementById('firmware-input');
    fwInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.uploadFile(file, '/api/ota', null, 'ota-progress', 'ota-status');
    });

    // Automations Download
    document.getElementById('btn-download-automations')?.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/automations');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'automations.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        alert('Failed to download automations: ' + err.message);
      }
    });

    // Automations Upload
    const autoInput = document.getElementById('automations-input');
    autoInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.uploadFile(file, '/api/automations', null, null, 'automations-status');
    });
  }

  selectScannedNetwork(ssid) {
    const ssidInput = document.getElementById('add-net-ssid');
    if (ssidInput) {
      ssidInput.value = ssid;
      document.getElementById('add-net-pass')?.focus();
    }
  }

  uploadFile(file, url, destHeader, progId, statusId) {
    const prog = progId ? document.getElementById(progId) : null;
    const status = statusId ? document.getElementById(statusId) : null;
    if (prog) prog.style.display = 'block';
    if (status) status.textContent = `Uploading ${file.name}...`;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    if (destHeader) xhr.setRequestHeader('X-File-Path', destHeader);

    if (xhr.upload && prog) {
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          prog.value = evt.loaded / evt.total;
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status === 200) {
        if (status) status.textContent = 'Success! Device rebooting...';
        setTimeout(() => window.location.reload(), 4000);
      } else {
        if (status) status.textContent = `Failed (${xhr.status}): ${xhr.responseText}`;
      }
    };

    xhr.onerror = () => {
      if (status) status.textContent = 'Upload network error.';
    };

    xhr.send(file);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.dashboard = new CanDoDashboard();
});
