// server.js
// Локальный сервер для бренд-дек-генератора.
// Держит OpenAI-ключ на бэкенде (никогда не уходит в браузер) и решает CORS,
// потому что фронтенд теперь стучится на свой же origin (/api/...), а не на api.openai.com.

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

app.use(express.json({ limit: '25mb' })); // с запасом — логотипы шлём как base64

// Раздаём саму страницу генератора
app.use(express.static(path.join(__dirname, 'public')));

function requireKey(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server (.env)' });
    return false;
  }
  return true;
}

// Текстовые задачи: легенда логотипа, тэглайны баннеров и т.п.
app.post('/api/text', async (req, res) => {
  if (!requireKey(res)) return;
  const { systemPrompt, userContent } = req.body || {};
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt || '' },
          { role: 'user', content: userContent || '' },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('OpenAI /chat/completions error', r.status, JSON.stringify(data));
      return res.status(r.status).json(data);
    }
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Картиночные задачи: символ / паттерн / баннер / пример лендинга.
// referenceImageDataUrl — необязательный base64 логотипа/символа как визуальный референс.
// ВАЖНО: фронтенд обязан присылать сюда PNG (не SVG) — OpenAI Images API не понимает SVG.
//
// model / fallbackSize (опционально): фронтенд может попросить конкретную
// модель (например gpt-image-2 с произвольным WxH под точный размер баннера).
// Если у этого API-ключа нет доступа к такой модели, OpenAI вернёт ошибку —
// тогда сервер САМ повторяет запрос с дефолтной моделью (IMAGE_MODEL из .env,
// обычно gpt-image-1) и fallbackSize (одним из штатных 1024x1024/1536x1024/
// 1024x1536), чтобы страница не падала.
async function callOpenAIImages(endpoint, buildBody, model, size) {
  const body = buildBody(model, size);
  const r = await fetch(`https://api.openai.com/v1/images/${endpoint}`, {
    method: 'POST',
    headers: body instanceof FormData
      ? { Authorization: `Bearer ${OPENAI_API_KEY}` }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

app.post('/api/image', async (req, res) => {
  if (!requireKey(res)) return;
  const { prompt, referenceImageDataUrl, size, model, fallbackSize } = req.body || {};
  const endpoint = referenceImageDataUrl ? 'edits' : 'generations';

  let refMime = null, refBuffer = null;
  if (referenceImageDataUrl) {
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(referenceImageDataUrl);
    if (!match) {
      return res.status(400).json({ error: 'referenceImageDataUrl must be a data URL like data:image/png;base64,...' });
    }
    refMime = match[1];
    refBuffer = Buffer.from(match[2], 'base64');
  }

  function buildBody(useModel, useSize) {
    if (referenceImageDataUrl) {
      const form = new FormData();
      form.append('model', useModel);
      form.append('prompt', prompt || '');
      form.append('size', useSize || '1024x1024');
      form.append('image', new Blob([refBuffer], { type: refMime }), 'reference.png');
      return form;
    }
    return { model: useModel, prompt: prompt || '', size: useSize || '1024x1024', n: 1 };
  }

  try {
    const wantedModel = model || IMAGE_MODEL;
    let result = await callOpenAIImages(endpoint, buildBody, wantedModel, size);

    // Кастомная модель/размер не прошли (нет доступа к модели, неверный
    // size и т.п.) — тихо повторяем на дефолтной модели и штатном размере.
    if (!result.ok && model && model !== IMAGE_MODEL) {
      console.warn(`OpenAI /images/${endpoint}: "${wantedModel}" failed (${result.status}), retrying with default "${IMAGE_MODEL}"`);
      result = await callOpenAIImages(endpoint, buildBody, IMAGE_MODEL, fallbackSize || size);
    }

    if (!result.ok) {
      console.error(`OpenAI /images/${endpoint} error`, result.status, JSON.stringify(result.data));
      return res.status(result.status).json(result.data);
    }
    const b64 = result.data?.data?.[0]?.b64_json;
    const url = result.data?.data?.[0]?.url;
    res.json({ dataUrl: b64 ? `data:image/png;base64,${b64}` : url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Brand deck generator: http://localhost:${PORT}`);
  console.log(OPENAI_API_KEY ? 'OpenAI key: detected' : 'OpenAI key: NOT set — AI steps will fall back to placeholders');
});
