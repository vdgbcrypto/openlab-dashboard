// ============================================
// OpenLab Dashboard - Homelab Monitoring
// ============================================

class Dashboard {
    constructor() {
        this.config = this.loadConfig();
        this.data = {
            system: {},
            cpu: { percent: 0, cores: 0, temp: 0, history: [] },
            memory: { percent: 0, used: 0, total: 0, history: [] },
            disk: { percent: 0, used: 0, total: 0, history: [] },
            network: { rx: 0, tx: 0, rxHistory: [], txHistory: [], interfaces: [] },
            storage: [],
            vms: [],
            containers: [],
            apps: [],
            services: [],
            mode: 'demo'
        };
        this.refreshTimer = null;
        this.refreshInterval = 5;
        this.charts = {};
        this.historyMax = 60;
        this.init();
    }

    // ---- Init ----
    init() {
        this.setupNavigation();
        this.setupControls();
        this.setupTheme();
        this.setupConfig();
        // Load demo mode immediately, refresh will try APIs if configured
        if (!this.config.netdataUrl && !this.config.truenasUrl) {
            this.generateDemoData();
            this.data.mode = 'demo';
        }
        this.detectServices();
        this.startRefresh();
        this.refresh();
    }

    // ---- Config ----
    loadConfig() {
        const defaults = {
            truenasUrl: '',
            truenasUser: 'root',
            truenasPass: '',
            ntopngUrl: '',
            netdataUrl: ''
        };
        try {
            const saved = localStorage.getItem('olDashboardConfig');
            return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
        } catch {
            return defaults;
        }
    }

    saveConfig(cfg) {
        Object.assign(this.config, cfg);
        localStorage.setItem('olDashboardConfig', JSON.stringify(this.config));
    }

    // ---- Theme ----
    setupTheme() {
        const saved = localStorage.getItem('olTheme');
        if (saved) document.documentElement.setAttribute('data-theme', saved);
        this.updateThemeIcon();
        document.getElementById('themeToggle').addEventListener('click', () => {
            const html = document.documentElement;
            const cur = html.getAttribute('data-theme') || 'dark';
            const next = cur === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', next);
            localStorage.setItem('olTheme', next);
            this.updateThemeIcon();
        });
    }

    updateThemeIcon() {}

