import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

interface WatermarkData {
  text: string;
  x: number;
  y: number;
  opacity: number;
  rotation: number;
}

/**
 * Semi-transparent watermark overlay rendered on top of the video.
 *
 * Listens to "watermark-update" events from the Rust backend and smoothly
 * transitions to new positions every 5-10 seconds.
 *
 * The watermark contains the user's email + timestamp, making it possible
 * to trace any camera recording leak back to a specific user.
 *
 * CSS properties:
 * - pointer-events: none — click-through, doesn't block video interaction
 * - user-select: none — can't be selected or copied
 * - transition — smooth position changes
 */
export default function WatermarkOverlay() {
  const [watermark, setWatermark] = useState<WatermarkData | null>(null);

  useEffect(() => {
    const unlisten = listen<WatermarkData>("watermark-update", (event) => {
      setWatermark(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (!watermark) return null;

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ pointerEvents: "none", userSelect: "none" }}
    >
      <span
        style={{
          position: "absolute",
          left: `${watermark.x * 100}%`,
          top: `${watermark.y * 100}%`,
          opacity: watermark.opacity,
          transform: `rotate(${watermark.rotation}deg)`,
          transition: "all 2s ease-in-out",
          color: "rgba(200, 200, 200, 0.6)",
          fontSize: "13px",
          fontFamily: "monospace",
          whiteSpace: "nowrap",
          textShadow: "0 0 4px rgba(0,0,0,0.5)",
          pointerEvents: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {watermark.text}
      </span>
    </div>
  );
}
