(() => {
  const api = window.fingerprintProxy;
  let state = null;
  let toastTimer = null;
  let refreshBusy = false;
  let serviceBusy = false;

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/><path d="M4 4h16v16H4z" opacity=".15"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    refresh: '<path d="M20 11a8.1 8.1 0 0 0-14.6-3L3 11"/><path d="M3 5v6h6"/><path d="M4 13a8.1 8.1 0 0 0 14.6 3L21 13"/><path d="M21 19v-6h-6"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    restart: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13M9 7V4h6v3"/>',
    shield: '<path d="M12 3 5 6v5c0 4.6 3 8.5 7 10 4-1.5 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
    alert: '<path d="M10.3 3.7 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="m5 12 4 4L19 6"/><circle cx="12" cy="12" r="9"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  };

  const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;

  $('#add-source').innerHTML = icon('plus');
  $('#refresh-icon').innerHTML = icon('refresh');
  $('#play-icon').innerHTML = icon('play');
  $('#stop-icon').innerHTML = icon('stop');
  $('#restart-icon').innerHTML = icon('restart');
  $('#copy-icon').innerHTML = icon('copy');
  $('#clear-logs').innerHTML = icon('trash');
  $('#shield-icon').innerHTML = icon('shield');
  $('#pending-icon').innerHTML = icon('alert');

  function showToast(message, kind = 'normal') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('is-danger', kind === 'danger');
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
  }

  function serviceText(service) {
    const labels = { stopped: ['未运行', '等待启动'], starting: ['启动中', '正在加载配置'], running: ['运行中', service.pid ? `PID ${service.pid}` : 'Mihomo active'], stopping: ['停止中', '正在关闭进程'], error: ['异常', service.lastError || '请查看运行日志'] };
    return labels[service.state] || labels.stopped;
  }

  function renderNotices() {
    const stack = $('#notice-stack');
    if (!state) return;
    const current = state.sources.find((source) => source.isCurrent);
    const notices = [];
    if (current?.status === 'changed') {
      notices.push(`<div class="notice">${icon('alert')}<span>检测到源文件已变化，当前运行配置尚未更新。</span><button data-action="refresh">重新读取</button></div>`);
    } else if (current?.status === 'missing') {
      notices.push(`<div class="notice is-danger">${icon('alert')}<span>原 YAML 不可用，刷新时将使用保存的快照。</span><button data-action="refresh">使用快照</button></div>`);
    }
    if (state.service.configPendingRestart && !state.configNeedsRefresh) {
      notices.push(`<div class="notice">${icon('restart')}<span>新配置已写入，代理仍在使用旧配置。</span><button data-action="restart">现在重启</button></div>`);
    }
    if (state.configNeedsRefresh) {
      notices.push(`<div class="notice">${icon('refresh')}<span>当前配置源或端口设置尚未生成，请先刷新配置。</span><button data-action="refresh">立即刷新</button></div>`);
    }
    stack.innerHTML = notices.join('');
  }

  function renderSources() {
    const list = $('#source-list');
    const sources = state?.sources || [];
    if (!sources.length) {
      list.innerHTML = `<div class="sidebar-empty">还没有 YAML 配置源<br><span>点击右上角导入</span></div>`;
      return;
    }
    list.innerHTML = sources.map((source) => `
      <div class="source-item ${source.isCurrent ? 'is-current' : ''} is-${source.status}" data-source-id="${esc(source.id)}">
        <span class="source-status"></span>
        <div class="source-copy">
          <div class="source-name" title="${esc(source.displayName)}">${esc(source.displayName)}</div>
          <div class="source-path" title="${esc(source.path)}">${esc(source.status === 'missing' ? '原文件缺失 · 使用快照' : source.path)}</div>
        </div>
        <button class="source-delete" data-action="delete" data-source-id="${esc(source.id)}" title="移除配置源" aria-label="移除配置源" ${refreshBusy || serviceBusy ? 'disabled' : ''}>${icon('trash')}</button>
      </div>
    `).join('');
  }

  function renderMain() {
    const busy = refreshBusy || serviceBusy;
    const current = state?.sources?.find((source) => source.isCurrent);
    $('#active-source-title').textContent = current ? current.displayName : '尚未选择配置源';
    $('#active-source-path').textContent = current ? current.path : '导入一个 Clash / Mihomo YAML 文件开始';
    $('#start-port').value = state?.settings?.startPort ?? 20001;
    $('#protocol').value = state?.settings?.protocol ?? 'socks5';
    const importText = state?.importText || '';
    if (document.activeElement !== $('#import-content')) $('#import-content').value = importText;
    const lines = importText.split(/\r?\n/).filter(Boolean);
    $('#node-count').textContent = String(lines.length);
    const ports = lines.map((line) => Number(line.match(/:(\d+)\{/)?.[1])).filter(Number.isFinite);
    $('#port-range').textContent = ports.length ? `${Math.min(...ports)} – ${Math.max(...ports)}` : '尚未生成';
    $('#mixed-port').textContent = state?.mixedPort || '7890';
    const service = state?.service || { state: 'stopped' };
    const [label, detail] = serviceText(service);
    $('#service-label').textContent = label;
    $('#service-detail').textContent = detail;
    $('#status-dot').className = `status-dot is-${service.state === 'running' ? 'running' : service.state === 'starting' || service.state === 'stopping' ? 'starting' : service.state === 'error' ? 'error' : 'idle'}`;
    const processActive = ['running', 'starting', 'stopping'].includes(service.state) || (service.state === 'error' && Boolean(service.pid));
    $('#start-service').disabled = busy || processActive || !importText;
    $('#stop-service').disabled = busy || !processActive;
    $('#restart-service').disabled = busy || !importText || service.state === 'starting' || service.state === 'stopping';
    $('#refresh-source').disabled = busy || !current;
    $('#copy-import').disabled = busy || !importText || state.configNeedsRefresh;
    $('#add-source').disabled = busy;
    $('#start-port').disabled = busy;
    $('#protocol').disabled = busy;
    $('#pending-chip').classList.toggle('hidden', !service.configPendingRestart || state.configNeedsRefresh);
    $('#logs-content').textContent = (state?.logs || []).join('\n');
    renderSources();
    renderNotices();
  }

  async function reloadState() {
    state = await api.state.get();
    renderMain();
  }

  async function safeReloadState() {
    try {
      await reloadState();
    } catch (error) {
      showToast(error.message || String(error), 'danger');
      if (state) renderMain();
    }
  }

  async function refreshCurrent() {
    if (refreshBusy || serviceBusy) return;
    const current = state?.sources?.find((source) => source.isCurrent);
    if (!current) return showToast('请先导入或选择一个 YAML 配置源。', 'danger');
    const startPort = Number($('#start-port').value);
    const protocol = $('#protocol').value === 'http' ? 'http' : 'socks5';
    if (!Number.isInteger(startPort) || startPort < 1024 || startPort > 65535) return showToast('起始端口必须是 1024-65535 之间的整数。', 'danger');
    refreshBusy = true;
    renderMain();
    try {
      await api.settings.update({ startPort, protocol });
      const result = await api.sources.refresh({ sourceId: current.id, startPort, protocol });
      if (!result.ok) showToast(result.error || '刷新失败。', 'danger');
      else showToast(`已生成 ${result.nodeCount} 个本地入口。`);
    } catch (error) {
      showToast(error.message || String(error), 'danger');
    } finally {
      refreshBusy = false;
      await safeReloadState();
    }
  }

  async function serviceAction(action) {
    if (refreshBusy || serviceBusy) return;
    serviceBusy = true;
    renderMain();
    try {
      const result = await api.service[action]();
      if (result?.state === 'error') showToast(result.lastError || '代理服务操作失败。', 'danger');
    } catch (error) {
      showToast(error.message || String(error), 'danger');
    } finally {
      serviceBusy = false;
      await safeReloadState();
    }
  }

  $('#add-source').addEventListener('click', async () => {
    if (refreshBusy || serviceBusy) return;
    try {
      const result = await api.sources.add();
      if (result?.error) showToast(result.error, 'danger');
      else if (result?.ok) showToast(`已导入 ${result.source.displayName}。`);
    } catch (error) {
      showToast(error.message || String(error), 'danger');
    } finally {
      await safeReloadState();
    }
  });

  $('#refresh-source').addEventListener('click', refreshCurrent);
  $('#start-service').addEventListener('click', () => serviceAction('start'));
  $('#stop-service').addEventListener('click', () => serviceAction('stop'));
  $('#restart-service').addEventListener('click', () => serviceAction('restart'));
  $('#copy-import').addEventListener('click', async () => {
    if (refreshBusy || serviceBusy || state?.configNeedsRefresh) return;
    try {
      const result = await api.proxyImport.copy();
      const length = Number(result?.length) || 0;
      showToast(length > 0 ? `已复制 ${length} 个字符。` : '当前没有可复制内容。', length > 0 ? 'normal' : 'danger');
    } catch (error) {
      showToast(error.message || String(error), 'danger');
    }
  });
  $('#clear-logs').addEventListener('click', async () => {
    try {
      await api.logs.clear();
    } catch (error) {
      showToast(error.message || String(error), 'danger');
    } finally {
      await safeReloadState();
    }
  });
  $('#start-port').addEventListener('change', async () => {
    const value = Number($('#start-port').value);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      showToast('起始端口必须是 1024-65535 之间的整数。', 'danger');
      renderMain();
      return;
    }
    try {
      await api.settings.update({ startPort: value });
    } catch (error) {
      showToast(error.message || String(error), 'danger');
      await safeReloadState();
    }
  });
  $('#protocol').addEventListener('change', async () => {
    try {
      await api.settings.update({ protocol: $('#protocol').value === 'http' ? 'http' : 'socks5' });
    } catch (error) {
      showToast(error.message || String(error), 'danger');
      await safeReloadState();
    }
  });

  $('#source-list').addEventListener('click', async (event) => {
    if (refreshBusy || serviceBusy) return;
    const deleteButton = event.target.closest('[data-action="delete"]');
    if (deleteButton) {
      event.stopPropagation();
      const sourceId = deleteButton.dataset.sourceId;
      const source = state.sources.find((item) => item.id === sourceId);
      if (!source || !window.confirm(`移除配置源“${source.displayName}”？`)) return;
      try { await api.sources.remove(sourceId); showToast('配置源已移除。'); await safeReloadState(); } catch (error) { showToast(error.message || String(error), 'danger'); }
      return;
    }
    const item = event.target.closest('[data-source-id]');
    if (!item) return;
    try { await api.sources.select(item.dataset.sourceId); await safeReloadState(); } catch (error) { showToast(error.message || String(error), 'danger'); }
  });

  $('#notice-stack').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'refresh') void refreshCurrent();
    if (button.dataset.action === 'restart') void serviceAction('restart');
  });

  api.onStateChanged((nextState) => { state = nextState; renderMain(); });
  api.onLog((line) => {
    if (line?.clear) $('#logs-content').textContent = '';
    else if (typeof line === 'string') $('#logs-content').textContent = `${$('#logs-content').textContent}${$('#logs-content').textContent ? '\n' : ''}${line}`;
  });
  void safeReloadState();
})();
