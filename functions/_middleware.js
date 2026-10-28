// 只检查 POST /upload 的上传密码，其他请求直接放行
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
    const expected = String(env.MN_INTERNAL_UPLOAD_TOKEN || "").trim();
    if (!expected) {
      return Response.json({ error: "Server missing MN_INTERNAL_UPLOAD_TOKEN" }, { status: 500 });
    }
    const got = (request.headers.get(HEADER) || "").trim();
    if (!safeEqual(got, expected)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  return context.next();
}
