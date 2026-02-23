export async function onRequest(context) {
  const { request, env, params } = context;

  const url = new URL(request.url);
  const seg = decodeURIComponent(String(params?.id || "")).trim(); // e.g. AgAC...BA.png
  const segNoExt = seg.replace(/\.[A-Za-z0-9]{1,10}$/i, ""); // remove .png/.jpg...

  // 默认走 telegra.ph（Telegraph 老链）
  let upstreamUrl = "https://telegra.ph" + url.pathname + url.search;

  // Telegram Bot API 文件：通常 file_id 很长（你之前用 length>39 判断，我保留但更稳一点）
  const looksLikeTgFileId = segNoExt.length > 39 && /^[A-Za-z0-9_-]+$/.test(segNoExt);

  if (looksLikeTgFileId) {
    const token = env?.TG_Bot_Token ? String(env.TG_Bot_Token).trim() : "";
    if (token) {
      const filePath = await getFilePath(env, segNoExt);
      if (filePath) {
        upstreamUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
      }
    }
  }

  // 只透传必要请求头（避免把一堆不相关 header 转发给上游）
  const upstreamHeaders = new Headers();
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.set("Range", range);

  // GET/HEAD 不要带 body（CF fetch 对 GET 带 body 有时会出问题）
  const method = request.method.toUpperCase();
  const init =
    method === "GET" || method === "HEAD"
      ? { method, headers: upstreamHeaders }
      : { method, headers: upstreamHeaders, body: request.body };

  const upstream = await fetch(upstreamUrl, init);
  if (!upstream.ok) return upstream;

  // ✅ 统一把返回变成“可预览图片”（inline + image/*）
  const inlineResponse = asInlineImage(upstream, url.pathname);

  // admin 页面也应该能预览（否则还是下载）
  const isAdmin = request.headers.get("Referer")?.includes(`${url.origin}/admin`);
  if (isAdmin) return inlineResponse;

  // 没 KV 就直接返回图片
  if (!env.img_url) return inlineResponse;

  // KV 元数据
  let record = await env.img_url.getWithMetadata(params.id);
  if (!record || !record.metadata) {
    record = {
      metadata: {
        ListType: "None",
        Label: "None",
        TimeStamp: Date.now(),
        liked: false,
        fileName: params.id,
        fileSize: 0,
      },
    };
    await env.img_url.put(params.id, "", { metadata: record.metadata });
  }

  const metadata = {
    ListType: record.metadata.ListType || "None",
    Label: record.metadata.Label || "None",
    TimeStamp: record.metadata.TimeStamp || Date.now(),
    liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
    fileName: record.metadata.fileName || params.id,
    fileSize: record.metadata.fileSize || getContentLength(upstream) || 0,
  };

  if (metadata.ListType === "White") {
    await env.img_url.put(params.id, "", { metadata });
    return inlineResponse;
  }

  if (metadata.ListType === "Block" || metadata.Label === "adult") {
    const referer = request.headers.get("Referer");
    const redirectUrl = referer
      ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
      : `${url.origin}/block-img.html`;
    return Response.redirect(redirectUrl, 302);
  }

  if (env.WhiteList_Mode === "true") {
    return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
  }

  // 内容审查：只有 telegra.ph 链接才去审查（Telegram file 链接审查通常会失败/没意义）
  if (env.ModerateContentApiKey && upstreamUrl.startsWith("https://telegra.ph/")) {
    try {
      const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=${encodeURIComponent(
        upstreamUrl
      )}`;
      const moderateRes = await fetch(moderateUrl);
      if (moderateRes.ok) {
        const moderateData = await moderateRes.json();
        if (moderateData?.rating_label) {
          metadata.Label = moderateData.rating_label;
          if (metadata.Label === "adult") {
            await env.img_url.put(params.id, "", { metadata });
            return Response.redirect(`${url.origin}/block-img.html`, 302);
          }
        }
      }
    } catch {
      // 审查失败不影响正常访问
    }
  }

  await env.img_url.put(params.id, "", { metadata });
  return inlineResponse;
}

function asInlineImage(upstream, pathname) {
  const headers = new Headers(upstream.headers);

  // ✅ 关键：把下载附件改成内联预览
  headers.set("Content-Disposition", "inline");

  // ✅ 关键：确保 Content-Type 是 image/*
  const guessed = guessContentType(pathname);
  const ct = (headers.get("Content-Type") || "").toLowerCase();
  if (guessed) {
    if (!ct.startsWith("image/") || ct.includes("octet-stream")) {
      headers.set("Content-Type", guessed);
    }
  }

  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function guessContentType(pathname) {
  const ext = (String(pathname).split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    default:
      return "";
  }
}

function getContentLength(res) {
  const v = res.headers.get("content-length");
  const n = v ? parseInt(v, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function getFilePath(env, file_id) {
  try {
    const token = env?.TG_Bot_Token ? String(env.TG_Bot_Token).trim() : "";
    if (!token) return null;

    const api = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(file_id)}`;
    const res = await fetch(api, { method: "GET" });
    if (!res.ok) return null;

    const data = await res.json();
    if (data?.ok && data?.result?.file_path) return data.result.file_path;
    return null;
  } catch {
    return null;
  }
}
