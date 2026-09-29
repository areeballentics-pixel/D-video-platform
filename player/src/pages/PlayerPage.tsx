import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { startPlayback, stopPlayback, reportWatchHeartbeat } from "../lib/tauri";
import { listen } from "@tauri-apps/api/event";
import type { PlaybackInfo } from "../lib/types";
import WatermarkOverlay from "../components/WatermarkOverlay";
import SecurityWarning from "../components/SecurityWarning";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PlayerPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const videoPath = searchParams.get("path") || "";

  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Video state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);

  // Start playback on mount
  useEffect(() => {
    if (!videoPath) {
      setError("No video path provided");
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function init() {
      try {
        const info = await startPlayback(videoPath);
        if (!cancelled) {
          setPlaybackInfo(info);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    init();

    // Stop playback on unmount
    return () => {
      cancelled = true;
      stopPlayback().catch(console.error);
    };
  }, [videoPath]);

  // Update time display
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => setDuration(video.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [playbackInfo]);

  // SP-012: report watch heartbeats so analytics (views / watch time) update.
  // The Rust command existed but nothing in the frontend ever called it.
  useEffect(() => {
    const videoId = playbackInfo?.video_id;
    if (!videoId) return;
    let lastPosMs = 0;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.paused) return;
      const posMs = Math.floor(video.currentTime * 1000);
      const deltaMs = Math.max(0, Math.min(posMs - lastPosMs, 30000));
      lastPosMs = posMs;
      reportWatchHeartbeat(videoId, posMs, deltaMs).catch(() => {});
    }, 20000);
    return () => window.clearInterval(id);
  }, [playbackInfo]);

  // SP-009 / SP-014: the backend re-validates access during playback and emits
  // "access-revoked" if the enrollment was revoked or the video deleted.
  useEffect(() => {
    const un = listen<string>("access-revoked", (event) => {
      const video = videoRef.current;
      if (video) video.pause();
      stopPlayback().catch(() => {});
      setError(event.payload || "Your access to this video has been revoked.");
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  function handlePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Number(e.target.value);
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;
    if (!video) return;
    const v = Number(e.target.value);
    video.volume = v;
    setVolume(v);
  }

  const handleSecurityPause = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
    }
  }, []);

  
  function handleRewind() {
    const video = videoRef.current;
    if (video) video.currentTime = Math.max(0, video.currentTime - 10);
  }

  function handleForward() {
    const video = videoRef.current;
    if (video) video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
  }

  function handleSpeedChange() {
    const video = videoRef.current;
    if (!video) return;
    const newSpeed = speed === 1 ? 1.25 : speed === 1.25 ? 1.5 : speed === 1.5 ? 2 : 1;
    video.playbackRate = newSpeed;
    setSpeed(newSpeed);
  }

  function handleFullscreen() {
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      video.requestFullscreen();
    }
  }

  function handleBack() {
    stopPlayback().catch(console.error);
    navigate("/library");
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-black">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent mx-auto" />
          <p className="text-sm text-[var(--color-text-muted)]">
            Preparing video...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-black">
        <p className="mb-4 text-[var(--color-error)]">{error}</p>
        <button
          onClick={handleBack}
          className="rounded-lg bg-[var(--color-surface)] px-4 py-2 text-sm text-[var(--color-text)]"
        >
          Back to Library
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-black">
      {/* Top Bar */}
      <div className="flex items-center gap-4 bg-[var(--color-surface)]/80 px-4 py-2 backdrop-blur flex-shrink-0">
        <button
          onClick={handleBack}
          className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          &larr; Back
        </button>
        <span className="text-sm font-medium truncate">
          {playbackInfo?.title}
        </span>
        {playbackInfo && (
          <span className="ml-auto rounded bg-[var(--color-primary)]/20 px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
            {playbackInfo.quality}
          </span>
        )}
      </div>

      {/* Video Area */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden items-center justify-center">
        {playbackInfo && (
          <video
            ref={videoRef}
            src={playbackInfo.url}
            className="h-full w-full object-contain"
            autoPlay
            onClick={handlePlayPause}
            onError={() =>
              setError(
                "This video could not be played. The file may be corrupted or not a supported video.",
              )
            }
          />
        )}

        {/* Watermark overlay — semi-transparent, repositions every 5-10s */}
        <WatermarkOverlay />

        {/* Security warning — appears when screen recorder/RDP/VM detected */}
        <SecurityWarning onPause={handleSecurityPause} />
      </div>

      {/* Controls */}
      <div className="bg-[var(--color-surface)]/80 px-6 py-3 backdrop-blur flex-shrink-0 z-10">
        {/* Seek bar */}
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          className="mb-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--color-border)] accent-[var(--color-primary)]"
        />

        <div className="flex items-center gap-4">
          {/* Play/Pause */}
          <button
            onClick={handlePlayPause}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          
          <button onClick={handleRewind} className="text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            -10s
          </button>
          
          <button onClick={handleForward} className="text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
            +10s
          </button>

          <button onClick={handleSpeedChange} className="text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors w-10">
            {speed}x
          </button>

          {/* Time */}
          <span className="text-xs font-mono text-[var(--color-text-muted)] min-w-[80px]">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Volume */}
          <div className="flex items-center gap-2">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-[var(--color-text-muted)]"
            >
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              {volume > 0 && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
              {volume > 0.5 && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
            </svg>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={handleVolumeChange}
              className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-[var(--color-border)] accent-[var(--color-primary)]"
            />
          </div>

          {/* Fullscreen */}
          <button
            onClick={handleFullscreen}
            className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
