"use client";

import { useEffect, useRef } from "react";

/**
 * The 2-minute launch film. Plays muted while it is on screen (so nothing blasts out at a visitor) and pauses when it
 * scrolls away; the controls are always there to unmute, scrub or go fullscreen. It never autoplays for visitors who
 * ask for reduced motion, and the file only loads its metadata until it is played. It is served from R2 by
 * `/api/media/:name`, which answers byte ranges so the player can scrub (Workers Static Assets doesn't).
 */
export function LaunchFilm() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let userTookOver = false;
    const takeOver = () => {
      userTookOver = true;
    };
    // A click, key press or seek by the visitor means they're driving; stop the scroll-based play and pause.
    video.addEventListener("pointerdown", takeOver);
    video.addEventListener("keydown", takeOver);
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry || userTookOver) return;
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.6 },
    );
    io.observe(video);
    return () => {
      io.disconnect();
      video.removeEventListener("pointerdown", takeOver);
      video.removeEventListener("keydown", takeOver);
    };
  }, []);

  return (
    <video
      ref={ref}
      className="film-video"
      controls
      muted
      loop
      playsInline
      preload="metadata"
      poster="/api/media/shortstop-launch-poster.jpg"
      aria-label="ShortStop in two minutes: a notice in, a fair split, one commit wins, a record of every change"
    >
      <source src="/api/media/shortstop-launch.mp4" type="video/mp4" />
    </video>
  );
}
