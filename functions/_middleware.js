// 1) 检查 POST /upload 的上传密码
// 2) 动图、透明图等格式用"文件"方式原样存到 Telegram，不被压缩
const HEADER = "X-MN-Upload-Token";

// ===== 可以调整的开关 =====
// 这些格式原样保存（动图会动、透明背景保留）
const RAW_EXTENSIONS = ["gif", "webp", "png", "apng", "avif"];
// 想让 jpg 也保存原图（不压缩），把 false 改成 true
const KEEP_ORIGINAL_JPG = false;
// Telegram 只能取回 20MB 以内的文件
const MAX_SIZE = 20 * 1024 * 1024;
// =========================

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// 取文件扩展名：优先看文件名，没有就看文件类型
function getExtension(file) {
  const name = String(file.name || "");
  const dot = name.lastIndexOf(".");
  if (dot !== -1) return name.slice(dot + 1).toLowerCase();
  const type = String(file.type || "");
  return type.startsWith("image/") ? type.slice(6).toLowerCase() : "";
}

function shouldKeepRaw(ext) {
  if (RAW_EXTENSIONS.includes(ext)) return true;
  if (KEEP_ORIGINAL_JPG && (ext === "jpg" || ext === "jpeg")) return true;
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");

  if (path === "/upload" && request.method === "POST") {
    // ① 上传密码检查
    const expected = String(env.MN_INTERNAL_UPLOAD_TOKEN || "").trim();
    if (!expected) {
      return Response.json({ error: "Server missing MN_INTERNAL_UPLOAD_TOKEN" }, { status: 500 });
    }
    const got = (request.headers.get(HEADER) || "").trim();
    if (!safeEqual(got, expected)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // ② 需要原样保存的格式自己处理，其他交给原来的上传代码
    try {
      const form = await request.clone().formData();
      const file = form.get("file");
      if (file && typeof file === "object") {
        const ext = getExtension(file);
        if (shouldKeepRaw(ext)) {
          if (file.size > MAX_SIZE) {
            return Response.json({ error: "文件超过 20MB，无法上传" }, { status: 413 });
          }
          return await uploadRaw(env, file, ext);
        }
      }
    } catch (e) {
      // 读表单失败就交给原来的代码，让它报错
    }
  }
  return context.next();
}

// 用"发文件"方式上传，并让 Telegram 不要转换格式
async function uploadRaw(env, file, ext) {
  const fd = new FormData();
  fd.append("chat_id", env.TG_Chat_ID);
  fd.append("document", file, file.name || `image.${ext}`);
  fd.append("disable_content_type_detection", "true");

  const res = await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/sendDocument`, {
    method: "POST",
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  const fileId = data?.result?.document?.file_id;

  if (!res.ok || !fileId) {
    return Response.json({ error: data?.description || "Upload failed" }, { status: 500 });
  }
  return Response.json([{ src: `/file/${fileId}.${ext}` }]);
}