    // ---- Navigation ----
    setupNavigation() {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
                const section = item.getAttribute('data-section');
                document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
                const target = document.getElementById('section-' + section);
                if (target) target.classList.remove('hidden');
            });
        });
        // Config modal
        document.getElementById('configBtn').addEventListener('click', () => {
            document.getElementById('configModal').style.display = 'flex';
            document.getElementById('truenasUrl').value = this.config.truenasUrl;
            document.getElementById('truenasUser').value = this.config.truenasUser;
            document.getElementById('ntopngUrl').value = this.config.ntopngUrl;
            document.getElementById('netdataUrl').value = this.config.netdataUrl;
        });
        document.getElementById('closeConfigBtn').addEventListener('click', () => {
            document.getElementById('configModal').style.display = 'none';
        });
        document.querySelector('#configModal .close-btn').addEventListener('click', () => {
            document.getElementById('configModal').style.display = 'none';
        });
        // Detail modal
        document.querySelector('#detailModal .close-btn').addEventListener('click', () => {
            document.getElementById('detailModal').style.display = 'none';
        });
        document.getElementById('closeDetailBtn').addEventListener('click', () => {
            document.getElementById('detailModal').style.display = 'none';
        });
    }

    setupControls() {
        document.getElementById('refreshBtn').addEventListener('click', () => this.refresh());

        const intervalSel = document.getElementById('refreshIntervalSelect');
        intervalSel.value = String(this.refreshInterval);
        intervalSel.addEventListener('change', () => {
            const val = parseInt(intervalSel.value);
            this.refreshInterval = val;
            this.startRefresh();
        });

        document.getElementById('saveConfigBtn').addEventListener('click', () => {
            this.saveConfig({
                truenasUrl: document.getElementById('truenasUrl').value.trim(),
                truenasUser: document.getElementById('truenasUser').value.trim(),
                truenasPass: document.getElementById('truenasPass').value.trim(),
                ntopngUrl: document.getElementById('ntopngUrl').value.trim(),
                netdataUrl: document.getElementById('netdataUrl').value.trim()
            });
            document.getElementById('configModal').style.display = 'none';
            this.data.mode = this.config.netdataUrl || this.config.truenasUrl ? 'live' : 'demo';
            this.detectServices();
            this.refresh();
        });
    }

    // ---- Service Detection ----
    async detectServices() {
        const setDetect = (id, status) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = status ? 'Reachable' : 'Not found';
            el.className = 'detect-status ' + (status ? 'ok' : 'fail');
        };

        if (this.config.netdataUrl) {
            this.fetchSafe(this.config.netdataUrl + '/api/v1/info', 3000)
                .then(r => { setDetect('detectNetdata', r.ok); })
                .catch(() => setDetect('detectNetdata', false));
        } else {
            setDetect('detectNetdata', false);
        }

        if (this.config.ntopngUrl) {
            this.fetchSafe(this.config.ntopngUrl, 3000)
                .then(r => setDetect('detectNtopng', r.ok))
                .catch(() => setDetect('detectNtopng', false));
        } else {
            setDetect('detectNtopng', false);
        }

        if (this.config.truenasUrl) {
            this.fetchSafe(this.config.truenasUrl + '/api/v2.0/system/info', 3000)
                .then(r => setDetect('detectTruenas', r.ok))
                .catch(() => setDetect('detectTruenas', false));
        } else {
            setDetect('detectTruenas', false);
        }
    }

    // ---- Safe Fetch ----
    async fetchSafe(url, timeout = 5000) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeout);
        try {
            const resp = await fetch(url, { signal: controller.signal, mode: 'cors' });
            clearTimeout(tid);
            return { ok: resp.ok, data: await resp.json().catch(() => null) };
        } catch (e) {
            clearTimeout(tid);
            throw e;
        }
    }

    // ---- Data Refresh ----
    startRefresh() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        if (this.refreshInterval <= 0) return;
        this.refreshTimer = setInterval(() => this.refresh(), this.refreshInterval * 1000);
    }

    async refresh() {
        try {
            const promises = [];

            if (this.config.netdataUrl) {
                promises.push(this.fetchNetdata());
            }

            if (this.config.truenasUrl && this.config.truenasPass) {
                promises.push(this.fetchTrueNAS());
            }

            await Promise.allSettled(promises);

            // Fall back to demo mode if no live data
            if (this.data.cpu.percent === 0 && this.data.memory.total === 0) {
                this.generateDemoData();
            }

            const hasLive = this.config.netdataUrl || (this.config.truenasUrl && this.config.truenasPass);
            const statusEl = document.getElementById('connectionStatus');
            if (hasLive) {
                statusEl.className = 'connection-status online';
                statusEl.querySelector('.status-text').textContent = 'Live';
            } else {
                statusEl.className = 'connection-status offline';
                statusEl.querySelector('.status-text').textContent = 'Demo mode';
            }

            this.render();
            this.updateLastUpdated();
        } catch (e) {
            console.error('Refresh error:', e);
            this.generateDemoData();
            this.render();
        }
    }

    // ---- Netdata API ----
    async fetchNetdata() {
        const base = this.config.netdataUrl;

        // CPU
        const res = await this.fetchSafe(base + '/api/v1/data?chart=system.cpu&after=-60&points=60', 6000);
        if (!res.ok) return;
        const json = res.data;
        const cpuChart = json && json.data ? json.data : [];
        if (cpuChart.length > 0) {
            const lastPoint = cpuChart[cpuChart.length - 1];
            let cpuVal = 0;
            if (Array.isArray(lastPoint)) {
                cpuVal = Math.max(0, Math.min(100, (lastPoint[0] || 0)));
            }
            this.data.cpu.percent = Math.round(cpuVal);
            this.data.cpu.cores = json.labels ? json.labels.length : 0;
            const hist = cpuChart.map(p => Array.isArray(p) ? Math.round((p[0] || 0)) : 0);
            this.data.cpu.history = hist.slice(-this.historyMax);
        }

        // Memory
        const memRes = await this.fetchSafe(base + '/api/v1/data?chart=system.ram&after=-60&points=60', 6000);
        if (memRes.ok && memRes.data) {
            const md = memRes.data;
            if (md.result) {
                const used = md.result.used || 0;
                const total = (md.result.used || 0) + (md.result.free || 0) + (md.result.cache || 0) + (md.result.buffers || 0);
                this.data.memory.total = total * 1024 * 1024;
                this.data.memory.used = used * 1024 * 1024;
                this.data.memory.percent = total > 0 ? Math.round((used / total) * 100) : 0;
            }
            if (md.data) {
                const hist = md.data.map(p => {
                    const u = Array.isArray(p) ? (p[1] || 0) : 0;
                    return Math.round(u);
                });
                this.data.memory.history = hist.slice(-this.historyMax);
            }
        }

        // Network
        const netRes = await this.fetchSafe(base + '/api/v1/data?chart=system.net&after=-60&points=60', 6000);
        if (netRes.ok && netRes.data) {
            const nd = netRes.data;
            if (nd.result) {
                this.data.network.rx = (nd.result.inbound || 0) * 1024;
                this.data.network.tx = (nd.result.outbound || 0) * 1024;
            }
            if (nd.data) {
                const rxHist = nd.data.map(p => Array.isArray(p) ? Math.round((p[1] || 0) * 1024) : 0);
                const txHist = nd.data.map(p => Array.isArray(p) ? Math.round((p[2] || 0) * 1024) : 0);
                this.data.network.rxHistory = rxHist.slice(-this.historyMax);
                this.data.network.txHistory = txHist.slice(-this.historyMax);
            }
        }

        // Disk
        const diskRes = await this.fetchSafe(base + '/api/v1/data?chart=disk_space._&after=-60&points=60', 6000);
        if (diskRes.ok && diskRes.data) {
            const dd = diskRes.data;
            if (dd.result) {
                this.data.disk.total = (dd.result.total || 0) * 1024 * 1024 * 1024;
                this.data.disk.used = (dd.result.used || 0) * 1024 * 1024 * 1024;
                const pct = this.data.disk.total > 0 ? Math.round((this.data.disk.used / this.data.disk.total) * 100) : 0;
                this.data.disk.percent = pct;
                this.data.disk.history = [...(this.data.disk.history || []), pct].slice(-this.historyMax);
            }
        }

        this.data.mode = 'live';
    }

    // ---- TrueNAS API ----
    async fetchTrueNAS() {
        const base = this.config.truenasUrl.replace(/\/$/, '');
        const auth = 'Basic ' + btoa(this.config.truenasUser + ':' + this.config.truenasPass);
        const headers = { 'Authorization': auth };

        try {
            const res = await this.fetchSafe(base + '/api/v2.0/system/info', 8000);
            if (res.ok && res.data) {
                this.data.system.hostname = res.data.hostname;
                this.data.system.version = res.data.version;
                this.data.system.uptime = this.formatUptime(res.data.system_time || res.data.uptime);
                this.data.cpu.cores = res.data.ncpu || this.data.cpu.cores;
                this.data.cpu.temp = res.data.cpu_temperature || 0;
                this.data.memory.total = (res.data.physmem || 0) * 1024 * 1024;
            }
        } catch {}

        try {
            const res = await this.fetchSafe(base + '/api/v2.0/pool/dataset', 8000);
            if (res.ok && res.data) {
                this.data.storage = res.data.map(ds => ({
                    name: ds.name,
                    type: ds.type || 'zfs',
                    used: ds.properties?.used?.parsed || 0,
                    total: (ds.properties?.used?.parsed || 0) + (ds.properties?.available?.parsed || 0),
                    available: ds.properties?.available?.parsed || 0
                }));
            }
        } catch {}

        try {
            const res = await this.fetchSafe(base + '/api/v2.0/vm', 8000);
            if (res.ok && res.data) {
                this.data.vms = res.data.map(vm => ({
                    id: vm.id,
                    name: vm.name,
                    state: vm.status?.state || vm.state || 'unknown',
                    memory: vm.memory || 0,
                    vcpus: vm.vcpus || 0,
                    autostart: vm.autostart || false
                }));
            }
        } catch {}

        try {
            const res = await this.fetchSafe(base + '/api/v2.0/service', 8000);
            if (res.ok && res.data) {
                this.data.services = res.data.map(svc => ({
                    id: svc.id,
                    service: svc.service,
                    state: svc.state || 'unknown',
                    enable: svc.enable || false,
                    pid: svc.pid || 0
                }));
            }
        } catch {}

        this.data.mode = 'live';
    }

    // ---- Demo Data (when no APIs configured) ----
    generateDemoData() {
        const t = Date.now();
        const jitter = (base, range) => Math.round(base + (Math.random() - 0.5) * range);

        // Realistic CPU: 8-65% with natural fluctuation
        const cpuPercent = jitter(34, 20);
        this.data.cpu.percent = Math.max(8, Math.min(65, cpuPercent));
        this.data.cpu.cores = 16;
        this.data.cpu.temp = jitter(43, 8);
        this.data.cpu.history = this._genHistory(this.data.cpu.percent, 60, 8, 65);

        // Realistic memory: 25-75% of 32GB
        const memPct = jitter(48, 18);
        this.data.memory.total = 32 * 1024 * 1024 * 1024;
        this.data.memory.used = Math.round(this.data.memory.total * Math.max(25, Math.min(75, memPct)) / 100);
        this.data.memory.percent = Math.round((this.data.memory.used / this.data.memory.total) * 100);
        this.data.memory.history = this._genHistory(this.data.memory.percent, 60, 25, 75);

        // Realistic disk: 45-80% of 887GB (ZFS pool)
        const diskPct = jitter(62, 12);
        this.data.disk.total = 887 * 1024 * 1024 * 1024;
        this.data.disk.used = Math.round(this.data.disk.total * Math.max(45, Math.min(80, diskPct)) / 100);
        this.data.disk.percent = Math.round((this.data.disk.used / this.data.disk.total) * 100);
        this.data.disk.history = this._genHistory(this.data.disk.percent, 60, 45, 80);

        // Realistic network: variable RX/TX in MB/s
        const rxMB = (Math.random() * 25 + 2).toFixed(1);
        const txMB = (Math.random() * 12 + 0.5).toFixed(1);
        this.data.network.rx = Math.round(parseFloat(rxMB) * 1024 * 1024);
        this.data.network.tx = Math.round(parseFloat(txMB) * 1024 * 1024);
        this.data.network.rxHistory = this._genHistory(parseFloat(rxMB), 60, 1, 30);
        this.data.network.txHistory = this._genHistory(parseFloat(txMB), 60, 0.2, 15);

        // System info
        this.data.system.hostname = 'truenas-scale';
        this.data.system.version = 'TrueNAS SCALE 24.10.2';
        this.data.system.uptime = this.formatUptime(t / 1000 - 7 * 86400);
        this.data.system.load = (0.5 + Math.random() * 1.5).toFixed(2) + ' ' +
                                (0.8 + Math.random() * 1.2).toFixed(2) + ' ' +
                                (1.0 + Math.random() * 2.0).toFixed(2);

        // Storage pools (realistic ZFS)
        const pool1Used = jitter(580, 80);
        const pool1Total = 887;
        this.data.storage = [
            {
                name: 'tank',
                type: 'RAID-Z2',
                used: pool1Used * 1024 * 1024 * 1024,
                total: pool1Total * 1024 * 1024 * 1024,
                available: (pool1Total - pool1Used) * 1024 * 1024 * 1024
            },
            {
                name: 'backup',
                type: 'Mirror',
                used: jitter(180, 40) * 1024 * 1024 * 1024,
                total: 400 * 1024 * 1024 * 1024,
                available: jitter(200, 40) * 1024 * 1024 * 1024
            }
        ];

        // VMs (realistic mix)
        this.data.vms = [
            { id: 1, name: 'docker-host', state: 'running', memory: 7.2 * 1024 * 1024 * 1024, vcpus: 16, autostart: true },
            { id: 2, name: 'win-server-2022', state: 'running', memory: 4 * 1024 * 1024 * 1024, vcpus: 4, autostart: true },
            { id: 3, name: 'dev-test', state: 'stopped', memory: 2 * 1024 * 1024 * 1024, vcpus: 2, autostart: false }
        ];

        // Containers (realistic homelab services)
        this.data.containers = [
            { Id: 'a1b2c3', Names: ['/netdata'], Image: 'netdata/netdata:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 19999, PrivatePort: 19999}] },
            { Id: 'd4e5f6', Names: ['/portainer'], Image: 'portainer/portainer-ce:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 9443, PrivatePort: 9443}] },
            { Id: 'g7h8i9', Names: ['/adguard'], Image: 'adguard/adguardhome:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 3000, PrivatePort: 3000}] },
            { Id: 'j0k1l2', Names: ['/vaultwarden'], Image: 'vaultwarden/server:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 8080, PrivatePort: 80}] },
            { Id: 'm3n4o5', Names: ['/syncthing'], Image: 'lscr.io/linuxserver/syncthing:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 8384, PrivatePort: 8384}] },
            { Id: 'p6q7r8', Names: ['/jellyfin'], Image: 'jellyfin/jellyfin:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 8096, PrivatePort: 8096}] },
            { Id: 's9t0u1', Names: ['/ntopng'], Image: 'ntop/ntopng:latest', State: 'running', Status: 'Up 12 days', Ports: [{PublicPort: 3000, PrivatePort: 3000}] }
        ];

        // Services (realistic TrueNAS services)
        this.data.services = [
            { id: 1, service: 'ssh', state: 'RUNNING', enable: true, pid: 1234 },
            { id: 2, service: 'docker', state: 'RUNNING', enable: true, pid: 5678 },
            { id: 3, service: 'smb', state: 'RUNNING', enable: true, pid: 9012 },
            { id: 4, service: 'nfs', state: 'RUNNING', enable: true, pid: 3456 },
            { id: 5, service: 'rsync', state: 'RUNNING', enable: true, pid: 7890 },
            { id: 6, service: 'ftp', state: 'STOPPED', enable: false, pid: 0 },
            { id: 7, service: 'cifs', state: 'RUNNING', enable: true, pid: 2345 },
            { id: 8, service: 'dns', state: 'RUNNING', enable: true, pid: 6789 }
        ];

        this.data.mode = 'demo';
    }

    _genHistory(base, count, min, max) {
        const hist = [];
        let val = base;
        for (let i = 0; i < count; i++) {
            val += (Math.random() - 0.5) * 4;
            val = Math.max(min, Math.min(max, val));
            hist.push(Math.round(val));
        }
        return hist;
    }

    // ---- Helpers ----
    formatUptime(seconds) {
        if (!seconds) return '--';
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${d} days, ${h}:${String(m).padStart(2, '0')}:00`;
    }

    formatBytes(bytes) {
        if (!bytes) return '--';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let val = bytes;
        while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
        return `${val.toFixed(1)} ${units[i]}`;
    }

    updateLastUpdated() {
        const el = document.getElementById('lastUpdated');
        if (el) el.textContent = new Date().toLocaleTimeString();
    }

    // ---- Rendering ----
    render() {
        // System
        document.getElementById('sysHostname').textContent = this.data.system.hostname || '--';
        document.getElementById('sysVersion').textContent = this.data.system.version || '--';
        document.getElementById('sysUptime').textContent = this.data.system.uptime || '--';
        document.getElementById('sysLoad').textContent = this.data.system.load || '--';

        // CPU
        document.getElementById('cpuPercent').textContent = this.data.cpu.percent + '%';
        document.getElementById('cpuCores').textContent = this.data.cpu.cores || '--';
        document.getElementById('cpuTemp').textContent = this.data.cpu.temp ? this.data.cpu.temp + '°C' : '--';

        // Memory
        document.getElementById('memPercent').textContent = this.data.memory.percent + '%';
        document.getElementById('memUsed').textContent = this.formatBytes(this.data.memory.used);
        document.getElementById('memTotal').textContent = this.formatBytes(this.data.memory.total);

        // Disk
        document.getElementById('diskPercent').textContent = this.data.disk.percent + '%';
        document.getElementById('diskUsed').textContent = this.formatBytes(this.data.disk.used);
        document.getElementById('diskTotal').textContent = this.formatBytes(this.data.disk.total);

        // Network
        document.getElementById('netRx').textContent = this.formatBytes(this.data.network.rx) + '/s';
        document.getElementById('netTx').textContent = this.formatBytes(this.data.network.tx) + '/s';

        // Storage
        const storageGrid = document.getElementById('storageGrid');
        storageGrid.innerHTML = '';
        for (const pool of this.data.storage) {
            const pct = pool.total > 0 ? Math.round((pool.used / pool.total) * 100) : 0;
            const color = pct > 90 ? 'var(--danger)' : pct > 75 ? 'var(--warning)' : 'var(--primary)';
            storageGrid.innerHTML += `
                <div class="storage-card">
                    <div class="storage-name">${pool.name}</div>
                    <div class="storage-type">${pool.type}</div>
                    <div class="storage-bar-bg"><div class="storage-bar-fill" style="width:${pct}%;background:${color}"></div></div>
                    <div class="storage-stats">
                        <span>${this.formatBytes(pool.used)}</span>
                        <span>${pct}%</span>
                        <span>${this.formatBytes(pool.total)}</span>
                    </div>
                </div>`;
        }

        // VMs
        const vmList = document.getElementById('vmList');
        vmList.innerHTML = '';
        document.getElementById('vmCount').textContent = this.data.vms.length;
        for (const vm of this.data.vms) {
            const stateClass = vm.state === 'running' ? 'running' : 'stopped';
            vmList.innerHTML += `
                <div class="list-item">
                    <div class="list-icon">&#128421;</div>
                    <div class="list-info">
                        <div class="list-name">${vm.name}</div>
                        <div class="list-meta">${vm.vcpus} vCPU · ${this.formatBytes(vm.memory)}</div>
                    </div>
                    <span class="list-status ${stateClass}"><span class="list-status-dot"></span>${vm.state}</span>
                </div>`;
        }

        // Containers
        const containerList = document.getElementById('containerList');
        containerList.innerHTML = '';
        document.getElementById('containerCount').textContent = this.data.containers.length;
        for (const c of this.data.containers) {
            const name = c.Names ? c.Names[0].replace(/^\//, '') : c.Id.substring(0, 12);
            const ports = c.Ports ? c.Ports.map(p => p.PublicPort || p.PrivatePort).join(', ') : '--';
            containerList.innerHTML += `
                <div class="list-item">
                    <div class="list-icon">&#128230;</div>
                    <div class="list-info">
                        <div class="list-name">${name}</div>
                        <div class="list-meta">${c.Image} · ${ports}</div>
                    </div>
                    <span class="list-status running"><span class="list-status-dot"></span>${c.State}</span>
                </div>`;
        }

        // Services
        const serviceList = document.getElementById('serviceList');
        serviceList.innerHTML = '';
        document.getElementById('serviceCount').textContent = this.data.services.length;
        for (const svc of this.data.services) {
            const stateClass = svc.state === 'RUNNING' ? 'running' : 'stopped';
            serviceList.innerHTML += `
                <div class="list-item">
                    <div class="list-icon">&#9881;</div>
                    <div class="list-info">
                        <div class="list-name">${svc.service}</div>
                        <div class="list-meta">PID: ${svc.pid || '--'} · ${svc.enable ? 'Enabled' : 'Disabled'}</div>
                    </div>
                    <span class="list-status ${stateClass}"><span class="list-status-dot"></span>${svc.state}</span>
                </div>`;
        }

        // Mini charts
        this.drawMiniChart('cpuChart', this.data.cpu.history, 'var(--primary)');
        this.drawMiniChart('memChart', this.data.memory.history, 'var(--info)');
        this.drawMiniChart('diskChart', this.data.disk.history, 'var(--warning)');
        this.drawMiniChart('netChart', this.data.network.rxHistory, 'var(--primary)');
    }

    drawMiniChart(canvasId, data, color) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !data || data.length < 2) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width = canvas.offsetWidth;
        const h = canvas.height = canvas.offsetHeight || 60;
        ctx.clearRect(0, 0, w, h);

        const max = Math.max(...data, 1);
        const step = w / (data.length - 1);

        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < data.length; i++) {
            const x = i * step;
            const y = h - (data[i] / max) * h;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, color + '40');
        grad.addColorStop(1, color + '05');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
            const x = i * step;
            const y = h - (data[i] / max) * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
});
