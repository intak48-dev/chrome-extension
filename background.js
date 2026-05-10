// background.js — Service Worker
'use strict';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ===== 图片工具 =====
const IMG_URL_RE = /https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|bmp)(?:\?[^\s"'<>]*)?/gi;

async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`图片下载失败: ${resp.status}`);
  const blob = await resp.blob();
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mimeType: blob.type || 'image/jpeg' };
}

// 处理消息中的图片（URL自动下载 + 已有base64保留）
async function processMessageImages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || (!msg.images?.length && !msg.content?.match?.(IMG_URL_RE))) {
      result.push(msg);
      continue;
    }
    const images = [];
    // 已附带的图片
    if (msg.images?.length) {
      for (const img of msg.images) {
        if (img.base64) {
          images.push(img);
        } else if (img.url) {
          try {
            const fetched = await fetchImageAsBase64(img.url);
            images.push(fetched);
          } catch (e) { /* skip failed */ }
        }
      }
    }
    // 文本中的图片URL
    let textContent = msg.content || '';
    const urlMatches = textContent.match(IMG_URL_RE) || [];
    for (const url of urlMatches) {
      // 避免重复（已在images中的url）
      if (msg.images?.some(i => i.url === url)) continue;
      try {
        const fetched = await fetchImageAsBase64(url);
        images.push(fetched);
      } catch (e) { /* skip */ }
    }
    result.push({ role: 'user', content: textContent, images });
  }
  return result;
}

// 转OAI多模态格式
function toOaiMessages(messages) {
  return messages.map(msg => {
    if (msg.images?.length) {
      const content = [];
      for (const img of msg.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
        });
      }
      if (msg.content) content.push({ type: 'text', text: msg.content });
      return { role: msg.role, content };
    }
    return { role: msg.role, content: msg.content };
  });
}

// 转Claude多模态格式
function toClaudeMessages(messages) {
  return messages.map(msg => {
    if (msg.images?.length) {
      const content = [];
      for (const img of msg.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
        });
      }
      if (msg.content) content.push({ type: 'text', text: msg.content });
      return { role: msg.role, content };
    }
    return { role: msg.role, content: msg.content };
  });
}

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_CONTENT') {
    getActiveTabContent().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'CHAT_REQUEST') {
    handleChatRequest(msg.payload).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'stream') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'STREAM_CHAT') {
        try {
          await handleStreamRequest(msg.payload, port);
        } catch (err) {
          port.postMessage({ type: 'error', data: err.message });
        }
        port.postMessage({ type: 'done' });
      }
    });
  }
});

// ===== 页面内容获取 =====
async function getActiveTabContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('没有活动标签页');
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTENT' });
  }
}

// ===== Provider =====
async function getActiveProvider() {
  const { providers, activeProvider } = await chrome.storage.local.get(['providers', 'activeProvider']);
  if (!providers || !providers.length) throw new Error('请先在设置页配置API Provider');
  const idx = typeof activeProvider === 'number' ? activeProvider : 0;
  return providers[idx] || providers[0];
}

function buildOaiUrl(apibase) {
  let base = apibase.replace(/\/+$/, '');
  if (!base.includes('/chat/completions')) {
    if (base.endsWith('/v1')) base += '/chat/completions';
    else base += '/v1/chat/completions';
  }
  return base;
}

function buildClaudeUrl(apibase) {
  let base = apibase.replace(/\/+$/, '');
  if (!base.includes('/messages')) base += '/v1/messages';
  return base;
}

// ===== API调用 =====
async function handleChatRequest(payload) {
  const provider = await getActiveProvider();
  const processed = await processMessageImages(payload.messages);
  if (provider.protocol === 'claude') return callClaude(provider, processed, false);
  return callOai(provider, processed, false);
}

// ===== 联网搜索 =====
async function getSearchConfig() {
  const data = await chrome.storage.local.get(['searchApiBase', 'searchApiKey', 'searchModel', 'searchMode']);
  if (!data.searchApiBase || !data.searchApiKey) return null;
  return { apiBase: data.searchApiBase, apiKey: data.searchApiKey, model: data.searchModel || 'grok-3', mode: data.searchMode || 'auto' };
}

