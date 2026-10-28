// 1) 检查 POST /upload 的上传密码
// 2) GIF 改用"文件"方式发给 Telegram，保留动画
const HEADER = "X-MN-Upload-Token";

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");

  if (path === "/upload" && request.method === "POST") {
    // ① 上传密码检查（和之前一样）
    const expected = String(env.MN_INTERNAL_UPLOAD_TOKEN || "").trim();
    if (!expected) {
      return Response.json({ error: "Server missing MN_INTERNAL_UPLOAD_TOKEN" }, { status: 500 });
    }
    const got = (request.headers.get(HEADER) || "").trim();
    if (!safeEqual(got, expected)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // ② 如果是 GIF，自己处理；不是 GIF 就交给原来的上传代码
    try {
      const form = await request.clone().formData();
      const file = form.get("file");
      if (file && typeof file === "object" &&
          (file.type === "image/gif" || /\.gif$/i.test(file.name || ""))) {
        return await uploadGif(env, file);
      }
    } catch (e) {
      // 读表单失败就交给原来的代码，让它报错
    }
  }
  return context.next();
}

// 用"发文件"方式上传 GIF，并让 Telegram 不要转换格式
async function uploadGif(env, file) {
  const fd = new FormData();
  fd.append("chat_id", env.TG_Chat_ID);
  fd.append("document", file, file.name || "image.gif");
  fd.append("disable_content_type_detection", "true");

  const res = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`, {
    method: "POST",
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  const fileId = data?.result?.document?.file_id;

  if (!res.ok || !fileId) {
    return Response.json({ error: data?.description || "GIF upload failed" }, { status: 500 });
  }
  return Response.json([{ src: `/file/${fileId}.gif` }]);
}
