// content.js — 提取当前页面正文内容
(function() {
  'use strict';

  function extractPageContent() {
    // 优先尝试获取文章主体
    const selectors = [
      'article',
      '[role="main"]',
      '.topic-body',        // Discourse (L站)
      '.post-stream',       // Discourse
      '.cooked',            // Discourse post content
      'main',
      '#content',
      '.content',
      '.post-content',
      '.entry-content',
    ];

    let content = '';
    
    // 尝试用选择器获取主要内容
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        content = Array.from(els).map(el => el.innerText).join('\n\n');
        break;
      }
    }

    // fallback: 取body文本
    if (!content || content.trim().length < 50) {
      content = document.body.innerText;
    }

    // 截断过长内容
    const MAX_LEN = 30000;
    if (content.length > MAX_LEN) {
      content = content.substring(0, MAX_LEN) + '\n\n[...内容已截断]';
    }

    return {
      title: document.title,
      url: window.location.href,
      content: content.trim()
    };
  }

  // 监听来自background/sidepanel的消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_CONTENT') {
      const data = extractPageContent();
      sendResponse(data);
    }
    return true; // async response
  });
})();
