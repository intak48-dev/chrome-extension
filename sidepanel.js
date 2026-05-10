// sidepanel.js — 聊天交互逻辑（支持图片）
'use strict';

const chatContainer = document.getElementById('chat-container');
const input = document.getElementById('input');
const btnSend = document.getElementById('btn-send');
const btnGrab = document.getElementById('btn-grab');
const btnClear = document.getElementById('btn-clear');
const btnSettings = document.getElementById('btn-settings');
const btnTts = document.getElementById('btn-tts');
const providerNameEl = document.getElementById('provider-name');
const pageStatusEl = document.getElementById('page-status');
const imagePreview = document.getElementById('image-preview');
const inputArea = document.getElementById('input-area');

let conversationHistory = [];
let pageContext = null;
let pendingImages = []; // {base64, mimeType, url?}
let ttsEnabled = false;

// ===== TTS =====
let ttsAudio = null;
btnTts.addEventListener('click', () => {
  ttsEnabled = !ttsEnabled;
  btnTts.textContent = ttsEnabled ? '🔊' : '🔇';
  btnTts.title = ttsEnabled ? '语音朗读：开' : '语音朗读：关';
  if (!ttsEnabled && ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
});

async function speakText(text) {
  if (!ttsEnabled || !text) return;
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }

  const data = await chrome.storage.local.get(['ttsApiKey', 'ttsVoice']);
  const apiKey = data.ttsApiKey;
  if (!apiKey) { console.warn('TTS: 未配置API Key'); return; }
  const voice = data.ttsVoice || '冰糖';

  try {
    const resp = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        messages: [
          { role: 'user', content: '用自然流畅的语调朗读以下内容' },
          { role: 'assistant', content: text.slice(0, 2000) }
        ],
        audio: { format: 'wav', voice }
      })
    });
    if (!resp.ok) { console.error('TTS API error:', resp.status); return; }

    const result = await resp.json();
    const audioB64 = result.choices?.[0]?.message?.audio?.data;
    if (!audioB64) { console.error('TTS: no audio data in response'); return; }

    ttsAudio = new Audio('data:audio/wav;base64,' + audioB64);
    ttsAudio.play();
  } catch (e) {
    console.error('TTS error:', e);
  }
}

// ===== 初始化 =====
updateProviderDisplay();
addSystemMsg('点击「抓取页面」获取当前页面内容，然后开始对话。');

// ===== 图片处理 =====

// 粘贴图片
input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      readFileAsImage(file);
    }
  }
});

// 拖拽图片
inputArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  inputArea.classList.add('drag-over');
});
inputArea.addEventListener('dragleave', () => {
  inputArea.classList.remove('drag-over');
});
inputArea.addEventListener('drop', (e) => {
  e.preventDefault();
  inputArea.classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (files) {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        readFileAsImage(file);
      }
    }
  }
  // 也检查拖拽的URL
  const text = e.dataTransfer?.getData('text/plain');
  if (text && isImageUrl(text)) {
    addImageByUrl(text);
  }
});

function readFileAsImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    const mimeType = file.type || 'image/png';
    pendingImages.push({ base64, mimeType });
    renderImagePreview();
  };
  reader.readAsDataURL(file);
}

function addImageByUrl(url) {
  // 标记为URL类型，发送时由background下载转base64
  pendingImages.push({ url, base64: null, mimeType: null });
  renderImagePreview();
}

