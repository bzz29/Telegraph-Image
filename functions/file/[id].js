export async function onRequest(context) {
  const { request, env, params } = context;

  const url = new URL(request.url);

  // 默认走 telegra.ph（老链）
  let fileUrl = "https://telegra.ph" + url.pathname + url.search;

  // Path length > 39 indicates file uploaded via Telegram Bot API
  if (url.pathname.length > 39) {
    // /file/AgAC...BA.png  -> 取中间那段 file_id（不含扩展名）
    const fileId = url.pathname.split(".")[0].split("/")[2];
    console.log("fileId:", fileId);

    const filePath = await getFilePath(env, fileId);
    console.log("filePath:", filePath);

    if (!filePath) {
      return new Response("Failed to resolve telegram file path", {
        status: 502,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
  }

  // 透传请求到上游（保持你原来的行为）
  const upstreamReq = new Request(fileUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow",
  });

  const upstreamRes = await fetch(upstreamReq);

  // 上游失败直接返回（保持原逻辑）
  if (!upstreamRes.ok) return upstreamRes;

  // ✅ 关键修复：强制 inline + 补正确 Content-Type，避免浏览器/Discuz 当附件下载
  const imageRes = asInlineImageResponse(upstreamRes, url.pathname);

  // Allow the admin page to directly view the image（修复后这里也不会下载了）
  const isAdmin = request.headers.get("Referer")?.includes(`${url.origin}/admin`);
  if (isAdmin) return imageRes;

  // 没 KV 就直接返回图片（保持原逻辑）
  if (!env.img_url) {
    console.log("KV storage not available, returning image directly");
    return imageRes;
  }

  // KV 元数据逻辑（保持不变）
  let record = await env.img_url.getWithMetadata(params.id);

  if (!record || !record.metadata) {
    console.log("Metadata not found, initializing...");
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
    fileSize: record.metadata.fileSize || 0,
  };

  // Handle based on ListType and Label（保持不变）
  if (metadata.ListType === "White") {
    return imageRes;
  } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
    const referer = request.headers.get("Referer");
    const redirectUrl = referer
      ? "https://static-res.pages.dev/teleimage/img-block-compressed.png"
      : `${url.origin}/block-img.html`;
    return Response.redirect(redirectUrl, 302);
  }

  // Check if WhiteList_Mode is enabled（保持不变）
  if (env.WhiteList_Mode === "true") {
    return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
  }

  // Moderate content（保持你原来的逻辑：仍用 telegra.ph 的 URL 去审核）
  if (env.ModerateContentApiKey) {
    try {
      console.log("Starting content moderation...");
      const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
      const moderateResponse = await fetch(moderateUrl);

      if (!moderateResponse.ok) {
        console.error("Content moderation API request failed: " + moderateResponse.status);
      } else {
        const moderateData = await moderateResponse.json();
        console.log("Content moderation results:", moderateData);

        if (moderateData && moderateData.rating_label) {
          metadata.Label = moderateData.rating_label;

          if (moderateData.rating_label === "adult") {
            console.log("Content marked as adult, saving metadata and redirecting");
            await env.img_url.put(params.id, "", { metadata });
            return Response.redirect(`${url.origin}/block-img.html`, 302);
          }
        }
      }
    } catch (error) {
      console.error("Error during content moderation: " + (error?.message || String(error)));
      // 审核失败不影响用户体验：继续执行
    }
  }

  console.log("Saving metadata");
  await env.img_url.put(params.id, "", { metadata });

  // Return file content（改为返回修复后的 imageRes）
  return imageRes;
}

function asInlineImageResponse(upstreamRes, pathname) {
  const headers = new Headers(upstreamRes.headers);

  // ✅ 强制 inline：避免下载
  headers.set("Content-Disposition", "inline");

  // ✅ 补/纠正 Content-Type：避免 octet-stream 导致 Discuz/浏览器不当图处理
  const currentCT = (headers.get("Content-Type") || "").toLowerCase();
  const guessedCT = guessContentType(pathname);

  if (!currentCT.startsWith("image/")) {
    if (guessedCT) headers.set("Content-Type", guessedCT);
  }

  // 安全兜底
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
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

async function getFilePath(env, file_id) {
  try {
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
    const res = await fetch(apiUrl, { method: "GET" });

    if (!res.ok) {
      console.error(`HTTP error! status: ${res.status}`);
      return null;
    }

    const responseData = await res.json();
    const { ok, result } = responseData;

    if (ok && result) {
      return result.file_path;
    } else {
      console.error("Error in response data:", responseData);
      return null;
    }
  } catch (error) {
    console.error("Error fetching file path:", error?.message || String(error));
    return null;
  }
}