async function webSearch(query) {
  const cfg = await getSearchConfig();
  if (!cfg) return null;
  let url = cfg.apiBase.replace(/\/+$/, '');
  if (!url.endsWith('/chat/completions')) {
    url += '/v1/chat/completions';
  }
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: 'You are a search engine. Return ONLY factual information, data, and numbers. No opinions, no advice, no commentary. Be concise and precise. Format: bullet points of facts.' },
      { role: 'user', content: query }
    ],
    max_tokens: 1024,
    stream: false,
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      console.error('[Search] HTTP', resp.status);
      return null;
    }
    const text = await resp.text();
    // 尝试标准JSON解析
    try {
      const data = JSON.parse(text);
      return data.choices?.[0]?.message?.content || null;
    } catch (e) {
      // JSON失败则按SSE格式解析
      let content = '';
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') break;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || '';
          content += delta;
        } catch (e2) { /* skip */ }
      }
      return content || null;
    }
  } catch (e) {
    console.error('[Search]', e);
    return null;
  }
}

// 判断是否需要搜索（auto模式：让搜索引擎自己判断）
function needsSearch(mode, userMsg) {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // auto: 检测时效性关键词
  const timeWords = /最新|今天|现在|近期|最近|新闻|实时|当前|2025|2026|热点|发生了什么|what.?happen|latest|current|recent|today|news/i;
  return timeWords.test(userMsg);
}

async function handleStreamRequest(payload, port) {
  const provider = await getActiveProvider();
  const processed = await processMessageImages(payload.messages);
  // 自动注入当前日期到system prompt，让LLM知道"现在是什么时候"
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const sysDate = { role: 'system', content: `Current date: ${dateStr} ${weekdays[now.getDay()]}` };
  processed.unshift(sysDate);

  // 联网搜索注入
  const searchCfg = await getSearchConfig();
  if (searchCfg) {
    const lastUserMsg = [...processed].reverse().find(m => m.role === 'user');
    const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : (lastUserMsg?.content?.[0]?.text || '');
    if (needsSearch(searchCfg.mode, userText)) {
      port.postMessage({ type: 'search_start' });
      const searchResult = await webSearch(userText);
      if (searchResult) {
        processed.splice(1, 0, { role: 'system', content: `[联网搜索结果]\n${searchResult}\n\n请基于以上实时信息回答用户问题。如果搜索结果与问题无关，可忽略。` });
      }
      port.postMessage({ type: 'search_done' });
    }
  }

  if (provider.protocol === 'claude') await callClaude(provider, processed, true, port);
  else await callOai(provider, processed, true, port);
}

// --- OpenAI兼容 ---
async function callOai(provider, messages, stream, port) {
  const url = buildOaiUrl(provider.apibase);
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apikey}` };
  if (provider.userAgent) headers['User-Agent'] = provider.userAgent;

  const body = {
    model: provider.model,
    messages: toOaiMessages(messages),
    stream,
  };
  if (provider.max_tokens) body.max_tokens = provider.max_tokens;

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API错误 ${resp.status}: ${errText.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await resp.json();
    return { content: data.choices?.[0]?.message?.content || '' };
  }

  // 流式SSE
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) port.postMessage({ type: 'chunk', data: delta });
      } catch (e) { /* skip */ }
    }
  }
}

// --- Claude ---
async function callClaude(provider, messages, stream, port) {
  const url = buildClaudeUrl(provider.apibase);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apikey,
    'anthropic-version': '2023-06-01',
  };
  if (provider.userAgent) headers['User-Agent'] = provider.userAgent;

  let system = '';
  const chatMsgs = [];
  for (const msg of messages) {
    if (msg.role === 'system') { system += (msg.content || '') + '\n'; }
    else chatMsgs.push(msg);
  }

  const body = {
    model: provider.model,
    messages: toClaudeMessages(chatMsgs),
    stream,
    max_tokens: provider.max_tokens || 4096,
  };
  if (system.trim()) body.system = system.trim();

  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API错误 ${resp.status}: ${errText.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await resp.json();
    const text = data.content?.map(b => b.text).join('') || '';
    return { content: text };
  }

  // 流式SSE
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta') {
          const delta = parsed.delta?.text;
          if (delta) port.postMessage({ type: 'chunk', data: delta });
        }
      } catch (e) { /* skip */ }
    }
  }
}
