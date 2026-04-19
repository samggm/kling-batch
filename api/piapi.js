export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, apiKey, ...payload } = req.body;

  try {
    if (action === "upload") {
      const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
      const fileData = Buffer.from(payload.file_data, "base64");
      const fileName = payload.file_name || "image.jpg";
      const parts = [
        "--" + boundary + "\r\n" +
        'Content-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n',
        "--" + boundary + "\r\n" +
        'Content-Disposition: form-data; name="fileToUpload"; filename="' + fileName + '"\r\n' +
        "Content-Type: image/jpeg\r\n\r\n",
      ];
      const head = Buffer.from(parts[0] + parts[1], "utf-8");
      const tail = Buffer.from("\r\n--" + boundary + "--\r\n", "utf-8");
      const body = Buffer.concat([head, fileData, tail]);
      const r = await fetch("https://catbox.moe/user/api.php", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
        body: body,
      });
      const url = await r.text();
      if (url && url.startsWith("https://")) {
        return res.status(200).json({ data: { url: url.trim() } });
      }
      return res.status(500).json({ error: "Upload failed: " + url });
    } else if (action === "create") {
      if (!apiKey) return res.status(400).json({ error: "Missing API key" });
      const r = await fetch("https://api.piapi.ai/api/v1/task", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(payload.taskBody),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else if (action === "poll") {
      if (!apiKey) return res.status(400).json({ error: "Missing API key" });
      const r = await fetch("https://api.piapi.ai/api/v1/task/" + payload.taskId, {
        method: "GET",
        headers: { "x-api-key": apiKey },
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
