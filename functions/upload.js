import { errorHandling, telemetryData } from "./utils/middleware";

const INTERNAL_HEADER = "X-MN-Upload-Token";

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ===== 方案1：/upload 内部密钥校验（只允许你的聚合 Worker 调用）=====
  const expected = (env && env.MN_INTERNAL_UPLOAD_TOKEN ? String(env.MN_INTERNAL_UPLOAD_TOKEN) : "").trim();
  if (!expected) {
    // 忘配 env 时直接报 500，避免“以为开了保护但其实没生效”
    return json(500, { error: "Server missing MN_INTERNAL_UPLOAD_TOKEN" });
  }

  const got = (request.headers.get(INTERNAL_HEADER) || "").trim();
  if (!timingSafeEqual(got, expected)) {
    return json(403, { error: "Forbidden" });
  }
  // ====================================================================

  try {
    const clonedRequest = request.clone();
    const formData = await clonedRequest.formData();

    await errorHandling(context);
    telemetryData(context);

    const uploadFile = formData.get("file");
    if (!uploadFile) {
      throw new Error("No file uploaded");
    }

    const fileName = uploadFile.name;
    const fileExtension = fileName.split(".").pop().toLowerCase();

    const telegramFormData = new FormData();
    telegramFormData.append("chat_id", env.TG_Chat_ID);

    // 根据文件类型选择合适的上传方式
    let apiEndpoint;
    if (uploadFile.type.startsWith("image/")) {
      telegramFormData.append("photo", uploadFile);
      apiEndpoint = "sendPhoto";
    } else if (uploadFile.type.startsWith("audio/")) {
      telegramFormData.append("audio", uploadFile);
      apiEndpoint = "sendAudio";
    } else if (uploadFile.type.startsWith("video/")) {
      telegramFormData.append("video", uploadFile);
      apiEndpoint = "sendVideo";
    } else {
      telegramFormData.append("document", uploadFile);
      apiEndpoint = "sendDocument";
    }

    const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

    if (!result.success) {
      throw new Error(result.error);
    }

    const fileId = getFileId(result.data);

    if (!fileId) {
      throw new Error("Failed to get file ID");
    }

    // 将文件信息保存到 KV 存储
    if (env.img_url) {
      await env.img_url.put(`${fileId}.${fileExtension}`, "", {
        metadata: {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName: fileName,
          fileSize: uploadFile.size,
        },
      });
    }

    return new Response(JSON.stringify([{ src: `/file/${fileId}.${fileExtension}` }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Upload error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function getFileId(response) {
  if (!response.ok || !response.result) return null;

  const result = response.result;
  if (result.photo) {
    return result.photo.reduce((prev, current) => (prev.file_size > current.file_size ? prev : current)).file_id;
  }
  if (result.document) return result.document.file_id;
  if (result.video) return result.video.file_id;
  if (result.audio) return result.audio.file_id;

  return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
  const MAX_RETRIES = 2;
  const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

  try {
    const response = await fetch(apiUrl, { method: "POST", body: formData });
    const responseData = await response.json();

    if (response.ok) {
      return { success: true, data: responseData };
    }

    // 图片上传失败时转为文档方式重试
    if (retryCount < MAX_RETRIES && apiEndpoint === "sendPhoto") {
      console.log("Retrying image as document...");
      const newFormData = new FormData();
      newFormData.append("chat_id", formData.get("chat_id"));
      newFormData.append("document", formData.get("photo"));
      return await sendToTelegram(newFormData, "sendDocument", env, retryCount + 1);
    }

    return {
      success: false,
      error: responseData.description || "Upload to Telegram failed",
    };
  } catch (error) {
    console.error("Network error:", error);
    if (retryCount < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (retryCount + 1)));
      return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
    }
    return { success: false, error: "Network error occurred" };
  }
}
