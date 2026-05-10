// options.js — 设置页逻辑
'use strict';

const providersList = document.getElementById('providers-list');
const btnAddOai = document.getElementById('btn-add-oai');
const btnAddClaude = document.getElementById('btn-add-claude');
const btnSave = document.getElementById('btn-save');
const globalSystemPrompt = document.getElementById('global-system-prompt');
const toast = document.getElementById('toast');

let providers = [];
let activeProvider = 0;

// 初始化加载
init();

async function init() {
  const data = await chrome.storage.local.get(['providers', 'activeProvider', 'globalSystemPrompt', 'ttsApiKey', 'ttsVoice', 'searchApiBase', 'searchApiKey', 'searchModel', 'searchMode']);
  providers = data.providers || [];
  activeProvider = data.activeProvider || 0;
  globalSystemPrompt.value = data.globalSystemPrompt || '';
  document.getElementById('tts-api-key').value = data.ttsApiKey || '';
  document.getElementById('tts-voice').value = data.ttsVoice || '冰糖';
  document.getElementById('search-api-base').value = data.searchApiBase || '';
  document.getElementById('search-api-key').value = data.searchApiKey || '';
  document.getElementById('search-model').value = data.searchModel || 'grok-3';
  document.getElementById('search-mode').value = data.searchMode || 'auto';
  renderProviders();
}

function renderProviders() {
  providersList.innerHTML = '';
  providers.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = `provider-card ${idx === activeProvider ? 'active' : ''}`;
    card.innerHTML = `
      <span class="badge">当前使用</span>
      <div class="form-row">
        <div class="form-group">
          <label>名称</label>
          <input type="text" data-idx="${idx}" data-field="name" value="${esc(p.name || '')}">
        </div>
        <div class="form-group">
          <label>协议</label>
          <select data-idx="${idx}" data-field="protocol">
            <option value="oai" ${p.protocol === 'oai' ? 'selected' : ''}>OpenAI 兼容</option>
            <option value="claude" ${p.protocol === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
          </select>
        </div>
        <div class="form-group">
          <label>模型</label>
          <input type="text" data-idx="${idx}" data-field="model" value="${esc(p.model || '')}" placeholder="gpt-4o / claude-sonnet-4-20250514">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="flex:2;">
          <label>API Base URL</label>
          <input type="text" data-idx="${idx}" data-field="apibase" value="${esc(p.apibase || '')}" placeholder="https://api.example.com">
        </div>
        <div class="form-group" style="flex:2;">
          <label>API Key</label>
          <input type="password" data-idx="${idx}" data-field="apikey" value="${esc(p.apikey || '')}" placeholder="sk-...">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>User-Agent (可选, 绕CF)</label>
          <input type="text" data-idx="${idx}" data-field="userAgent" value="${esc(p.userAgent || '')}" placeholder="Mozilla/5.0 ...">
        </div>
        <div class="form-group" style="max-width:100px;">
          <label>Temperature</label>
          <input type="number" step="0.1" min="0" max="2" data-idx="${idx}" data-field="temperature" value="${p.temperature !== undefined ? p.temperature : ''}">
        </div>
        <div class="form-group" style="max-width:120px;">
          <label>Max Tokens</label>
          <input type="number" data-idx="${idx}" data-field="max_tokens" value="${p.max_tokens || ''}">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn-secondary btn-activate" data-idx="${idx}">${idx === activeProvider ? '✅ 已激活' : '设为当前'}</button>
        <button class="btn-danger btn-delete" data-idx="${idx}">删除</button>
      </div>
    `;
    providersList.appendChild(card);
  });

  // 绑定事件
  providersList.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('change', () => {
      const idx = parseInt(el.dataset.idx);
      const field = el.dataset.field;
      let val = el.value;
      if (field === 'temperature') val = val ? parseFloat(val) : undefined;
      if (field === 'max_tokens') val = val ? parseInt(val) : undefined;
      providers[idx][field] = val;
    });
  });

  providersList.querySelectorAll('.btn-activate').forEach(btn => {
    btn.addEventListener('click', () => {
      activeProvider = parseInt(btn.dataset.idx);
      renderProviders();
    });
  });

  providersList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      providers.splice(idx, 1);
      if (activeProvider >= providers.length) activeProvider = Math.max(0, providers.length - 1);
      renderProviders();
    });
  });
}

function addProvider(protocol) {
  providers.push({
    name: protocol === 'claude' ? '新Claude配置' : '新OAI配置',
    protocol: protocol,
    apibase: '',
    apikey: '',
    model: protocol === 'claude' ? 'claude-sonnet-4-20250514' : 'gpt-4o',
    userAgent: '',
    temperature: undefined,
    max_tokens: protocol === 'claude' ? 4096 : undefined,
  });
  renderProviders();
  // 滚动到底部
  window.scrollTo(0, document.body.scrollHeight);
}

btnAddOai.addEventListener('click', () => addProvider('oai'));
btnAddClaude.addEventListener('click', () => addProvider('claude'));

btnSave.addEventListener('click', async () => {
  // 从DOM重新读取所有值（确保最新）
  providersList.querySelectorAll('input, select').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const field = el.dataset.field;
    if (idx >= providers.length) return;
    let val = el.value;
    if (field === 'temperature') val = val ? parseFloat(val) : undefined;
    if (field === 'max_tokens') val = val ? parseInt(val) : undefined;
    providers[idx][field] = val;
  });

  await chrome.storage.local.set({
    providers,
    activeProvider,
    globalSystemPrompt: globalSystemPrompt.value,
    ttsApiKey: document.getElementById('tts-api-key').value,
    ttsVoice: document.getElementById('tts-voice').value,
    searchApiBase: document.getElementById('search-api-base').value.trim(),
    searchApiKey: document.getElementById('search-api-key').value.trim(),
    searchModel: document.getElementById('search-model').value.trim(),
    searchMode: document.getElementById('search-mode').value,
  });
  showToast('✅ 设置已保存');
});

function showToast(msg, isError = false) {
  toast.textContent = msg;
  toast.className = isError ? 'error' : '';
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

function esc(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
