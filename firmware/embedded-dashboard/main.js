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

    this.initEvents();
    this.connect();
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || '192.168.4.1';
    this.ws = new WebSocket(`${protocol}//${host}/ws`);

    this.ws.onopen = () => {
      this.updateStatus(true);
      this.syncInitialStates();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          this.appendLog(data.msg);
        } else if (data.type === 'state') {
          this.updateEntityState(data.entity, data.state);
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

  async syncInitialStates() {
    try {
      const res = await fetch('/api/states');
      if (!res.ok) return;
      this.entities = await res.json();
      
      const statEnt = document.getElementById('stat-entities');
      if (statEnt) statEnt.textContent = this.entities.length;

      const statAuto = document.getElementById('stat-automations');
      if (statAuto) statAuto.textContent = '1';

      this.renderEntityGrid();
    } catch (e) {
      console.error('Failed to fetch states', e);
    }
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

  initEvents() {
    this.filterInput?.addEventListener('input', () => this.renderEntityGrid());

    document.getElementById('btn-dry-run')?.addEventListener('click', () => this.testAutomation('dry_run'));
    document.getElementById('btn-live-fire')?.addEventListener('click', () => this.testAutomation('live_fire'));

    document.getElementById('btn-clear-log')?.addEventListener('click', () => {
      if (this.terminal) this.terminal.innerHTML = '';
    });

    // OTA Firmware Upload
    const fwInput = document.getElementById('firmware-input');
    fwInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.uploadFile(file, '/api/ota', null, 'ota-progress', 'ota-status');
    });

    // Catalog Upload
    const catInput = document.getElementById('catalog-input');
    catInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      this.uploadFile(file, '/api/upload', '/spiffs/catalog/can_do_catalog.json', null, 'catalog-status');
    });
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
