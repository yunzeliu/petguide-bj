/**
 * Cloudflare Worker · Gemini API 代理
 *
 * 用途：浏览器把生成请求发到这里，Worker 加上你的 Gemini key 转给 Google，
 * 返回结果给浏览器。key 全程不出现在前端，访客无门槛使用。
 *
 * 配套部署文档：见 web/docs/CLOUDFLARE_WORKER.md
 *
 * 必须配置的环境变量（在 CF 仪表盘 Worker → Settings → Variables and Secrets）:
 *   - GEMINI_API_KEY  (Secret)  你的 Gemini key
 *   - ALLOWED_ORIGINS (Plain)   逗号分隔，如：
 *                                  https://yunzeliu.github.io
 *                                  或加自定义域名 https://yunzeliu.github.io,https://wangxing.cn
 */

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }), request, env);
    }

    // health check
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/') {
      if (request.method === 'GET') {
        return json({ ok: true, service: 'gemini-proxy', has_key: Boolean(env.GEMINI_API_KEY) }, 200, request, env);
      }
    }

    if (request.method !== 'POST') {
      return cors(new Response('Method not allowed. Use POST.', { status: 405 }), request, env);
    }

    // Origin allowlist
    const origin = request.headers.get('Origin') || '';
    const allowed = parseList(env.ALLOWED_ORIGINS);
    if (allowed.length === 0) {
      return json({ error: 'ALLOWED_ORIGINS env var not configured' }, 500, request, env);
    }
    if (origin && !allowed.includes(origin)) {
      return json({ error: 'origin not allowed: ' + origin }, 403, request, env);
    }
    // empty Origin (e.g., curl test) — allow but flag it

    if (!env.GEMINI_API_KEY) {
      return json({ error: 'GEMINI_API_KEY not configured' }, 500, request, env);
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json body' }, 400, request, env);
    }

    if (!body.contents) {
      return json({ error: 'missing "contents" field' }, 400, request, env);
    }

    // Sanitize: lock down model + token caps to prevent abuse
    const model = (body.model || 'gemini-2.5-flash').toString().replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 64);
    if (!model.startsWith('gemini-')) {
      return json({ error: 'invalid model name' }, 400, request, env);
    }
    const safeBody = {
      contents: body.contents,
      generationConfig: {
        temperature: clamp(body.generationConfig && body.generationConfig.temperature, 0, 1, 0.5),
        maxOutputTokens: clamp(body.generationConfig && body.generationConfig.maxOutputTokens, 1, 8192, 4096),
      },
    };
    // Only allow google_search tool (not anything custom)
    if (Array.isArray(body.tools)) {
      const t = body.tools.filter(x => x && x.google_search).slice(0, 1);
      if (t.length) safeBody.tools = t;
    }

    // Forward to Gemini
    const upstream = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    let res;
    try {
      res = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(safeBody),
      });
    } catch (e) {
      return json({ error: 'upstream fetch failed: ' + (e && e.message || e) }, 502, request, env);
    }

    const text = await res.text();
    const out = new Response(text, {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
    return cors(out, request, env);
  },
};

function json(obj, status, request, env) {
  return cors(new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  }), request, env);
}

function cors(resp, request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseList(env.ALLOWED_ORIGINS);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '*');
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', allowOrigin);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function parseList(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function clamp(n, lo, hi, def) {
  n = Number(n);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
