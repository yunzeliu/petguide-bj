// 站点配置 —— 改这里，不需要碰 app.js
window.PETGUIDE_CONFIG = {
  // ============ 访问统计 ============
  // 默认用 Umami Cloud 免费版（10k events/月）
  // 注册 https://cloud.umami.is → 新建网站 → 拿到 Website ID 填这里
  // 留空 = 不启用统计
  umami: {
    websiteId: '',   // 例如 "abcd1234-..." 在 Umami 控制台 → 网站 → Tracking code 里
    src: 'https://cloud.umami.is/script.js',  // 自托管 Umami 改成你自己的 URL
  },

  // 备选：GoatCounter（无需注册可直接用，更轻量）
  // 想用就把 umami.websiteId 留空，把 goatCounter.code 填上
  goatCounter: {
    code: '',        // 注册后会给你一个 code，比如 "yourname-petguide"
  },

  // ============ 反馈联系方式 ============
  contact: {
    email: 'hello@example.com',
    wechat: '',     // 微信号或公众号
  },

  // ============ Gemini Proxy ============
  // 部署到 Cloudflare Worker，key 藏在服务端
  geminiProxy: {
    url: 'https://petguide-gemini.liuyzchina.workers.dev',
  },

  // ============ 不要在这里硬编码 Gemini key —— 静态站会被任何人拿走 ============
  // 安全方案二选一：
  //   1) 部署上面的 geminiProxy（key 藏在 Cloudflare Worker）
  //   2) "请求 → 批处理"模式（见 docs/BATCH_MODE.md）
  gemini: { fallbackKey: '' },

  // ============ 备案号（中国大陆部署到自己服务器时需要） ============
  // GitHub Pages 不需要 ICP 备案
  icp: '',
};