function isImageUrl(text) {
  return /https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:\?[^\s"'<>]*)?$/i.test(text.trim());
}

function renderImagePreview() {
  if (pendingImages.length === 0) {
    imagePreview.style.display = 'none';
    imagePreview.innerHTML = '';
    return;
  }
  imagePreview.style.display = 'flex';
  imagePreview.innerHTML = '';
  pendingImages.forEach((img, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'img-thumb';
    const imgEl = document.createElement('img');
    if (img.base64) {
      imgEl.src = `data:${img.mimeType};base64,${img.base64}`;
    } else {
      imgEl.src = img.url;
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-img';
    removeBtn.textContent = '×';
    removeBtn.onclick = () => {
      pendingImages.splice(idx, 1);
      renderImagePreview();
    };
    thumb.appendChild(imgEl);
    thumb.appendChild(removeBtn);
    imagePreview.appendChild(thumb);
  });
}

// ===== 发送消息 =====
async function sendMessage() {
  const text = input.value.trim();
  if (!text && pendingImages.length === 0) return;

  // 构建用户消息（含图片附件信息）
  const userMsg = { role: 'user', content: text, images: [...pendingImages] };
  conversationHistory.push(userMsg);

  // 显示用户消息
  addUserMsg(text, pendingImages);
  input.value = '';
  pendingImages = [];
  renderImagePreview();

  // 构建发送给API的messages
  const apiMessages = buildApiMessages();

  btnSend.disabled = true;
  const assistantEl = addAssistantMsg('');

  try {
    // 使用流式
    const port = chrome.runtime.connect({ name: 'stream' });
    port.postMessage({ type: 'STREAM_CHAT', payload: { messages: apiMessages } });

    let fullResponse = '';
    port.onMessage.addListener((msg) => {
      if (msg.type === 'search_start') {
        assistantEl.textContent = '🔍 正在联网搜索...';
      } else if (msg.type === 'search_done') {
        assistantEl.textContent = '';
      } else if (msg.type === 'chunk') {
        fullResponse += msg.data;
        assistantEl.textContent = fullResponse;
        chatContainer.scrollTop = chatContainer.scrollHeight;
      } else if (msg.type === 'done') {
        conversationHistory.push({ role: 'assistant', content: fullResponse });
        speakText(fullResponse);
        btnSend.disabled = false;
      } else if (msg.type === 'error') {
        assistantEl.textContent = '';
        addErrorMsg(msg.data);
        btnSend.disabled = false;
      }
    });
    port.onDisconnect.addListener(() => {
      if (!fullResponse && !assistantEl.textContent) {
        addErrorMsg('连接断开');
      }
      btnSend.disabled = false;
    });
  } catch (err) {
    addErrorMsg(err.message);
    btnSend.disabled = false;
  }
}

function buildApiMessages() {
  const msgs = [];
  // System prompt with page context
  let systemContent = '';
  const stored = localStorage.getItem('globalSystemPrompt');
  if (stored) systemContent += stored + '\n';
  if (pageContext) {
    systemContent += `\n当前页面标题: ${pageContext.title}\n页面URL: ${pageContext.url}\n\n页面内容:\n${pageContext.content}`;
  }
  if (systemContent) {
    msgs.push({ role: 'system', content: systemContent.trim() });
  }

  // 对话历史
  for (const msg of conversationHistory) {
    if (msg.role === 'user') {
      msgs.push({ role: 'user', content: msg.content, images: msg.images || [] });
    } else {
      msgs.push({ role: msg.role, content: msg.content });
    }
  }
  return msgs;
}

// ===== UI辅助 =====
function addUserMsg(text, images) {
  const el = document.createElement('div');
  el.className = 'msg user';
  let html = '';
  if (images && images.length > 0) {
    html += '<div style="margin-bottom:6px;">';
    images.forEach(img => {
      const src = img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url;
      html += `<img src="${src}" style="max-height:80px;border-radius:6px;margin-right:4px;">`;
    });
    html += '</div>';
  }
  html += escapeHtml(text);
  el.innerHTML = html;
  chatContainer.appendChild(el);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addAssistantMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.textContent = text;
  chatContainer.appendChild(el);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return el;
}

function addSystemMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg system-msg';
  el.textContent = text;
  chatContainer.appendChild(el);
}

function addErrorMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg error';
  el.textContent = '❌ ' + text;
  chatContainer.appendChild(el);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===== Provider显示 =====
async function updateProviderDisplay() {
  const data = await chrome.storage.local.get(['providers', 'activeProvider']);
  const providers = data.providers || [];
  const idx = typeof data.activeProvider === 'number' ? data.activeProvider : 0;
  const active = providers[idx];
  providerNameEl.textContent = active ? `${active.name} (${active.model})` : '未配置';

  // 同步system prompt
  const d2 = await chrome.storage.local.get('globalSystemPrompt');
  if (d2.globalSystemPrompt) localStorage.setItem('globalSystemPrompt', d2.globalSystemPrompt);
}

// ===== 事件绑定 =====
btnSend.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// 抓取页面
btnGrab.addEventListener('click', async () => {
  pageStatusEl.textContent = '抓取中...';
  chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTENT' }, (resp) => {
    if (resp && !resp.error) {
      pageContext = resp;
      const len = resp.content?.length || 0;
      pageStatusEl.textContent = `已抓取 (${len}字)`;
      addSystemMsg(`已抓取页面: ${resp.title} (${len}字)`);
    } else {
      pageStatusEl.textContent = '抓取失败';
      addErrorMsg(resp?.error || '无法获取页面内容');
    }
  });
});

// 清空
btnClear.addEventListener('click', () => {
  conversationHistory = [];
  pageContext = null;
  pendingImages = [];
  renderImagePreview();
  chatContainer.innerHTML = '';
  pageStatusEl.textContent = '页面未抓取';
  addSystemMsg('对话已清空。点击「抓取页面」重新开始。');
});

// 打开设置
btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 监听storage变化
chrome.storage.onChanged.addListener((changes) => {
  if (changes.providers || changes.activeProvider) {
    updateProviderDisplay();
  }
});
