import { useState, useRef, useCallback, useEffect } from "react";

const POLL_INTERVAL = 8000;

const font = `'DM Sans', sans-serif`;
const mono = `'JetBrains Mono', 'Fira Code', monospace`;

const c = {
  bg: "#0c0c0f", surface: "#16161a",
  border: "#2a2a32", text: "#e8e8ed",
  muted: "#8888a0", hint: "#55556a",
  accent: "#6c5ce7", success: "#00b894",
  warn: "#fdcb6e", error: "#e17055", tag: "#2d2d3a",
};

function fileToPreview(file) {
  return new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result);
    fr.readAsDataURL(file);
  });
}

function StatusBadge({ status }) {
  const m = {
    pending: { color: c.muted, label: "Pending" },
    uploading: { color: c.warn, label: "Uploading" },
    processing: { color: c.accent, label: "Processing" },
    completed: { color: c.success, label: "Done" },
    failed: { color: c.error, label: "Failed" },
  };
  const s = m[status] || m.pending;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 10, fontFamily: mono, textTransform: "uppercase",
      letterSpacing: "0.07em", color: s.color,
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: "50%", background: s.color,
        boxShadow: status === "processing" ? `0 0 6px ${s.color}` : "none",
        animation: status === "processing" || status === "uploading" ? "pulse 1.5s infinite" : "none",
      }} />
      {s.label}
    </span>
  );
}

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [refVideo, setRefVideo] = useState(null);
  const [refVideoName, setRefVideoName] = useState("");
  const [images, setImages] = useState([]);
  const [mode, setMode] = useState("std");
  const [orientation, setOrientation] = useState("video");
  const [keepSound, setKeepSound] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [running, setRunning] = useState(false);
  const [batchDone, setBatchDone] = useState(false);
  const imgRef = useRef();
  const replaceImgRefs = useRef({});
  const jobsRef = useRef([]);
  const pollRef = useRef(null);
  const refVideoUrlRef = useRef("");

  const rate = mode === "std" ? 0.065 : 0.104;
  const perVideo = rate * 10;
  const batchEst = perVideo * images.length;

  const handleImages = useCallback(async (e) => {
    const files = Array.from(e.target.files);
    const items = await Promise.all(
      files.map(async (f) => ({ name: f.name, file: f, preview: await fileToPreview(f) }))
    );
    setImages((p) => [...p, ...items]);
    e.target.value = "";
  }, []);

  const removeImage = (i) => setImages((p) => p.filter((_, idx) => idx !== i));

  // Upload file directly from browser to tmpfiles.org to avoid CORS and size limits
  async function uploadFile(file) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      body: fd,
    });
    const d = await r.json();
    if (d?.data?.url) {
      return d.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    }
    throw new Error("File upload failed");
  }

  // Proxy for PiAPI calls (avoids CORS)
  async function proxy(body) {
    const r = await fetch("/api/piapi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, ...body }),
    });
    return await r.json();
  }

  async function submitJob(imageUrl, videoUrl) {
    const d = await proxy({
      action: "create",
      taskBody: {
        model: "kling",
        task_type: "motion_control",
        input: {
          image_url: imageUrl,
          video_url: videoUrl,
          motion_direction: orientation,
          keep_original_sound: keepSound,
          mode,
          version: "2.6",
        },
      },
    });
    if (d?.data?.task_id) return d.data.task_id;
    throw new Error(d?.message || d?.error?.message || "Submit failed");
  }

  async function checkJob(taskId) {
    const d = await proxy({ action: "poll", taskId });
    return d?.data;
  }

  function updateJob(id, patch) {
    jobsRef.current = jobsRef.current.map((j) =>
      j.id === id ? { ...j, ...patch } : j
    );
    setJobs([...jobsRef.current]);
  }

  // Submit a single job (used by start, retry, and replace-then-retry)
  async function submitSingleJob(job, videoUrl) {
    try {
      updateJob(job.id, { status: "uploading", error: null });
      const imageUrl = job.imageUrl || await uploadFile(job.file);
      if (!job.imageUrl) updateJob(job.id, { imageUrl });
      const taskId = await submitJob(imageUrl, videoUrl);
      updateJob(job.id, { status: "processing", taskId, error: null, videoUrl: null });
      return true;
    } catch (err) {
      updateJob(job.id, { status: "failed", error: err.message });
      return false;
    }
  }

  async function startBatch() {
    if (!apiKey || !refVideoUrlRef.current || images.length === 0) return;
    setRunning(true);
    setBatchDone(false);

    const initial = images.map((img, i) => ({
      id: i, imageName: img.name, file: img.file, preview: img.preview,
      status: "uploading", taskId: null, videoUrl: null, imageUrl: null,
      error: null,
    }));
    jobsRef.current = initial;
    setJobs([...initial]);

    const videoUrl = refVideoUrlRef.current;

    await Promise.all(initial.map((job) => submitSingleJob(job, videoUrl)));
    startPolling();
  }

  // Retry a single job with same image
  async function retryJob(jobId) {
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!job) return;
    const videoUrl = refVideoUrlRef.current;
    if (!batchDone) {
      // If batch polling is still active, just resubmit
      await submitSingleJob(job, videoUrl);
    } else {
      // If batch ended, restart polling for this retry
      setBatchDone(false);
      setRunning(true);
      await submitSingleJob(job, videoUrl);
      startPolling();
    }
  }

  // Replace image on a failed job and retry
  async function replaceAndRetry(jobId, newFile) {
    const preview = await fileToPreview(newFile);
    updateJob(jobId, {
      file: newFile,
      imageName: newFile.name,
      preview,
      imageUrl: null, // Force re-upload
      status: "uploading",
      error: null,
    });
    const videoUrl = refVideoUrlRef.current;
    const job = jobsRef.current.find((j) => j.id === jobId);
    if (!batchDone) {
      await submitSingleJob(job, videoUrl);
    } else {
      setBatchDone(false);
      setRunning(true);
      await submitSingleJob(job, videoUrl);
      startPolling();
    }
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const processing = jobsRef.current.filter((j) => j.status === "processing");
      if (processing.length === 0) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setRunning(false);
        setBatchDone(true);
        return;
      }
      for (const job of processing) {
        try {
          const data = await checkJob(job.taskId);
          if (data?.status === "completed") {
            const vUrl =
              data?.output?.works?.[0]?.video?.resource_without_watermark ||
              data?.output?.works?.[0]?.video?.resource || "";
            updateJob(job.id, { status: "completed", videoUrl: vUrl });
          } else if (data?.status === "failed") {
            const errMsg = data?.error?.raw_message || data?.error?.message || "Generation failed";
            updateJob(job.id, { status: "failed", error: errMsg });
          }
        } catch (_) {}
      }
    }, POLL_INTERVAL);
  }

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function resetBatch() {
    setJobs([]);
    setBatchDone(false);
    setImages([]);
    setRefVideoName("");
    refVideoUrlRef.current = "";
  }

  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const processingCount = jobs.filter(
    (j) => j.status === "processing" || j.status === "uploading"
  ).length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const spent = completedCount * perVideo;

  return (
    <div style={{ minHeight: "100vh", background: c.bg, color: c.text, fontFamily: font }}>
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        input[type="file"] { display:none }
        ::-webkit-scrollbar { width:5px }
        ::-webkit-scrollbar-track { background:${c.bg} }
        ::-webkit-scrollbar-thumb { background:${c.border};border-radius:3px }
        button { font-family:${font} }
      `}</style>

      {/* Header */}
      <div style={{
        padding: "16px 24px", borderBottom: `1px solid ${c.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 7, background: c.accent,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 15, fontWeight: 700, color: "#fff",
          }}>K</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Kling Batch Motion Control</div>
            <div style={{ fontSize: 10, color: c.hint, fontFamily: mono }}>v2.6 · PiAPI · keep audio</div>
          </div>
        </div>
        {!connected ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="password" placeholder="PiAPI API Key"
              value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apiKey && setConnected(true)}
              style={{
                background: c.surface, border: `1px solid ${c.border}`, borderRadius: 5,
                padding: "5px 10px", color: c.text, fontFamily: mono, fontSize: 11,
                width: 240, outline: "none",
              }}
            />
            <button
              onClick={() => apiKey && setConnected(true)}
              style={{
                background: c.accent, border: "none", borderRadius: 5,
                padding: "5px 14px", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}
            >Connect</button>
          </div>
        ) : (
          <div style={{
            fontSize: 10, fontFamily: mono, color: c.success,
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: c.success }} />
            Connected
          </div>
        )}
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 63px)" }}>
        {/* Left Panel */}
        <div style={{
          width: 320, borderRight: `1px solid ${c.border}`, padding: 20,
          display: "flex", flexDirection: "column", gap: 16, overflowY: "auto",
        }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>
              Reference motion video
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                type="text"
                placeholder="Paste video URL"
                value={refVideoName}
                onChange={(e) => { setRefVideoName(e.target.value); refVideoUrlRef.current = e.target.value; }}
                disabled={running}
                style={{
                  background: c.surface, border: `1px solid ${refVideoName ? c.success : c.border}`, borderRadius: 5,
                  padding: "8px 10px", color: c.text, fontFamily: mono, fontSize: 11,
                  width: "100%", outline: "none",
                }}
              />
              <div style={{ fontSize: 9, color: c.hint, lineHeight: 1.4 }}>
                Upload your video to tmpfiles.org, streamable.com, or discord, then paste the direct URL here
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted, marginBottom: 6 }}>
              Character images ({images.length})
            </div>
            <div
              onClick={() => !running && imgRef.current?.click()}
              style={{
                border: `1px dashed ${c.border}`, borderRadius: 7, padding: 12,
                textAlign: "center", cursor: running ? "default" : "pointer",
                background: c.surface, marginBottom: 6,
              }}
            >
              <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={handleImages} />
              <div style={{ fontSize: 11, color: c.muted }}>Click to add images (multi-select)</div>
            </div>
            {images.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {images.map((img, i) => (
                  <div key={i} style={{ position: "relative", width: 44, height: 44 }}>
                    <img src={img.preview} alt="" style={{
                      width: 44, height: 44, objectFit: "cover", borderRadius: 5,
                      border: `1px solid ${c.border}`,
                    }} />
                    {!running && (
                      <button
                        onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                        style={{
                          position: "absolute", top: -3, right: -3, width: 14, height: 14,
                          borderRadius: "50%", background: c.error, border: "none",
                          color: "#fff", fontSize: 8, cursor: "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}
                      >×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: c.muted }}>Settings</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["std", "Standard", "0.065"], ["pro", "Pro", "0.104"]].map(([v, l, p]) => (
                <button key={v} onClick={() => !running && setMode(v)} style={{
                  flex: 1, padding: "7px 0", borderRadius: 5,
                  border: `1px solid ${mode === v ? c.accent : c.border}`,
                  background: mode === v ? c.accent + "15" : c.surface,
                  color: mode === v ? c.accent : c.muted,
                  fontSize: 11, fontWeight: 600, cursor: running ? "default" : "pointer",
                }}>
                  {l} <span style={{ fontFamily: mono, fontSize: 9, opacity: 0.7 }}>${p}/s</span>
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["video", "Match Video"], ["image", "Match Image"]].map(([v, l]) => (
                <button key={v} onClick={() => !running && setOrientation(v)} style={{
                  flex: 1, padding: "7px 0", borderRadius: 5,
                  border: `1px solid ${orientation === v ? c.accent : c.border}`,
                  background: orientation === v ? c.accent + "15" : c.surface,
                  color: orientation === v ? c.accent : c.muted,
                  fontSize: 11, fontWeight: 600, cursor: running ? "default" : "pointer",
                }}>
                  {l}
                </button>
              ))}
            </div>
            <div
              onClick={() => !running && setKeepSound(!keepSound)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                borderRadius: 5, background: c.surface, cursor: running ? "default" : "pointer",
                border: `1px solid ${c.border}`,
              }}
            >
              <div style={{
                width: 15, height: 15, borderRadius: 3,
                border: `2px solid ${keepSound ? c.accent : c.border}`,
                background: keepSound ? c.accent : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, color: "#fff",
              }}>
                {keepSound && "✓"}
              </div>
              <span style={{ fontSize: 11, color: c.text }}>Keep original audio</span>
            </div>
          </div>

          <div style={{
            background: c.surface, borderRadius: 7, padding: 12,
            border: `1px solid ${c.border}`,
          }}>
            <div style={{ fontSize: 10, color: c.muted, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Cost estimate
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: c.muted }}>Per video (10s)</span>
              <span style={{ fontSize: 11, fontFamily: mono }}>${perVideo.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: c.muted }}>This batch ({images.length})</span>
              <span style={{ fontSize: 13, fontFamily: mono, fontWeight: 700, color: c.accent }}>
                ${batchEst.toFixed(2)}
              </span>
            </div>
          </div>

          {jobs.length === 0 ? (
            <button
              onClick={startBatch}
              disabled={running || !connected || !refVideoName || images.length === 0}
              style={{
                width: "100%", padding: "12px 0", borderRadius: 7,
                background: running || !connected || !refVideoName || images.length === 0 ? c.tag : c.accent,
                border: "none", color: "#fff", fontSize: 13, fontWeight: 700,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              {running
                ? `Processing ${completedCount}/${jobs.length}...`
                : `Generate ${images.length} video${images.length !== 1 ? "s" : ""}`}
            </button>
          ) : (
            <button onClick={resetBatch} style={{
              width: "100%", padding: "12px 0", borderRadius: 7,
              background: c.surface, border: `1px solid ${c.border}`,
              color: c.text, fontSize: 13, fontWeight: 600, cursor: "pointer",
            }}>
              New batch
            </button>
          )}
        </div>

        {/* Right Panel */}
        <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
          {jobs.length === 0 ? (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              height: "100%", color: c.muted, fontSize: 12,
              flexDirection: "column", gap: 6,
            }}>
              <div style={{ fontSize: 28, opacity: 0.25 }}>⬡</div>
              <div>Paste a reference video URL and upload character images to start</div>
            </div>
          ) : (
            <>
              <div style={{
                display: "flex", gap: 14, marginBottom: 16, padding: "10px 14px",
                background: c.surface, borderRadius: 7, border: `1px solid ${c.border}`,
                alignItems: "center", flexWrap: "wrap",
              }}>
                {[
                  [c.success, "Done", completedCount],
                  [c.accent, "Running", processingCount],
                  [c.error, "Failed", failedCount],
                ].map(([col, label, count]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: col }} />
                    <span style={{ fontSize: 10, fontFamily: mono, color: col, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                    <span style={{ fontSize: 12, fontFamily: mono, fontWeight: 600 }}>{count}</span>
                  </div>
                ))}
                <div style={{ marginLeft: "auto", fontSize: 11, fontFamily: mono, color: c.accent }}>
                  Spent: ${spent.toFixed(2)}
                </div>
              </div>

              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 12,
              }}>
                {jobs.map((job, idx) => (
                  <div key={job.id} style={{
                    background: c.surface, borderRadius: 9,
                    border: `1px solid ${job.status === "failed" ? c.error + "40" : c.border}`,
                    overflow: "hidden",
                    animation: "fadeIn 0.3s ease",
                    animationDelay: `${idx * 40}ms`, animationFillMode: "both",
                  }}>
                    <div style={{ position: "relative", aspectRatio: "16/9", background: c.bg }}>
                      {job.videoUrl ? (
                        <video src={job.videoUrl} controls style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <img src={job.preview} alt="" style={{
                          width: "100%", height: "100%", objectFit: "cover",
                          opacity: (job.status === "processing" || job.status === "uploading") ? 0.4 : 0.7,
                        }} />
                      )}
                      {(job.status === "processing" || job.status === "uploading") && (
                        <div style={{
                          position: "absolute", inset: 0,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: "rgba(0,0,0,0.35)",
                        }}>
                          <div style={{
                            width: 24, height: 24,
                            border: `2px solid ${c.accent}`,
                            borderTopColor: "transparent",
                            borderRadius: "50%",
                            animation: "spin 0.8s linear infinite",
                          }} />
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "10px 12px" }}>
                      <div style={{
                        display: "flex", justifyContent: "space-between",
                        alignItems: "center", marginBottom: 4,
                      }}>
                        <span style={{
                          fontSize: 10, fontFamily: mono, color: c.text,
                          overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap", maxWidth: 130,
                        }}>{job.imageName}</span>
                        <StatusBadge status={job.status} />
                      </div>

                      {/* Failure UI with retry + replace buttons */}
                      {job.status === "failed" && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{
                            fontSize: 10, color: c.error, lineHeight: 1.4,
                            padding: "6px 8px", background: c.error + "12",
                            borderRadius: 4, border: `1px solid ${c.error}30`,
                            marginBottom: 8,
                          }}>
                            {job.error?.toLowerCase().includes("content violation") || job.error?.toLowerCase().includes("nsfw")
                              ? "⚠ Blocked by Kling content filter (likely NSFW). Try a different image."
                              : job.error || "Unknown error"}
                          </div>
                          <div style={{ display: "flex", gap: 5 }}>
                            <button
                              onClick={() => retryJob(job.id)}
                              style={{
                                flex: 1, padding: "7px 0", borderRadius: 5,
                                background: c.accent, border: "none", color: "#fff",
                                fontSize: 10, fontWeight: 600, cursor: "pointer",
                              }}
                            >
                              Retry
                            </button>
                            <button
                              onClick={() => replaceImgRefs.current[job.id]?.click()}
                              style={{
                                flex: 1, padding: "7px 0", borderRadius: 5,
                                background: c.surface, border: `1px solid ${c.border}`,
                                color: c.text, fontSize: 10, fontWeight: 600, cursor: "pointer",
                              }}
                            >
                              Replace image
                            </button>
                            <input
                              ref={(el) => { replaceImgRefs.current[job.id] = el; }}
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              onChange={(e) => {
                                const f = e.target.files[0];
                                if (f) replaceAndRetry(job.id, f);
                                e.target.value = "";
                              }}
                            />
                          </div>
                        </div>
                      )}

                      {job.videoUrl && (
                        <a
                          href={job.videoUrl}
                          download={job.imageName.replace(/\.\w+$/, "") + ".mp4"}
                          target="_blank" rel="noreferrer"
                          style={{
                            display: "block", marginTop: 8, textAlign: "center",
                            padding: "7px 0", borderRadius: 5,
                            background: c.accent + "18", color: c.accent,
                            fontSize: 11, fontWeight: 600, textDecoration: "none",
                            border: `1px solid ${c.accent}30`,
                          }}
                        >
                          Download MP4
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
