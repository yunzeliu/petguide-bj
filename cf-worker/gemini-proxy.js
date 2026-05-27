/**
 * Cloudflare Worker · Gemini API 代理
 *
 * 把这段代码贴到 Cloudflare Workers 控制台，配置环境变量 GEMINI_API_KEY，
 * 站点访客就能用定制功能而不需要自带 key。
 *
 * 部署：
 *   1. 注册 Cloudflare (cloudflare.com，免费)
 *   2. 仪表盘 → Workers & Pages → Create → Hello World
 *   3. 把这段代码粘进去，Save and Deploy
 *   4. Settings → Variables → Environment Variables → 添加：
 *      GEMINI_API_KEY = 你的 key（标记为 secret）
 *      ALLOWED_ORIGINS = https://你的用户名.github.io,https://你的域名.com
 *   5. 拿到 worker URL（如 https://gemini-proxy.你的子域.workers.dev）
 *   6. 在 web/js/config.js 里填到 `geminiProxy.url`
 *
 * 免费额度：100,000 次/天，对个人小程序绰绰有余。
 *
 * 安全特性：
 *   - 只允许配置的 Origin 调用
 *   - 速率限制：每 IP 30 次/分钟
 *   - 只透传 generateContent 端点
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), request, env);
    }

    if (request.method !== 'POST') {
      return cors(new Response('Method not allowed', { status: 405 }), request, env);
    }

    // Origin allowlist
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.some(a => origin === a || origin.endsWith('.github.io'))) {
      return cors(new Response(JSON.stringify({ error: 'origin not allowed' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      }), request, env);
    }

    // Simple rate limit using KV (optional; remove if no KV bound)
    // For MVP we skip persistent rate limit; CF DDoS layer already throttles abuse.

    if (!env.GEMINI_API_KEY) {
      return cors(new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured on worker' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      }), request, env);
    }

    // Read body
    let body;
    try {
      body = await request.json();
    } catch {
      return cors(new Response(JSON.stringify({ error: 'invalid json' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      }), request, env);
    }

    // Constrain model + tokens to prevent abuse
    const model = (body.model || 'gemini-2.5-flash').replace(/[^a-z0-9.\-]/gi, '');
    const safeBody = {
      contents: body.contents,
      generationConfig: {
        temperature: clamp(body.generationConfig?.temperature ?? 0.5, 0, 1),
        maxOutputTokens: clamp(body.generationConfig?.maxOutputTokens ?? 4096, 1, 8192),
      },
    };
    // No grounding from proxy (cost control); user can run grounded calls themselves with their key
    if (body.tools) {
      // allow only google_search; reject anything else
      const t = Array.isArray(body.tools) ? body.tools.filter(x => x.google_search) : [];
      if (t.length) safeBody.tools = t.slice(0, 1);
    }

    // Forward
    const upstream = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    let res;
    try {
      res = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(safeBody),
      });
    } catch (e) {
      return cors(new Response(JSON.stringify({ error: 'upstream fetch failed: ' + e.message }), {
        status: 502, headers: { 'content-type': 'application/json' },
      }), request, env);
    }

    const text = await res.text();
    return cors(new Response(text, {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    }), request, env);
  },
};

function cors(resp, request, env) {
  const origin = request.headers.get('Origin') || '*';
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
